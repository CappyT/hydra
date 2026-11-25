import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import ts from "typescript";

type ProcessMap = {
  processMap: Record<string, string[]>;
  autoDetectProcessMap: Record<string, string[]>;
  winePrefixMap: Record<string, string>;
  linuxProcesses: Array<{ pid: number }>;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-addon-map-"));
const workers: Worker[] = [];
after(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()));
  fs.rmSync(root, { recursive: true, force: true });
});

// Fake /proc: the launcher and pid 100 share a namespace, pid 200 is in a
// sandbox namespace and pid 300 has no readable link.
const procRoot = path.join(root, "proc");
for (const [entry, namespace] of [
  ["self", "pid:[1]"],
  ["100", "pid:[1]"],
  ["200", "pid:[2]"],
]) {
  fs.mkdirSync(path.join(procRoot, entry, "ns"), { recursive: true });
  fs.symlinkSync(namespace, path.join(procRoot, entry, "ns", "pid"));
}

const process_ = (pid: number, cwd: string, prefix: string) => ({
  pid,
  name: "Game.exe",
  cwd,
  exe: "/usr/bin/wine64-preloader",
  environ: { STEAM_COMPAT_DATA_PATH: prefix },
});
const fakeAddon = path.join(root, "addon.cjs");
fs.writeFileSync(
  fakeAddon,
  `module.exports = { listProcesses: () => ${JSON.stringify([
    process_(100, "/games/Host", "/prefixes/host"),
    process_(200, "/games/Sandboxed", "/home/user/.bashrc.d"),
    process_(300, "/games/Unreadable", "/prefixes/unreadable"),
  ])} };`
);

const ownAddon = path.join(root, "own-addon.cjs");
fs.writeFileSync(
  ownAddon,
  `module.exports = { listProcesses: () => ${JSON.stringify([
    process_(process.pid, "/games/Own", "/prefixes/own"),
  ])} };`
);

const loadNativeAddon = (testWorkerData: Record<string, string>) => {
  const appPath = path.join(root, "app");
  fs.mkdirSync(path.join(appPath, "hydra-native"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "hydra-native", "hydra-native.node"), "");

  class TestWorker extends Worker {
    constructor(code: string, options: { eval: boolean }) {
      super(code, {
        ...options,
        workerData: testWorkerData,
      });
      workers.push(this);
    }
  }

  const modules: Record<string, unknown> = {
    "node:fs": fs,
    "node:path": path,
    "node:module": { createRequire: () => assert.fail("unexpected load") },
    "node:worker_threads": { Worker: TestWorker },
    electron: { app: { isPackaged: false, getAppPath: () => appPath } },
    "./logger": { logger: { error: () => {}, warn: () => {} } },
  };
  const source = fs
    .readFileSync(new URL("./native-addon.ts", import.meta.url), "utf8")
    .replaceAll("import.meta.url", '"file:///native-addon.js"');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ESNext,
      esModuleInterop: true,
    },
  });
  const exports: {
    NativeAddon?: { getSystemProcessMap: () => Promise<ProcessMap | null> };
  } = {};
  new Function("exports", "require", outputText)(
    exports,
    (name: string) => modules[name] ?? assert.fail(`unexpected ${name}`)
  );
  return exports.NativeAddon!;
};

test(
  "path auto-detect and wine prefixes use only launcher pid namespace processes",
  { skip: process.platform !== "linux" },
  async () => {
    const map = await loadNativeAddon({
      addonPath: fakeAddon,
      procRoot,
    }).getSystemProcessMap();
    assert.ok(map);

    // Running-game detection still sees every process.
    assert.deepEqual(map.processMap["game.exe"], [
      "/games/Host/Game.exe",
      "/games/Sandboxed/Game.exe",
      "/games/Unreadable/Game.exe",
    ]);
    assert.deepEqual(
      map.linuxProcesses.map(({ pid }) => pid),
      [100, 200, 300]
    );

    assert.deepEqual(map.autoDetectProcessMap, {
      "game.exe": ["/games/Host/Game.exe"],
    });
    assert.deepEqual(map.winePrefixMap, {
      "/games/Host/Game.exe": "/prefixes/host",
    });
  }
);

test(
  "the real /proc puts the launcher's own process in its pid namespace",
  { skip: process.platform !== "linux" },
  async () => {
    const map = await loadNativeAddon({
      addonPath: ownAddon,
    }).getSystemProcessMap();
    assert.deepEqual(map?.autoDetectProcessMap, {
      "game.exe": ["/games/Own/Game.exe"],
    });
  }
);
