// End-to-end hardening selftest. Requires the updated sibling sandbox-probe.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSandboxArgs } from "../src/main/services/sandbox-command-builder.ts";
import { buildSandboxEnv } from "../src/main/helpers/sandbox-env.ts";
import { buildSeccompFilter } from "../src/main/services/sandbox-seccomp.ts";
import {
  DNS_FORWARD_ADDRESS,
  resolvePastaPath,
  resolveHostResolver,
  resolveSandboxResolvConfDest,
} from "../src/main/services/sandbox-network.ts";

const runProbe = (command, args, env, fd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe", fd ?? "ignore"],
      timeout: 30000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr })
    );
  });

const main = async () => {
  const probe =
    process.env.SANDBOX_PROBE_BIN ||
    fileURLToPath(
      new URL(
        "../../hydra-sandbox-probe/target/release/sandbox-probe",
        import.meta.url
      )
    );
  if (!fs.existsSync(probe))
    throw new Error(
      "Build ../hydra-sandbox-probe with cargo build --release --locked first"
    );
  const pastaPath = resolvePastaPath();
  if (!pastaPath)
    throw new Error(
      "A trusted pasta binary is required for the default profile selftest"
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-sbx-selftest-"));
  const server = net.createServer((socket) => socket.end("hydra-selftest\n"));
  let fd;
  try {
    const home = path.join(root, "host-home");
    const gameDir = path.join(root, "game");
    const winePrefix = path.join(root, "prefix");
    const homePersistDir = path.join(root, "sandbox-home");
    const runtime = path.join(home, ".local/share/umu");
    for (const dir of [gameDir, winePrefix, homePersistDir, runtime])
      fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(homePersistDir, "existing-save"),
      "persistent state\n"
    );
    const sentinel = path.join(home, "host-sentinel");
    const runtimeCanary = path.join(runtime, "canary");
    fs.writeFileSync(sentinel, "synthetic secret\n");
    fs.writeFileSync(runtimeCanary, "synthetic runtime\n");
    const probeInGame = path.join(gameDir, "sandbox-probe");
    fs.copyFileSync(probe, probeInGame);
    fs.chmodSync(probeInGame, 0o755);
    const filter = path.join(root, "seccomp.bpf");
    fs.writeFileSync(filter, buildSeccompFilter("medium", "enforce"));
    fd = fs.openSync(filter, "r");
    const machineIdFile = path.join(root, "machine-id");
    fs.writeFileSync(machineIdFile, "0123456789abcdef0123456789abcdef\n");
    const resolver = resolveHostResolver();
    const resolvConfSource = path.join(root, "resolv.conf");
    fs.writeFileSync(
      resolvConfSource,
      `nameserver ${DNS_FORWARD_ADDRESS}\noptions edns0\n`
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const env = {
      ...buildSandboxEnv({
        ...process.env,
        HOME: home,
        HYDRA_AUDIT_SECRET: "never inherit",
      }),
      NO_COLOR: "1",
      PROBE_HOST_PID: String(process.pid),
      PROBE_GAME_DIR: gameDir,
      PROBE_WINE_PREFIX: winePrefix,
      PROBE_EXPECT_NETWORK: "1",
      PROBE_HOST_SENTINEL: sentinel,
      PROBE_EXPECT_HARDENING: "1",
      PROBE_HOST_NETNS: fs.readlinkSync("/proc/self/ns/net"),
      PROBE_HOST_LOOPBACK_ADDR: `127.0.0.1:${server.address().port}`,
      PROBE_FORBIDDEN_ENV: "HYDRA_AUDIT_SECRET",
      PROBE_READONLY_CANARY: runtimeCanary,
      PROBE_SECCOMP_LEVEL: "medium",
    };
    const profile = {
      command: probeInGame,
      args: ["--json"],
      env,
      gameDir,
      winePrefix,
      homePersistDir,
      machineIdFile,
      seccompFd: 3,
      hideX11: true,
      networkIsolation: {
        pastaPath,
        ...(resolver
          ? {
              dnsForwardAddress: DNS_FORWARD_ADDRESS,
              hostResolver: resolver,
              resolvConfSource,
              resolvConfDest: resolveSandboxResolvConfDest(),
            }
          : {}),
      },
    };
    const { command, args } = buildSandboxArgs(profile);
    const result = await runProbe(command, args, env, fd);
    if (result.stderr) console.error(result.stderr.trim());
    if (result.signal) throw new Error(`probe terminated: ${result.signal}`);
    const results = JSON.parse(result.stdout);
    const required = [
      "home-isolation",
      "write-confinement",
      "proc-isolation",
      "signal-isolation",
      "ptrace-isolation",
      "devshm-ipc",
      "network-open",
      "binds-writable",
      "capabilities",
      "network-isolation",
      "environment-scrub",
      "shared-runtime",
      "seccomp-enforcement",
    ];
    for (const name of required) {
      if (
        results.filter((r) => r.check === name && r.status === "PASS")
          .length !== 1
      )
        throw new Error(
          `required check did not pass: ${name}; ${JSON.stringify(results)}`
        );
    }
    for (const r of results) {
      console.log(`[${r.status}] ${r.check}: ${r.detail}`);
      if (r.status === "FAIL") throw new Error(`${r.check} failed`);
      if (r.requires_host_verification) {
        if (r.check !== "devshm-ipc")
          throw new Error(`unsupported host verification: ${r.check}`);
        const marker = r.detail.match(
          /\/dev\/shm\/sandbox-probe-\d+-\d+\b/
        )?.[0];
        if (!marker || fs.existsSync(marker))
          throw new Error("private /dev/shm marker missing or visible on host");
      }
    }
    if (result.code !== 0) throw new Error(`probe exited ${result.code}`);
    console.log(
      `sandbox-selftest: ${results.filter((r) => r.status === "PASS").length} pass, no failures`
    );
    // Negative controls prove the new checks discriminate actual regressions.
    const negative = buildSandboxArgs({
      ...profile,
      seccompFd: undefined,
      networkIsolation: undefined,
      extraBinds: [runtime],
    });
    const broken = await runProbe(
      negative.command,
      negative.args,
      { ...env, HYDRA_AUDIT_SECRET: "synthetic-leak" },
      null
    );
    if (broken.signal || broken.code !== 1)
      throw new Error("negative control did not report a completed failure");
    const negativeResults = JSON.parse(broken.stdout);
    for (const name of [
      "network-isolation",
      "environment-scrub",
      "shared-runtime",
      "seccomp-enforcement",
    ]) {
      if (!negativeResults.some((r) => r.check === name && r.status === "FAIL"))
        throw new Error(`negative control missed ${name}`);
    }
    console.log(
      "sandbox-selftest: all four negative hardening controls detected"
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
};
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
