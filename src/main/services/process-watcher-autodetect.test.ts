import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

import { updateGameExecutablePath } from "../helpers/update-executable-path.ts";
import { isValidProcessWatcherScan } from "./process-watcher-scan.ts";

type StoredGame = Record<string, unknown>;

// Any module the tick does not reach: every property is a no-op function.
const stub: unknown = new Proxy(() => undefined, {
  get: (_target, property) => (property === "__esModule" ? false : stub),
});

const loadWatcher = (systemProcessMap: Record<string, unknown>) => {
  const game: StoredGame = {
    shop: "steam",
    objectId: "42",
    executablePath: null,
    winePrefixPath: null,
    isDeleted: false,
  };
  const stored = new Map<string, StoredGame>([["steam:42", game]]);
  const gamesPlaytime = new Map();
  const modules: Record<string, unknown> = {
    "node:path": path,
    "@main/level": {
      db: stub,
      levelKeys: { game: (shop: string, id: string) => `${shop}:${id}` },
      gamesSublevel: {
        values: () => ({ all: async () => [...stored.values()] }),
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: StoredGame) => {
          stored.set(key, value);
        },
      },
    },
    "./game-executables": {
      GameExecutables: {
        ensureLoaded: async () => true,
        getExecutablesForGame: () => [{ exe: "game.exe", name: "/game.exe" }],
      },
    },
    "./native-addon": {
      NativeAddon: { getSystemProcessMap: async () => systemProcessMap },
    },
    "./process-watcher-scan": {
      isValidProcessWatcherScan,
      startOptionalExecutableCatalogueLoad: () => {},
    },
    "@main/helpers/update-executable-path": { updateGameExecutablePath },
    "./game-running-state": {
      gamesPlaytime,
      getTrackedGamesRunning: () => [],
      recompilationGameSessions: new Map(),
      isGameRunning: () => false,
    },
    "./emulators/emulator-session-tracker": { emulatorSessions: new Map() },
    "./launched-game-pids": {
      launchedGamePids: new Map(),
      sandboxedGamePids: new Set(),
    },
  };
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL("./process-watcher.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
      },
    }
  );
  const exports: { watchProcesses?: () => Promise<void> } = {};
  new Function("exports", "require", "process", outputText)(
    exports,
    (name: string) => (name in modules ? modules[name] : stub),
    { platform: "linux", env: {} }
  );
  return {
    watchProcesses: exports.watchProcesses!,
    game: () => stored.get("steam:42")!,
  };
};

test("a sandboxed process cannot set a game's executable path or prefix", async () => {
  const watcher = loadWatcher({
    processMap: { "game.exe": ["/sandbox/game.exe"] },
    autoDetectProcessMap: {},
    winePrefixMap: { "/sandbox/game.exe": "/home/user/.bashrc.d" },
    linuxProcesses: [],
    processTree: [],
  });

  await watcher.watchProcesses();

  assert.equal(watcher.game().executablePath, null);
  assert.equal(watcher.game().winePrefixPath, null);
});

test("a launcher-namespace process sets the executable path but never the prefix", async () => {
  const watcher = loadWatcher({
    processMap: { "game.exe": ["/games/Game/game.exe"] },
    autoDetectProcessMap: { "game.exe": ["/games/Game/game.exe"] },
    winePrefixMap: { "/games/Game/game.exe": "/home/user/.bashrc.d" },
    linuxProcesses: [],
    processTree: [],
  });

  await watcher.watchProcesses();

  assert.equal(watcher.game().executablePath, "/games/Game/game.exe");
  assert.equal(watcher.game().winePrefixPath, null);
});
