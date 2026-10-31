import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { assertBackupSourcesInsideRoot } from "./backup-source-paths.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup-source-paths-"));
const root = path.join(base, "prefix");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(root, "saves"), { recursive: true });
fs.mkdirSync(outside);
fs.mkdirSync(path.join(base, "prefix-other"));

const save = path.join(root, "saves", "slot1.sav");
const secret = path.join(outside, "id_ed25519");
const sibling = path.join(base, "prefix-other", "slot.sav");
fs.writeFileSync(save, "save");
fs.writeFileSync(secret, "key");
fs.writeFileSync(sibling, "save");
fs.symlinkSync(secret, path.join(root, "saves", "link.sav"));
fs.symlinkSync(outside, path.join(root, "saves", "dirlink"));
fs.symlinkSync(root, path.join(base, "prefix-link"));

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("assertBackupSourcesInsideRoot", () => {
  it("accepts regular files inside the save root", () => {
    assert.doesNotThrow(() => assertBackupSourcesInsideRoot([save], root));
  });

  it("accepts files under a symlinked save root", () => {
    const viaLink = path.join(base, "prefix-link", "saves", "slot1.sav");
    assert.doesNotThrow(() =>
      assertBackupSourcesInsideRoot([viaLink], path.join(base, "prefix-link"))
    );
  });

  it("refuses a symlinked save file", () => {
    assert.throws(
      () =>
        assertBackupSourcesInsideRoot(
          [save, path.join(root, "saves", "link.sav")],
          root
        ),
      /symlink/
    );
  });

  it("refuses a file reached through a symlinked directory", () => {
    assert.throws(
      () =>
        assertBackupSourcesInsideRoot(
          [path.join(root, "saves", "dirlink", "id_ed25519")],
          root
        ),
      /outside/
    );
  });

  it("refuses the resolved host path ludusavi reports for a symlink", () => {
    assert.throws(
      () => assertBackupSourcesInsideRoot([secret], root),
      /outside/
    );
  });

  it("refuses a sibling directory that shares the root name prefix", () => {
    assert.throws(
      () => assertBackupSourcesInsideRoot([sibling], root),
      /outside/
    );
  });

  it("refuses the save root itself", () => {
    assert.throws(() => assertBackupSourcesInsideRoot([root], root), /outside/);
  });
});
