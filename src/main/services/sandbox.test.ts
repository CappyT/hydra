import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  assertSandboxAvailable,
  buildSandboxArgs,
  isSandboxEnabled,
  SandboxUnavailableError,
} from "./sandbox-command-builder.ts";

const BIND_FLAGS = new Set(["--bind", "--ro-bind", "--dev-bind"]);

const collectBindPairs = (args: string[]) => {
  const pairs: { flag: string; source: string; dest: string }[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (BIND_FLAGS.has(args[index])) {
      pairs.push({
        flag: args[index],
        source: args[index + 1],
        dest: args[index + 2],
      });
    }
  }

  return pairs;
};

const hasBind = (args: string[], flag: string, target: string) =>
  collectBindPairs(args).some(
    (pair) =>
      pair.flag === flag && pair.source === target && pair.dest === target
  );

describe("Sandbox.wrapCommand", () => {
  let tmpRoot: string;
  let gameDir: string;
  let winePrefix: string;
  let protonDir: string;
  let extraExisting: string;
  let persistHome: string;
  const missingPath = "/nonexistent/path/does/not/exist";

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-test-"));
    gameDir = path.join(tmpRoot, "game");
    winePrefix = path.join(tmpRoot, "prefix");
    protonDir = path.join(tmpRoot, "proton");
    extraExisting = path.join(tmpRoot, "extra");
    persistHome = path.join(tmpRoot, "home");
    for (const dir of [
      gameDir,
      winePrefix,
      protonDir,
      extraExisting,
      persistHome,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const baseEnv = {
    HOME: "/home/tester",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };

  it("wraps the target command behind the bwrap separator", () => {
    const { command, args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: ["--foo", "bar"],
      env: baseEnv,
      gameDir,
    });

    assert.equal(command, "/usr/bin/bwrap");
    const separatorIndex = args.indexOf("--");
    assert.ok(separatorIndex > 0);
    assert.deepEqual(args.slice(separatorIndex + 1), [
      "/usr/bin/game",
      "--foo",
      "bar",
    ]);
  });

  it("never disables networking", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    assert.ok(!args.includes("--unshare-net"));
  });

  it("unshares the ipc namespace by default and shares it on request", () => {
    const isolated = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });
    assert.ok(isolated.args.includes("--unshare-ipc"));

    const shared = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      shareIpc: true,
    });
    assert.ok(!shared.args.includes("--unshare-ipc"));
  });

  it("binds the game dir read-write with a 1:1 path", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    assert.ok(hasBind(args, "--bind", gameDir));
  });

  it("binds prefix read-write and proton dir read-only when present", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      winePrefix,
      protonDir,
    });

    assert.ok(hasBind(args, "--bind", winePrefix));
    assert.ok(hasBind(args, "--ro-bind", protonDir));
  });

  it("masks the session d-bus socket with a dead placeholder", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    const pairs = collectBindPairs(args);
    const busBind = pairs.find(
      (pair) => pair.dest === "/run/user/1000/bus"
    );
    assert.ok(busBind);
    assert.equal(busBind.flag, "--ro-bind");
    assert.equal(busBind.source, "/dev/null");
  });

  it("binds extra read-only paths (bundled umu-run) and skips missing ones", () => {
    const umuBinary = path.join(tmpRoot, "umu-run");
    fs.writeFileSync(umuBinary, "");

    const { args } = buildSandboxArgs({
      command: "/usr/bin/python3",
      args: [umuBinary],
      env: baseEnv,
      gameDir,
      extraRoBinds: [umuBinary, missingPath],
    });

    assert.ok(hasBind(args, "--ro-bind", umuBinary));
    assert.ok(!hasBind(args, "--ro-bind", missingPath));
  });

  it("binds the wine prefix read-write when the dir exists", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      winePrefix,
    });

    assert.ok(hasBind(args, "--bind", winePrefix));
  });

  it("binds a persistent home over $HOME and drops the empty dir", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      homePersistDir: persistHome,
    });

    const bindPairs = collectBindPairs(args);
    assert.ok(
      bindPairs.some(
        (pair) =>
          pair.flag === "--bind" &&
          pair.source === persistHome &&
          pair.dest === baseEnv.HOME
      ),
      "expected persistent home bound over $HOME"
    );

    const homeDirIndex = args.indexOf(baseEnv.HOME);
    assert.ok(homeDirIndex === -1 || args[homeDirIndex - 1] !== "--dir");
  });

  it("re-creates an empty $HOME when no persistent home is provided", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    const homeDirIndex = args.indexOf(baseEnv.HOME);
    assert.ok(homeDirIndex > 0);
    assert.equal(args[homeDirIndex - 1], "--dir");
    assert.ok(
      !collectBindPairs(args).some((pair) => pair.dest === baseEnv.HOME)
    );
  });

  it("ignores a persistent home dir that does not exist", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      homePersistDir: missingPath,
    });

    const homeDirIndex = args.indexOf(baseEnv.HOME);
    assert.equal(args[homeDirIndex - 1], "--dir");
  });

  it("skips binds for paths that do not exist", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      winePrefix: missingPath,
      protonDir: missingPath,
      extraBinds: [extraExisting, missingPath],
    });

    assert.ok(hasBind(args, "--bind", extraExisting));
    assert.ok(
      !collectBindPairs(args).some((pair) => pair.source === missingPath)
    );
  });

  it("re-creates $HOME and the runtime dir on tmpfs", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    const homeTmpfs = args.indexOf("/home");
    assert.equal(args[homeTmpfs - 1], "--tmpfs");
    assert.ok(args.includes("/home/tester"));
    assert.ok(args.includes("/run/user/1000"));
  });

  it("binds /dev/input and hidraw nodes when present, never /dev/uinput", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    // The host /dev is the real one here, so only assert the binds that the
    // host actually exposes (mirrors how nvidia devices are tolerated absent).
    if (fs.existsSync("/dev/input")) {
      assert.ok(hasBind(args, "--dev-bind", "/dev/input"));
    }

    for (const entry of fs.readdirSync("/dev")) {
      if (entry.startsWith("hidraw")) {
        assert.ok(hasBind(args, "--dev-bind", path.join("/dev", entry)));
      }
    }

    // /dev/uinput is deliberately never bound: games read virtual pads as
    // event nodes, they do not create them.
    assert.ok(!hasBind(args, "--dev-bind", "/dev/uinput"));
  });

  it("re-exposes the gamescope compositor socket from the runtime dir", () => {
    const runtimeDir = fs.mkdtempSync(path.join(tmpRoot, "runtime-"));
    fs.writeFileSync(path.join(runtimeDir, "gamescope-0"), "");
    fs.writeFileSync(path.join(runtimeDir, "wayland-1"), "");

    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: { HOME: "/home/tester", XDG_RUNTIME_DIR: runtimeDir },
      gameDir,
    });

    assert.ok(hasBind(args, "--ro-bind", path.join(runtimeDir, "gamescope-0")));
    assert.ok(hasBind(args, "--ro-bind", path.join(runtimeDir, "wayland-1")));
  });

  it("re-exposes NetworkManager DNS after the /run tmpfs when present", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
    });

    // SteamOS and other NM-managed hosts symlink /etc/resolv.conf into
    // /run/NetworkManager; only assert the bind when the host has it.
    if (fs.existsSync("/run/NetworkManager")) {
      assert.ok(hasBind(args, "--ro-bind", "/run/NetworkManager"));
    }
  });

  it("keeps every filesystem bind 1:1 (same source and destination)", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: baseEnv,
      gameDir,
      winePrefix,
      protonDir,
      extraBinds: [extraExisting],
    });

    for (const pair of collectBindPairs(args)) {
      // The dead session-bus placeholder is the single sanctioned path remap
      // besides the $HOME override (which uses --bind over --dir, not a pair
      // collected here).
      if (pair.dest === "/run/user/1000/bus") {
        assert.equal(pair.source, "/dev/null");
        continue;
      }

      assert.equal(
        pair.source,
        pair.dest,
        `expected 1:1 bind for ${pair.flag} ${pair.source} -> ${pair.dest}`
      );
    }
  });
});

