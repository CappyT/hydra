// End-to-end hardening selftest. Requires the updated sibling sandbox-probe.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  buildEgressPolicy,
  parseHostAddresses,
  parseRouteSubnets,
} from "../src/main/services/sandbox-egress.ts";
import {
  ensureFilteredPulseSocket,
  stopFilteredPulse,
} from "../src/main/services/sandbox-audio.ts";
import { resolveSystemBinary } from "../src/main/helpers/resolve-system-binary.ts";

const listen = (server, ...target) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...target, resolve);
  });

const reachable = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1000 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/** A LAN service the host reaches, used to prove the LAN block. Null = none. */
const findLanTarget = async (ipPath) => {
  const routes = spawnSync(ipPath, ["-j", "route", "show", "default"], {
    encoding: "utf8",
  });
  const gateway = JSON.parse(routes.stdout || "[]").find(
    (route) => route.gateway
  )?.gateway;
  if (!gateway) return null;
  for (const port of [53, 80, 443]) {
    if (await reachable(gateway, port)) return { host: gateway, port };
  }
  return null;
};

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

const createSysvCanary = (fixturePath) => {
  const source = `
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
key = libc.ftok(__import__('sys').argv[1].encode(), ord('H'))
segment = libc.shmget(key, 1, 0o1000 | 0o600)
if key == -1 or segment == -1:
    raise OSError(ctypes.get_errno(), 'cannot create SysV IPC canary')
print(key, segment)
`;
  const result = spawnSync(
    "/usr/bin/python3",
    ["-I", "-c", source, fixturePath],
    {
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    throw new Error(`cannot create SysV IPC canary: ${result.stderr}`);
  }
  const [key, id] = result.stdout.trim().split(/\s+/);
  return { key, id: Number(id) };
};

const removeSysvCanary = (id) => {
  const source = `
import ctypes
libc = ctypes.CDLL(None)
libc.shmctl(${id}, 2, None)
`;
  spawnSync("/usr/bin/python3", ["-I", "-c", source]);
};

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
  const ipPath = resolveSystemBinary(["ip"]);
  const pipewirePulsePath = resolveSystemBinary(["pipewire-pulse"]);
  if (!ipPath || !pipewirePulsePath || !process.env.XDG_RUNTIME_DIR)
    throw new Error(
      "ip (iproute2), pipewire-pulse and a session runtime dir are required for the default profile selftest"
    );
  const nftPath = resolveSystemBinary(["nft"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-sbx-selftest-"));
  const server = net.createServer((socket) => socket.end("hydra-selftest\n"));
  // Listens on every address: reaches the game through any host address that
  // the egress policy forgets.
  const wildcard = net.createServer((socket) => socket.end("hydra-selftest\n"));
  const abstractName = `hydra-selftest-${process.pid}`;
  const abstractServer = net.createServer((socket) => socket.end());
  let fd;
  let sysv;
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
    sysv = createSysvCanary(sentinel);
    const writeCanaryId = randomUUID();
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
    await listen(server, 0, "127.0.0.1");
    await listen(wildcard, 0, "::");
    await listen(abstractServer, "\0" + abstractName);
    const wildcardPort = wildcard.address().port;
    const ipAddrJson = spawnSync(ipPath, ["-j", "addr", "show"], {
      encoding: "utf8",
    }).stdout;
    const hostAddresses = parseHostAddresses(ipAddrJson);
    const routedSubnets = ["-4", "-6"].flatMap((family) =>
      parseRouteSubnets(
        spawnSync(ipPath, ["-j", family, "route", "show"], {
          encoding: "utf8",
        }).stdout
      )
    );
    if (!hostAddresses || routedSubnets.includes(null))
      throw new Error("cannot read the host addresses and routes");
    const hostTargets = JSON.parse(ipAddrJson).flatMap((iface) =>
      (iface.addr_info ?? [])
        .filter((entry) => entry.local && entry.scope !== "host")
        .map((entry) =>
          entry.family === "inet6"
            ? `[${entry.local}${entry.scope === "link" ? `%${iface.ifname}` : ""}]:${wildcardPort}`
            : `${entry.local}:${wildcardPort}`
        )
    );
    const lanTarget = await findLanTarget(ipPath);
    const lanTargets = lanTarget ? [`${lanTarget.host}:${lanTarget.port}`] : [];
    const egress = (allowLocalNetwork, engine = nftPath ? "nft" : "ip") => ({
      ...buildEgressPolicy({
        hostAddresses,
        routedSubnets,
        allowLocalNetwork,
        dnsForwardAddress: resolver ? DNS_FORWARD_ADDRESS : undefined,
      }),
      ipPath,
      nftPath: engine === "nft" ? nftPath : undefined,
    });
    const pulseSocket = ensureFilteredPulseSocket({
      directory: path.join(root, "audio"),
      runtimeDir: process.env.XDG_RUNTIME_DIR,
      pipewirePulsePath,
      setprivPath: resolveSystemBinary(["setpriv"]),
      home: process.env.HOME,
    });
    const hostMachineId = fs.existsSync("/etc/machine-id")
      ? fs.readFileSync("/etc/machine-id", "utf8").trim()
      : "";
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
      PROBE_SYSV_IPC_KEY: sysv.key,
      PROBE_WRITE_CANARY_ID: writeCanaryId,
      PROBE_BLOCKED_TCP_TARGETS: [...hostTargets, ...lanTargets].join(","),
      PROBE_HOST_ABSTRACT_SOCKET: abstractName,
      PROBE_ALLOWED_RUNTIME_SOCKETS: [
        process.env.WAYLAND_DISPLAY,
        "gamescope-0",
        "pulse/native",
      ]
        .filter(Boolean)
        .join(","),
      ...(hostMachineId ? { PROBE_HOST_MACHINE_ID: hostMachineId } : {}),
      PROBE_ALLOWED_SOCKET_FAMILIES: "unix,inet,inet6,netlink",
      PROBE_ALLOWED_NETLINK_PROTOCOLS: "route,kobject_uevent",
      // Below "high" the filter cannot close i386 socketcall.
      PROBE_SOCKETCALL_OPEN: "1",
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
      audio: { pulseSocket },
      networkIsolation: {
        egress: egress(false),
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
      "sysv-ipc-isolation",
      "environment-scrub",
      "shared-runtime",
      "seccomp-enforcement",
      "egress-policy",
      "abstract-socket-isolation",
      "runtime-sockets",
      "sibling-processes",
      "inherited-fds",
      "socket-families",
      ...(hostMachineId ? ["machine-id"] : []),
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
        if (!["devshm-ipc", "binds-writable"].includes(r.check))
          throw new Error(`unsupported host verification: ${r.check}`);
        if (r.check === "binds-writable") continue;
        const marker = r.detail.match(
          /\/dev\/shm\/sandbox-probe-\d+-\d+\b/
        )?.[0];
        if (!marker || fs.existsSync(marker))
          throw new Error("private /dev/shm marker missing or visible on host");
      }
    }
    for (const [directory, target] of [
      [gameDir, "game"],
      [winePrefix, "wine"],
    ]) {
      const marker = path.join(
        directory,
        `.sandbox-probe-write-${writeCanaryId}-${target}`
      );
      if (fs.readFileSync(marker, "utf8") !== target) {
        throw new Error(`write canary missing or invalid on host: ${marker}`);
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
      shareIpc: true,
      extraBinds: [runtime],
      audio: { hostSockets: "all" },
    });
    const broken = await runProbe(
      negative.command,
      negative.args,
      {
        ...env,
        HYDRA_AUDIT_SECRET: "synthetic-leak",
        PROBE_WRITE_CANARY_ID: randomUUID(),
      },
      null
    );
    if (broken.signal || broken.code !== 1)
      throw new Error("negative control did not report a completed failure");
    const negativeResults = JSON.parse(broken.stdout);
    for (const name of [
      "network-isolation",
      "sysv-ipc-isolation",
      "environment-scrub",
      "shared-runtime",
      "seccomp-enforcement",
      "egress-policy",
      "abstract-socket-isolation",
      "runtime-sockets",
      "socket-families",
    ]) {
      if (!negativeResults.some((r) => r.check === name && r.status === "FAIL"))
        throw new Error(`negative control missed ${name}`);
    }
    const seccompFailure = negativeResults.find(
      (result) => result.check === "seccomp-enforcement"
    );
    for (const discriminator of ["i386 keyctl", "get_mempolicy"]) {
      if (!seccompFailure?.detail.includes(discriminator)) {
        throw new Error(`negative control missed ${discriminator}`);
      }
    }
    console.log(
      "sandbox-selftest: all nine negative hardening controls detected"
    );

    // One more probe run under a variation of the default profile.
    const probeWith = async (profileOverrides, envOverrides, filterPath) => {
      const invocation = buildSandboxArgs({ ...profile, ...profileOverrides });
      const probeFd = fs.openSync(filterPath ?? filter, "r");
      const outcome = await runProbe(
        invocation.command,
        profileOverrides.mapArgs?.(invocation.args) ?? invocation.args,
        { ...env, PROBE_WRITE_CANARY_ID: randomUUID(), ...envOverrides },
        probeFd
      );
      fs.closeSync(probeFd);
      if (outcome.signal)
        throw new Error(`probe terminated: ${outcome.signal}`);
      return JSON.parse(outcome.stdout);
    };
    const expectStatus = (results, label, expected) => {
      for (const [name, status] of Object.entries(expected)) {
        const found = results.find((result) => result.check === name);
        if (found?.status !== status)
          throw new Error(
            `${label}: ${name} is ${found?.status}, expected ${status}; ${found?.detail}`
          );
      }
    };

    if (nftPath) {
      expectStatus(
        await probeWith(
          {
            networkIsolation: {
              ...profile.networkIsolation,
              egress: egress(false, "ip"),
            },
          },
          {}
        ),
        "ip-rule engine",
        { "egress-policy": "PASS", "network-open": "PASS" }
      );
      console.log("sandbox-selftest: ip-rule egress engine verified");
    } else {
      console.log("sandbox-selftest: nft not installed, ip-rule engine only");
    }

    expectStatus(
      await probeWith(
        {
          networkIsolation: {
            ...profile.networkIsolation,
            egress: egress(true),
          },
        },
        { PROBE_BLOCKED_TCP_TARGETS: hostTargets.join(",") }
      ),
      "local network allowed",
      { "egress-policy": "PASS", "network-open": "PASS" }
    );

    const highFilter = path.join(root, "seccomp-high.bpf");
    fs.writeFileSync(highFilter, buildSeccompFilter("high", "enforce"));
    expectStatus(
      await probeWith(
        {},
        { PROBE_SECCOMP_LEVEL: "high", PROBE_SOCKETCALL_OPEN: "0" },
        highFilter
      ),
      "high seccomp",
      { "socket-families": "PASS", "seccomp-enforcement": "PASS" }
    );
    // Without the declaration the medium filter must show its known gap.
    expectStatus(
      await probeWith({}, { PROBE_SOCKETCALL_OPEN: "0" }),
      "medium seccomp, socketcall",
      { "socket-families": "FAIL" }
    );
    console.log("sandbox-selftest: socket family filter verified per level");

    expectStatus(
      await probeWith(
        { mapArgs: (args) => args.filter((arg) => arg !== "--as-pid-1") },
        {}
      ),
      "bwrap reaper control",
      { "sibling-processes": "FAIL" }
    );
    console.log("sandbox-selftest: exposed host-netns reaper detected");
    fd = fs.openSync(filter, "r");
    // The egress policy rejects the gateway address as a LAN address, so this
    // control needs the policy off to see the remap that --no-map-gw removes.
    const gatewayProfile = buildSandboxArgs({
      ...profile,
      networkIsolation: { ...profile.networkIsolation, egress: undefined },
    });
    gatewayProfile.args = gatewayProfile.args.map((argument) =>
      argument.replaceAll("--no-map-gw", "")
    );
    const gatewayResult = await runProbe(
      gatewayProfile.command,
      gatewayProfile.args,
      { ...env, PROBE_WRITE_CANARY_ID: randomUUID() },
      fd
    );
    fs.closeSync(fd);
    fd = undefined;
    const gatewayResults = JSON.parse(gatewayResult.stdout);
    const gatewayFailure = gatewayResults.find(
      (result) => result.check === "network-isolation"
    );
    if (
      gatewayResult.code !== 1 ||
      gatewayFailure?.status !== "FAIL" ||
      !gatewayFailure.detail.includes("through gateway")
    ) {
      throw new Error(
        `gateway negative control failed: ${JSON.stringify(gatewayResults)}`
      );
    }
    console.log("sandbox-selftest: gateway remapping detected");

    const runCommand = async (
      command,
      args,
      overrides = {},
      filterPath = filter
    ) => {
      const invocation = buildSandboxArgs({
        ...profile,
        ...overrides,
        command,
        args,
      });
      const payloadFd = fs.openSync(filterPath, "r");
      const outcome = await runProbe(
        invocation.command,
        invocation.args,
        env,
        payloadFd
      );
      fs.closeSync(payloadFd);
      return outcome;
    };
    const runPayload = async (name, overrides = {}, filterPath = filter) => {
      const started = path.join(gameDir, `${name}.started`);
      const outcome = await runCommand(
        "/usr/bin/touch",
        [started],
        overrides,
        filterPath
      );
      return { started, outcome };
    };

    if (lanTarget) {
      const connect = [
        "-c",
        `exec 3<>/dev/tcp/${lanTarget.host}/${lanTarget.port}`,
      ];
      const denied = await runCommand("/usr/bin/bash", connect);
      const allowed = await runCommand("/usr/bin/bash", connect, {
        networkIsolation: { ...profile.networkIsolation, egress: egress(true) },
      });
      if (denied.code === 0 || allowed.code !== 0)
        throw new Error(
          `local network permission: denied=${denied.code} allowed=${allowed.code}`
        );
      console.log("sandbox-selftest: local network permission verified");
    } else {
      console.log(
        "sandbox-selftest: no reachable LAN service, LAN test skipped"
      );
    }

    // The filtered endpoint plays but neither records nor loads modules; the
    // session sockets (microphone permission) do both.
    if (fs.existsSync("/usr/bin/pactl") && fs.existsSync("/usr/bin/parecord")) {
      const record = [
        "-c",
        "/usr/bin/parecord --raw /dev/null & sleep 1; kill $! 2>/dev/null; wait $!",
      ];
      const info = await runCommand("/usr/bin/pactl", ["info"]);
      const load = await runCommand("/usr/bin/pactl", [
        "load-module",
        "module-null-sink",
        "sink_name=hydra_selftest",
      ]);
      const capture = await runCommand("/usr/bin/bash", record);
      const captureWithPermission = await runCommand("/usr/bin/bash", record, {
        audio: { hostSockets: "pulse" },
      });
      if (
        info.code !== 0 ||
        load.code === 0 ||
        !capture.stderr.match(/denied|negato|access/i) ||
        captureWithPermission.stderr.match(/denied|negato/i)
      )
        throw new Error(
          `filtered audio: info=${info.code} load=${load.code} capture=${capture.stderr.trim()} permitted=${captureWithPermission.stderr.trim()}`
        );
      console.log("sandbox-selftest: filtered audio endpoint verified");
    } else {
      console.log(
        "sandbox-selftest: pactl/parecord missing, audio test skipped"
      );
    }

    const validPayload = await runPayload("valid-launch");
    if (
      validPayload.outcome.code !== 0 ||
      !fs.existsSync(validPayload.started)
    ) {
      throw new Error("valid payload control did not start");
    }

    const pastaFailure = await runPayload("pasta-failure", {
      networkIsolation: {
        ...profile.networkIsolation,
        pastaPath: "/usr/bin/false",
      },
    });
    if (
      pastaFailure.outcome.code !== 125 ||
      !pastaFailure.outcome.stderr.includes("[hydra-net]") ||
      fs.existsSync(pastaFailure.started)
    ) {
      throw new Error("invalid pasta executed the payload");
    }

    const truncatedFilter = path.join(root, "truncated.bpf");
    fs.writeFileSync(
      truncatedFilter,
      buildSeccompFilter("medium", "enforce").subarray(0, 7)
    );
    const seccompFailureLaunch = await runPayload(
      "seccomp-failure",
      {},
      truncatedFilter
    );
    if (
      seccompFailureLaunch.outcome.code === 0 ||
      !seccompFailureLaunch.outcome.stderr.toLowerCase().includes("seccomp") ||
      fs.existsSync(seccompFailureLaunch.started)
    ) {
      throw new Error("truncated seccomp filter executed the payload");
    }
    console.log("sandbox-selftest: fail-closed payload sentinels verified");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    stopFilteredPulse();
    for (const extra of [wildcard, abstractServer])
      if (extra.listening) await new Promise((resolve) => extra.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    if (sysv) removeSysvCanary(sysv.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
};
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
