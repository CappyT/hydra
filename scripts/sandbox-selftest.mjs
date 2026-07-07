// Sandbox selftest runner (Phase 1c).
//
// Runs the adversarial `sandbox-probe` binary INSIDE the exact bubblewrap
// profile the app builds for real games, so there is zero drift between what is
// tested here and what ships. The profile is produced by the real, unmodified
// `buildSandboxArgs` from src/main/services/sandbox-command-builder.ts — this
// script never reimplements it.
//
// Run via the repo's ts loader so it consumes the TS source directly:
//   node --import ./scripts/register-ts-node.mjs scripts/sandbox-selftest.mjs
// or simply `yarn sandbox:selftest`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildSandboxArgs } from "../src/main/services/sandbox-command-builder.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const log = (...parts) => console.log(...parts);

const locateProbe = () => {
  const fromEnv = process.env.SANDBOX_PROBE_BIN;
  const candidate =
    fromEnv && fromEnv.length > 0
      ? path.resolve(fromEnv)
      : path.resolve(
          repoRoot,
          "..",
          "hydra-sandbox-probe",
          "target",
          "release",
          "sandbox-probe"
        );

  if (!fs.existsSync(candidate)) {
    console.error(`sandbox-selftest: probe binary not found at ${candidate}`);
    console.error(
      "Build it first:\n" +
        "  cd ../hydra-sandbox-probe && cargo build --release\n" +
        "or point SANDBOX_PROBE_BIN at an existing sandbox-probe binary."
    );
    process.exit(2);
  }
  return candidate;
};

const extractDevShmMarker = (results) => {
  const devshm = results.find((r) => r.check === "devshm-ipc");
  if (!devshm) return null;
  const match = devshm.detail.match(/\/dev\/shm\/sandbox-probe-\S+/);
  return match ? match[0] : null;
};

const main = () => {
  const probeBin = locateProbe();
  log(`sandbox-selftest: probe = ${probeBin}`);

  // Temp rw dirs the profile will bind 1:1.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-sbx-selftest-"));
  const gameDir = path.join(tmpRoot, "game");
  const winePrefix = path.join(tmpRoot, "prefix");
  const homePersistDir = path.join(tmpRoot, "home");
  for (const dir of [gameDir, winePrefix, homePersistDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // The probe binary itself lives under the real $HOME, which the profile hides
  // behind the /home tmpfs, so bwrap could not exec it from there. Real game
  // executables live inside the bound gameDir; mirror that by placing the probe
  // there. The gameDir bind is 1:1, so the path is identical host-side and
  // inside the sandbox.
  const probeInGame = path.join(gameDir, "sandbox-probe");
  fs.copyFileSync(probeBin, probeInGame);
  fs.chmodSync(probeInGame, 0o755);

  // Sentinel in the REAL $HOME, outside every bind: the probe must NOT see it.
  const realHome = process.env.HOME || os.homedir();
  const sentinel = path.join(
    realHome,
    `.hydra-sandbox-selftest-sentinel-${process.pid}`
  );
  fs.writeFileSync(sentinel, "hydra-sandbox-selftest sentinel\n");

  // Build the REAL profile. No reimplementation.
  const { command, args } = buildSandboxArgs({
    command: probeInGame,
    args: ["--json"],
    env: process.env,
    gameDir,
    winePrefix,
    homePersistDir,
  });

  // The PROBE_* contract. bwrap inherits the caller env, so passing these
  // through spawn's `env` makes the probe (the child inside the sandbox) see
  // them. NO_COLOR keeps stdout clean for JSON parsing.
  const childEnv = {
    ...process.env,
    NO_COLOR: "1",
    PROBE_HOST_PID: String(process.pid),
    PROBE_GAME_DIR: gameDir,
    PROBE_WINE_PREFIX: winePrefix,
    PROBE_EXPECT_NETWORK: "1",
    PROBE_HOST_SENTINEL: sentinel,
  };

  let results = [];
  let devShmMarker = null;
  let hadError = false;

  try {
    log(`sandbox-selftest: spawning ${command} (${args.length} bwrap args)`);
    const proc = spawnSync(command, args, {
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });

    if (proc.error) {
      console.error("sandbox-selftest: failed to spawn bwrap:", proc.error);
      hadError = true;
    }

    const stdout = proc.stdout || "";
    const stderr = proc.stderr || "";
    if (stderr.trim()) {
      log("sandbox-selftest: probe stderr:\n" + stderr.trim());
    }

    try {
      results = JSON.parse(stdout);
    } catch (parseErr) {
      console.error(
        "sandbox-selftest: could not parse probe JSON output:",
        parseErr.message
      );
      console.error("--- raw stdout ---\n" + stdout + "\n--- end ---");
      hadError = true;
    }

    if (Array.isArray(results) && results.length > 0) {
      devShmMarker = extractDevShmMarker(results);

      log("\nsandbox-selftest: probe results");
      let fails = 0;
      for (const r of results) {
        if (r.status === "FAIL") fails += 1;
        log(`  [${r.status.padEnd(4)}] ${r.check.padEnd(22)} ${r.detail}`);
      }
      const pass = results.filter((r) => r.status === "PASS").length;
      const skip = results.filter((r) => r.status === "SKIP").length;
      log(
        `\nsandbox-selftest: ${pass} pass, ${fails} fail, ${skip} skip ` +
          `(probe exit ${proc.status})`
      );

      if (fails > 0 || proc.status !== 0) {
        hadError = true;
        console.error("sandbox-selftest: SANDBOX BROKEN — one or more FAILs");
      }
    } else if (!hadError) {
      console.error("sandbox-selftest: probe produced no results");
      hadError = true;
    }

    // Host-side verification: the private /dev/shm marker the probe wrote
    // inside its unshared IPC/tmpfs must NOT exist on the host.
    if (devShmMarker) {
      if (fs.existsSync(devShmMarker)) {
        console.error(
          `sandbox-selftest: /dev/shm marker LEAKED to host: ${devShmMarker}`
        );
        hadError = true;
      } else {
        log(
          `sandbox-selftest: host /dev/shm marker absent (ok): ${devShmMarker}`
        );
      }
    }
  } finally {
    // Clean up everything we created.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(sentinel, { force: true });
    } catch {
      /* ignore */
    }
    if (devShmMarker) {
      try {
        fs.rmSync(devShmMarker, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  process.exit(hadError ? 1 : 0);
};

main();
