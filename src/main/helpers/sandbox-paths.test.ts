import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assertSafeSandboxPath } from "./sandbox-paths.ts";
it("rejects home, launcher state, credentials and symlink aliases but permits per-game state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-paths-"));
  try {
    const home = path.join(root, "home");
    const data = path.join(home, ".config/hydra");
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.symlinkSync(path.join(home, ".ssh"), path.join(root, "alias"));
    for (const bad of [
      home,
      root,
      data,
      path.join(data, "leveldb"),
      path.join(home, ".ssh/key"),
      path.join(root, "alias"),
      path.join(home, ".local/share/umu"),
      path.join(data, "wine-prefixes"),
    ])
      assert.throws(() => assertSafeSandboxPath(bad, home, data));
    for (const good of [
      path.join(data, "wine-prefixes/123"),
      path.join(data, "Downloads/game"),
      path.join(root, "game"),
    ])
      assert.doesNotThrow(() => assertSafeSandboxPath(good, home, data));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects the filesystem root and symlinks to it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-paths-"));
  try {
    const home = path.join(root, "home");
    const data = path.join(home, ".config/hydra");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(root, "game"));
    fs.symlinkSync("/", path.join(root, "game", "mods"));
    for (const bad of ["/", "//", "/.", path.join(root, "game", "mods")])
      assert.throws(
        () => assertSafeSandboxPath(bad, home, data, "/run/user/1000"),
        { code: "SANDBOX_UNAVAILABLE" }
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects runtime, temp and kernel roots and their sockets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-paths-"));
  try {
    const home = path.join(root, "home");
    const data = path.join(home, ".config/hydra");
    const runtime = path.join(root, "xdg-runtime");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, "bus"), "");
    fs.symlinkSync(path.join(runtime, "bus"), path.join(root, "bus-alias"));
    for (const bad of [
      "/run",
      "/run/user",
      "/run/user/1000",
      "/run/user/1000/bus",
      "/run/dbus/system_bus_socket",
      "/var/run",
      "/tmp",
      "/proc",
      "/proc/self/root",
      "/proc/1/cwd",
      "/dev",
      "/dev/shm",
      "/sys",
      "/sys/fs/cgroup",
      runtime,
      path.join(runtime, "bus"),
      path.join(root, "bus-alias"),
    ])
      assert.throws(
        () => assertSafeSandboxPath(bad, home, data, runtime),
        { code: "SANDBOX_UNAVAILABLE" },
        bad
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("permits game dirs, removable media, per-game state and downloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-paths-"));
  try {
    const home = path.join(root, "home");
    const data = path.join(home, ".config/hydra");
    fs.mkdirSync(data, { recursive: true });
    for (const good of [
      path.join(home, "Games/Some Game/Binaries/Win64"),
      path.join(data, "sandbox-homes/steam_123"),
      path.join(data, "wine-prefixes/123"),
      path.join(data, "Downloads/Some Game"),
      path.join(root, "game"),
      "/run/media/deck/SD/Games/Some Game",
      "/mnt/games/Some Game",
    ])
      assert.doesNotThrow(
        () => assertSafeSandboxPath(good, home, data, "/run/user/1000"),
        good
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
