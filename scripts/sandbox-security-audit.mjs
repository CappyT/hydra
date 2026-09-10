// Manual security regression audit using the production profile and filter.
// Run: node --import ./scripts/register-ts-node.mjs scripts/sandbox-security-audit.mjs
// Exit 1 means a security invariant failed; exit 2 means an incomplete run.
// This intentionally reports existing weaknesses instead of blessing them.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSandboxArgs } from "../src/main/services/sandbox-command-builder.ts";
import { buildSandboxEnv } from "../src/main/helpers/sandbox-env.ts";
import { resolveSystemBinary } from "../src/main/helpers/resolve-system-binary.ts";
import {
  DNS_FORWARD_ADDRESS,
  resolveHostResolver,
  resolvePastaPath,
  resolveSandboxResolvConfDest,
} from "../src/main/services/sandbox-network.ts";
import {
  AUDIT_ARCH_X86_64,
  buildSeccompFilter,
  SECCOMP_RET_ALLOW,
} from "../src/main/services/sandbox-seccomp.ts";

// Interpret the actual filter without depending on host x32 kernel support.
const filterAction = (filter, nr) => {
  let accumulator = 0;
  for (let pc = 0, steps = 0; steps < 4096; steps++) {
    const offset = pc * 8;
    const op = filter.readUInt16LE(offset);
    const k = filter.readUInt32LE(offset + 4);
    if (op === 0x20) {
      if (k !== 0 && k !== 4) throw new Error("unexpected filter load");
      accumulator = k === 0 ? nr : AUDIT_ARCH_X86_64;
      pc++;
    } else if (op === 0x15) {
      pc += 1 + filter.readUInt8(offset + (accumulator === k ? 2 : 3));
    } else if (op === 0x35) {
      pc += 1 + filter.readUInt8(offset + (accumulator >= k ? 2 : 3));
    } else if (op === 0x05) {
      pc += 1 + k;
    } else if (op === 0x06) {
      return k;
    } else {
      throw new Error(`unexpected filter opcode ${op}`);
    }
  }
  throw new Error("filter did not terminate");
};

const run = (command, args, env, fd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: "/",
      stdio: ["ignore", "pipe", "pipe", fd],
      timeout: 15000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr })
    );
  });

const main = async () => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("this audit requires Linux x86_64");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-security-audit-"));
  const server = net.createServer((socket) =>
    socket.end("hydra-audit-loopback\n")
  );
  let fd;
  let failed = false;
  const check = (name, pass) => {
    console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
    failed ||= !pass;
  };

  try {
    const home = path.join(root, "host-home");
    const gameDir = path.join(root, "game");
    const homePersistDir = path.join(root, "sandbox-home");
    const runtime = path.join(home, ".local/share/umu");
    for (const dir of [gameDir, homePersistDir, runtime]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const sentinel = path.join(home, "host-only-sentinel");
    const runtimeCanary = path.join(runtime, "audit-canary");
    const readonlyCanary = path.join(root, "readonly-canary");
    fs.writeFileSync(sentinel, "synthetic host secret\n");
    fs.writeFileSync(runtimeCanary, "synthetic runtime file\n");
    fs.writeFileSync(readonlyCanary, "synthetic read-only tool\n");
    const payload = path.join(gameDir, "audit.py");
    fs.copyFileSync(
      fileURLToPath(new URL("./sandbox-security-audit.py", import.meta.url)),
      payload
    );
    const filter = buildSeccompFilter("medium", "enforce");
    const filterPath = path.join(root, "filter.bpf");
    fs.writeFileSync(filterPath, filter);
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
    const port = server.address().port;
    const hostNetns = fs.readlinkSync("/proc/self/ns/net");
    const env = buildSandboxEnv({
      HOME: home,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      AUDIT_FAKE_SECRET: "synthetic-secret",
    });

    for (const [name, pastaPath] of [
      ["control-host-network", null],
      ["pasta-default", "/usr/bin/pasta"],
      ["pasta-setup-failure", "/usr/bin/false"],
    ]) {
      const isolated = pastaPath !== null;
      const started = path.join(gameDir, `${name}.started`);
      const invocation = buildSandboxArgs({
        command: "/usr/bin/python3",
        args: [
          "-I",
          payload,
          String(port),
          sentinel,
          runtimeCanary,
          readonlyCanary,
          started,
        ],
        env,
        gameDir,
        homePersistDir,
        extraRoBinds: [readonlyCanary],
        seccompFd: 3,
        hideX11: true,
        ...(isolated
          ? {
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
            }
          : {}),
      });
      // Reopen the filter for every run: bwrap consumes its file offset.
      fd = fs.openSync(filterPath, "r");
      const result = await run(invocation.command, invocation.args, env, fd);
      fs.closeSync(fd);
      fd = undefined;
      console.log(`\n${name}: exit=${result.code}, signal=${result.signal}`);
      if (result.stderr.trim()) console.log(result.stderr.trim());
      if (result.signal)
        throw new Error(`${name}: payload timed out or was killed`);
      if (result.code !== 0) {
        if (name === "pasta-setup-failure" && !fs.existsSync(started)) {
          check("failed network setup refuses payload execution", true);
          continue;
        }
        throw new Error(`${name}: payload did not complete`);
      }
      const observed = JSON.parse(result.stdout);
      console.log(JSON.stringify(observed));
      check(`${name}: host home hidden`, !observed.sentinel_readable);
      check(`${name}: inherited secret scrubbed`, !observed.secret_present);
      check(`${name}: no new privileges`, observed.no_new_privs === "1");
      check(
        `${name}: nested user namespaces remain usable`,
        observed.nested_user_namespace
      );
      check(
        `${name}: seccomp bpf/keyctl denied`,
        Object.values(observed.seccomp_blocked).every(Boolean)
      );
      check(
        `${name}: no setup capabilities`,
        ["CapInh", "CapPrm", "CapEff", "CapAmb"].every((key) =>
          /^0+$/.test(observed.caps[key])
        )
      );
      check(
        `${name}: shared runtime cannot be modified`,
        !observed.runtime_writable
      );
      check(
        `${name}: read-only bind stays read-only`,
        !observed.readonly_writable
      );
      check(
        `${name}: expected network namespace`,
        (observed.netns !== hostNetns) === isolated
      );
      check(
        `${name}: expected loopback reachability`,
        observed.host_loopback_reachable === !isolated
      );
    }
    check(
      "x86_64 bpf denied by compiled filter",
      filterAction(filter, 321) !== SECCOMP_RET_ALLOW
    );
    check(
      "x32 bpf denied by compiled filter",
      filterAction(filter, 0x40000000 | 321) !== SECCOMP_RET_ALLOW
    );
    // Resolve synthetic tools without ever executing them. A game-controlled
    // PATH entry must not win over a distro-installed security helper.
    const fakeBin = path.join(root, "untrusted-bin");
    fs.mkdirSync(fakeBin);
    for (const name of ["pasta", "umu-run"]) {
      fs.writeFileSync(path.join(fakeBin, name), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    }
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
      check(
        "pasta resolver rejects untrusted PATH precedence",
        resolvePastaPath() !== path.join(fakeBin, "pasta")
      );
      check(
        "tool resolver rejects untrusted PATH precedence",
        resolveSystemBinary(["umu-run"]) !== path.join(fakeBin, "umu-run")
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
