import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { resolveSandboxGameDir } from "./sandbox-game-dir.ts";

describe("resolveSandboxGameDir", () => {
  let root: string;
  let downloads: string;
  let installDir: string;
  let nestedExe: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-game-dir-"));
    downloads = path.join(root, "Downloads");
    installDir = path.join(downloads, "Some Game");
    nestedExe = path.join(installDir, "Binaries/Win64/Game.exe");
    fs.mkdirSync(path.dirname(nestedExe), { recursive: true });
    fs.writeFileSync(nestedExe, "");
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.writeFileSync(path.join(root, "elsewhere/Other.exe"), "");
    fs.writeFileSync(path.join(downloads, "Loose.exe"), "");
    fs.symlinkSync(
      path.join(root, "elsewhere"),
      path.join(installDir, "linked")
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("binds the install dir for an executable nested inside it", () => {
    assert.equal(
      resolveSandboxGameDir(nestedExe, {
        downloadPath: downloads,
        folderName: "Some Game",
      }),
      installDir
    );
  });

  it("keeps the executable dir without a usable download record", () => {
    const exeDir = path.dirname(nestedExe);
    for (const download of [
      null,
      undefined,
      { downloadPath: downloads, folderName: null },
      { downloadPath: downloads, folderName: "" },
      { downloadPath: downloads, folderName: "." },
      { downloadPath: downloads, folderName: ".." },
      { downloadPath: downloads, folderName: "../.." },
      { downloadPath: downloads, folderName: "Missing Game" },
      { downloadPath: null, folderName: "Some Game" },
    ])
      assert.equal(resolveSandboxGameDir(nestedExe, download), exeDir);
  });

  it("keeps the executable dir for an executable outside the install dir", () => {
    // Not inside "Some Game": unchanged behaviour, the exe's own dir.
    assert.equal(
      resolveSandboxGameDir(path.join(downloads, "Loose.exe"), {
        downloadPath: downloads,
        folderName: "Some Game",
      }),
      downloads
    );
    // Reached through a symlink: the real file lives outside the install dir.
    const linkedExe = path.join(installDir, "linked/Other.exe");
    assert.equal(
      resolveSandboxGameDir(linkedExe, {
        downloadPath: downloads,
        folderName: "Some Game",
      }),
      path.dirname(linkedExe)
    );
  });
});
