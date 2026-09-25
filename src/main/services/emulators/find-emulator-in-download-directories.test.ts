import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { findEmulatorInDownloadDirectories } from "./find-emulator-in-download-directories.ts";

const PPSSPP = {
  binary: "ppsspp",
  displayName: "PPSSPP",
  linuxNames: ["PPSSPPSDL", "ppsspp"],
  windowsNames: ["PPSSPPWindows64.exe"],
  macosBundleNames: ["PPSSPP.app"],
};

const writeExecutable = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
};

describe("findEmulatorInDownloadDirectories", () => {
  let downloads: string;

  before(() => {
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), "emu-detect-"));
  });

  after(() => {
    fs.rmSync(downloads, { recursive: true, force: true });
  });

  it("ignores emulator-named binaries inside game downloads", () => {
    writeExecutable(path.join(downloads, "PPSSPPSDL"));
    writeExecutable(path.join(downloads, "Some Game", "bin", "PPSSPPSDL"));

    assert.equal(findEmulatorInDownloadDirectories(PPSSPP, [downloads]), null);
  });

  it("finds the emulator in its install directory", () => {
    const installed = path.join(downloads, "PPSSPP", "PPSSPPSDL");
    writeExecutable(installed);

    assert.equal(
      findEmulatorInDownloadDirectories(PPSSPP, [downloads]),
      installed
    );
  });
});
