import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import * as tar from "tar";

import {
  getRestoreScratchDir,
  isBackupStorageDir,
  RESTORE_TMP_DIRNAME,
  restoreFromArtifactTar,
} from "./restore-scratch.ts";

const SHOP = "steam";
const OBJECT_ID = "12345";

/** Builds a tiny tar from a known file tree and returns its path. */
const buildTar = (
  root: string,
  name: string,
  files: Record<string, string>
) => {
  const treeDir = fs.mkdtempSync(path.join(root, "tree-"));
  for (const [rel, contents] of Object.entries(files)) {
    const dest = path.join(treeDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }

  const tarPath = path.join(root, name);
  tar.c({ file: tarPath, cwd: treeDir, sync: true }, ["."]);
  return tarPath;
};

/**
 * Mirrors `LocalDirectoryBackend.upload`: stores a tar + json sidecar at
 * `<root>/<shop>-<objectId>/<uuid>.{tar,json}` and returns the artifact id.
 * The backend itself can't be imported here (it transitively pulls in
 * electron via `@main/constants`/`logger`), so we reproduce its exact layout.
 */
const storeArtifact = (root: string, stagedTar: string) => {
  const gameDir = path.join(root, `${SHOP}-${OBJECT_ID}`);
  fs.mkdirSync(gameDir, { recursive: true });

  const id = crypto.randomUUID();
  fs.copyFileSync(stagedTar, path.join(gameDir, `${id}.tar`));
  fs.writeFileSync(
    path.join(gameDir, `${id}.json`),
    JSON.stringify({ id, shop: SHOP, objectId: OBJECT_ID }, null, 2)
  );

  return id;
};

/** Mirrors `LocalDirectoryBackend.download`: returns the STORED tar path. */
const downloadArtifact = (root: string, id: string) =>
  path.join(root, `${SHOP}-${OBJECT_ID}`, `${id}.tar`);

describe("restoreFromArtifactTar (local backup restore preservation)", () => {
  let backupsRoot: string;

  before(() => {
    backupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-scratch-"));
  });

  beforeEach(() => {
    fs.rmSync(backupsRoot, { recursive: true, force: true });
    fs.mkdirSync(backupsRoot, { recursive: true });
  });

  after(() => {
    fs.rmSync(backupsRoot, { recursive: true, force: true });
  });

  it("preserves the stored .tar/.json and sibling backups through a real restore", async () => {
    // Two backups for the SAME game, stored the way the local backend does.
    const stagedTar1 = buildTar(backupsRoot, "staged-1.tar", {
      "save.dat": "first save payload",
    });
    const stagedTar2 = buildTar(backupsRoot, "staged-2.tar", {
      "save.dat": "second save payload",
    });

    const id1 = storeArtifact(backupsRoot, stagedTar1);
    const id2 = storeArtifact(backupsRoot, stagedTar2);

    const gameDir = path.join(backupsRoot, `${SHOP}-${OBJECT_ID}`);
    const storedTar1 = path.join(gameDir, `${id1}.tar`);
    const storedJson1 = path.join(gameDir, `${id1}.json`);
    const storedTar2 = path.join(gameDir, `${id2}.tar`);
    const storedJson2 = path.join(gameDir, `${id2}.json`);

    // download() returns the STORED tar path — the exact collision source.
    const tarLocation = downloadArtifact(backupsRoot, id1);
    assert.equal(tarLocation, storedTar1);

    let restoredContents: string | null = null;
    const scratchDir = getRestoreScratchDir(backupsRoot, SHOP, OBJECT_ID);

    await restoreFromArtifactTar({
      backupsRoot,
      shop: SHOP,
      objectId: OBJECT_ID,
      tarLocation,
      restore: (dir) => {
        assert.equal(dir, scratchDir);
        // (a) the extracted files exist in the scratch dir during restore.
        restoredContents = fs.readFileSync(path.join(dir, "save.dat"), "utf8");
      },
    });

    // (a) restore actually saw the extracted payload.
    assert.equal(restoredContents, "first save payload");

    // (b) the ORIGINAL stored tar/json for the restored artifact STILL EXIST.
    //     (This is the assertion that fails against the old handler.)
    assert.ok(
      fs.existsSync(storedTar1),
      "stored tar of restored artifact gone"
    );
    assert.ok(
      fs.existsSync(storedJson1),
      "stored sidecar of restored artifact gone"
    );

    // (c) the sibling backup for the same game is untouched.
    assert.ok(fs.existsSync(storedTar2), "sibling backup tar was destroyed");
    assert.ok(fs.existsSync(storedJson2), "sibling backup sidecar destroyed");

    // Scratch dir is cleaned up afterwards.
    assert.ok(
      !fs.existsSync(scratchDir),
      "restore scratch dir was not cleaned up"
    );
  });

  it("still removes the scratch dir when the restore step throws", async () => {
    const stagedTar = buildTar(backupsRoot, "staged.tar", {
      "save.dat": "payload",
    });
    const id = storeArtifact(backupsRoot, stagedTar);
    const storedTar = path.join(
      backupsRoot,
      `${SHOP}-${OBJECT_ID}`,
      `${id}.tar`
    );
    const scratchDir = getRestoreScratchDir(backupsRoot, SHOP, OBJECT_ID);

    await assert.rejects(() =>
      restoreFromArtifactTar({
        backupsRoot,
        shop: SHOP,
        objectId: OBJECT_ID,
        tarLocation: downloadArtifact(backupsRoot, id),
        restore: () => {
          throw new Error("restore blew up");
        },
      })
    );

    // Stored artifact survives even when the restore step fails.
    assert.ok(
      fs.existsSync(storedTar),
      "stored tar destroyed on restore error"
    );
    assert.ok(
      !fs.existsSync(scratchDir),
      "scratch dir leaked on restore error"
    );
  });

  it("extracts into a reserved dot-directory the backend skips", () => {
    const scratchDir = getRestoreScratchDir(backupsRoot, SHOP, OBJECT_ID);
    assert.equal(
      scratchDir,
      path.join(backupsRoot, RESTORE_TMP_DIRNAME, `${SHOP}-${OBJECT_ID}`)
    );

    // The backend's game-folder scan must treat the scratch/cache dirs as
    // reserved (skipped) and real `<shop>-<objectId>` folders as storage.
    assert.equal(isBackupStorageDir(RESTORE_TMP_DIRNAME), false);
    assert.equal(isBackupStorageDir(".rclone-tmp"), false);
    assert.equal(isBackupStorageDir(".rclone-cache"), false);
    assert.equal(isBackupStorageDir(`${SHOP}-${OBJECT_ID}`), true);
  });
});
