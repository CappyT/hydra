import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  buildSandboxArgs,
  isSandboxEnabled,
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
  const missingPath = "/nonexistent/path/does/not/exist";

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-test-"));
    gameDir = path.join(tmpRoot, "game");
    winePrefix = path.join(tmpRoot, "prefix");
    protonDir = path.join(tmpRoot, "proton");
    extraExisting = path.join(tmpRoot, "extra");
    for (const dir of [gameDir, winePrefix, protonDir, extraExisting]) {
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
      assert.equal(
        pair.source,
        pair.dest,
        `expected 1:1 bind for ${pair.flag} ${pair.source} -> ${pair.dest}`
      );
    }
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
