import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";

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
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-detect-"));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ignores emulator-named binaries outside the emulator install dir", () => {
    writeExecutable(path.join(root, "PPSSPPSDL"));
    writeExecutable(path.join(root, "Some Game", "bin", "PPSSPPSDL"));

    assert.equal(findEmulatorInDownloadDirectories(PPSSPP, [root]), null);
  });

  it("finds the emulator in its install directory", () => {
    const installed = path.join(root, "PPSSPP", "PPSSPPSDL");
    writeExecutable(installed);

    assert.equal(findEmulatorInDownloadDirectories(PPSSPP, [root]), installed);
  });
});

describe("detectEmulatorWithDownloads", () => {
  it("searches only the launcher-owned emulator root, never a downloads dir", async () => {
    const calls: { downloadDirectories?: string[] }[] = [];
    const modules: Record<string, unknown> = {
      "./detect-emulator.js": {
        detectEmulator: (
          _binary: unknown,
          options: { downloadDirectories?: string[] }
        ) => {
          calls.push(options);
          return null;
        },
      },
      "./emulator-install-root.js": {
        getEmulatorInstallRoot: () => "/data/hydra/emulators",
      },
    };
    const { outputText } = ts.transpileModule(
      fs.readFileSync(
        new URL("./detect-emulator-with-downloads.ts", import.meta.url),
        "utf8"
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ESNext,
          esModuleInterop: true,
        },
      }
    );
    const exports: {
      detectEmulatorWithDownloads?: (binary: unknown) => Promise<unknown>;
    } = {};
    // Any other import (such as the downloads path helper) fails the test.
    new Function("exports", "require", outputText)(
      exports,
      (name: string) => modules[name] ?? assert.fail(`unexpected ${name}`)
    );

    await exports.detectEmulatorWithDownloads!(PPSSPP);

    assert.deepEqual(calls[0].downloadDirectories, ["/data/hydra/emulators"]);
  });
});