describe("Sandbox X11 hardening (hideX11)", () => {
  let tmpRoot: string;
  let gameDir: string;
  let xauthority: string;
  let home: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-x11-"));
    gameDir = path.join(tmpRoot, "game");
    home = path.join(tmpRoot, "home");
    xauthority = path.join(tmpRoot, "xauthority");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "MangoHud"), { recursive: true });
    fs.writeFileSync(path.join(home, ".Xauthority"), "");
    fs.writeFileSync(xauthority, "");
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const env = () => ({
    HOME: home,
    XDG_RUNTIME_DIR: "/run/user/1000",
    XAUTHORITY: xauthority,
  });

  it("keeps the session X11 binds when hideX11 is absent", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: env(),
      gameDir,
    });

    assert.ok(hasBind(args, "--ro-bind", xauthority));
    assert.ok(hasBind(args, "--ro-bind", path.join(home, ".Xauthority")));
    // MangoHud config stays regardless of hideX11.
    assert.ok(hasBind(args, "--ro-bind", path.join(home, ".config", "MangoHud")));
  });

  it("omits every session X11 bind when hideX11 is true", () => {
    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: env(),
      gameDir,
      hideX11: true,
    });

    assert.ok(!hasBind(args, "--ro-bind", xauthority));
    assert.ok(!hasBind(args, "--ro-bind", path.join(home, ".Xauthority")));
    assert.ok(
      !collectBindPairs(args).some((pair) => pair.dest === "/tmp/.X11-unix")
    );
    // Non-X11 binds are untouched: MangoHud config is still exposed.
    assert.ok(
      hasBind(args, "--ro-bind", path.join(home, ".config", "MangoHud"))
    );
  });

  it("still re-exposes wayland/gamescope sockets when hideX11 is true", () => {
    const runtimeDir = fs.mkdtempSync(path.join(tmpRoot, "runtime-"));
    fs.writeFileSync(path.join(runtimeDir, "wayland-1"), "");
    fs.writeFileSync(path.join(runtimeDir, "gamescope-0"), "");

    const { args } = buildSandboxArgs({
      command: "/usr/bin/game",
      args: [],
      env: { HOME: home, XDG_RUNTIME_DIR: runtimeDir, XAUTHORITY: xauthority },
      gameDir,
      hideX11: true,
    });

    assert.ok(hasBind(args, "--ro-bind", path.join(runtimeDir, "wayland-1")));
    assert.ok(hasBind(args, "--ro-bind", path.join(runtimeDir, "gamescope-0")));
    assert.ok(!hasBind(args, "--ro-bind", xauthority));
  });
});

