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
