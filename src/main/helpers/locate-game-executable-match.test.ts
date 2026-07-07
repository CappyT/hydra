import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  findExecutableInDriveC,
  findExecutableInFolder,
  searchCandidateDirectories,
} from "./locate-game-executable-match.ts";

const silentLogger = { error: () => {} };

const touch = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
};

describe("locate-game-executable matching", () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "locate-exe-"));
  });

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds an executable recursively, case-insensitively", async () => {
    const target = path.join(root, "Games", "Hollow Knight", "Hollow Knight.exe");
    touch(target);
    touch(path.join(root, "Games", "Hollow Knight", "readme.txt"));

    const found = await findExecutableInFolder(
      root,
      new Set(["hollow knight.exe"]),
      silentLogger
    );

    assert.equal(found, target);
  });

  it("returns null when no name matches", async () => {
    touch(path.join(root, "some", "other.exe"));

    const found = await findExecutableInFolder(
      root,
      new Set(["hollow knight.exe"]),
      silentLogger
    );

    assert.equal(found, null);
  });

  it("returns null (not throw) for a missing folder", async () => {
    const found = await findExecutableInFolder(
      path.join(root, "does-not-exist"),
      new Set(["a.exe"]),
      silentLogger
    );

    assert.equal(found, null);
  });

  it("skips windows and ProgramData top-level dirs in drive_c", async () => {
    const driveC = path.join(root, "drive_c");
    // Decoy matches inside excluded dirs must be ignored (case-insensitive).
    touch(path.join(driveC, "windows", "game.exe"));
    touch(path.join(driveC, "ProgramData", "game.exe"));
    // The real install lives elsewhere.
    const real = path.join(driveC, "Games", "Repack", "game.exe");
    touch(real);

    const found = await findExecutableInDriveC(
      driveC,
      new Set(["game.exe"]),
      silentLogger
    );

    assert.equal(found, real);
  });

  it("matches a file that sits directly in drive_c", async () => {
    const driveC = path.join(root, "drive_c");
    const target = path.join(driveC, "portable.exe");
    touch(target);

    const found = await findExecutableInDriveC(
      driveC,
      new Set(["portable.exe"]),
      silentLogger
    );

    assert.equal(found, target);
  });

  it("ignores a match only present under the excluded windows dir", async () => {
    const driveC = path.join(root, "drive_c");
    touch(path.join(driveC, "Windows", "System32", "only.exe"));

    const found = await findExecutableInDriveC(
      driveC,
      new Set(["only.exe"]),
      silentLogger
    );

    assert.equal(found, null);
  });

  it("searches candidate dirs in priority order and honors drive_c flag", async () => {
    const driveC = path.join(root, "prefix", "drive_c");
    const sandboxHome = path.join(root, "sandbox-home");
    // Only the sandbox home has the exe; drive_c has just an excluded decoy.
    touch(path.join(driveC, "windows", "app.exe"));
    const target = path.join(sandboxHome, "nested", "app.exe");
    touch(target);

    const found = await searchCandidateDirectories(
      [
        { path: driveC, isDriveC: true },
        { path: sandboxHome },
      ],
      new Set(["app.exe"]),
      silentLogger
    );

    assert.equal(found, target);
  });

  it("returns the first candidate that matches", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const firstHit = path.join(first, "app.exe");
    touch(firstHit);
    touch(path.join(second, "app.exe"));

    const found = await searchCandidateDirectories(
      [{ path: first }, { path: second }],
      new Set(["app.exe"]),
      silentLogger
    );

    assert.equal(found, firstHit);
  });
});