describe("Sandbox.isEnabled", () => {
  const originalPlatform = process.platform;

  before(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  after(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("defaults to enabled when nothing is configured", () => {
    assert.equal(isSandboxEnabled(null, null), true);
  });

  it("respects the global disable preference", () => {
    assert.equal(isSandboxEnabled({ disableSandbox: true }, null), false);
  });

  it("lets a per-game override win over the global preference", () => {
    assert.equal(
      isSandboxEnabled({ disableSandbox: true }, { sandboxDisabled: false }),
      true
    );
    assert.equal(
      isSandboxEnabled({ disableSandbox: false }, { sandboxDisabled: true }),
      false
    );
  });
});

// Regression guard for the security-critical fail-closed behavior that backs
// wrapWithSandbox in sandbox-launch.ts: the sandbox must never be silently
// skipped. wrapWithSandbox calls assertSandboxAvailable(enabled, available)
// as its throw site, so testing the pure helper here covers that exact path
// without pulling electron into the test runner.
describe("assertSandboxAvailable", () => {
  it("throws SandboxUnavailableError when enabled but bwrap is unavailable", () => {
    assert.throws(
      () => assertSandboxAvailable(true, false),
      SandboxUnavailableError
    );
  });

  it("does not throw when enabled and bwrap is available", () => {
    assert.doesNotThrow(() => assertSandboxAvailable(true, true));
  });

  it("does not throw when the sandbox is disabled", () => {
    assert.doesNotThrow(() => assertSandboxAvailable(false, false));
    assert.doesNotThrow(() => assertSandboxAvailable(false, true));
  });
});
