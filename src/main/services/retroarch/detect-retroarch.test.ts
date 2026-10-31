import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";

const loadDetectRetroArch = (emulatorRoot: string, userData: string) => {
  const modules: Record<string, unknown> = {
    "node:fs": fs,
    "node:os": os,
    "node:path": path,
    "../emulators/detect-emulator": { detectEmulator: () => null },
    "../emulators/emulator-install-root": {
      getEmulatorInstallRoot: () => emulatorRoot,
    },
    "../emulators/get-emulator-version": { getEmulatorVersion: () => null },
    "../system-path": { SystemPath: { getPath: () => userData } },
    "./retroarch-config-paths": {
      retroArchConfigCandidates: () => [],
      retroArchConfigRoots: () => [],
    },
  };
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL("./detect-retroarch.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
      },
    }
  );
  const exports: {
    detectRetroArchWithFallback?: () => Promise<{
      executablePath: string;
    } | null>;
  } = {};
  // Any other import (such as the downloads path helper) fails the test.
  new Function("exports", "require", "process", outputText)(
    exports,
    (name: string) => modules[name] ?? assert.fail(`unexpected ${name}`),
    { platform: "linux" }
  );
  return exports.detectRetroArchWithFallback!;
};

describe("detectRetroArchWithFallback", () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "retroarch-detect-"));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds RetroArch only under the launcher-owned emulator root", async () => {
    const emulatorRoot = path.join(root, "userData/emulators");
    const userData = path.join(root, "userData");
    const detect = loadDetectRetroArch(emulatorRoot, userData);

    assert.equal(await detect(), null);

    const installed = path.join(emulatorRoot, "RetroArch/RetroArch.AppImage");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "");

    assert.equal((await detect())?.executablePath, installed);
  });
});
