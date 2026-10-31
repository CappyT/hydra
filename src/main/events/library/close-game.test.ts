import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const EXECUTABLE = "/games/Some Game/game";

const loadCloseGame = (killError: NodeJS.ErrnoException | null) => {
  let handler!: (...args: unknown[]) => Promise<void>;
  const sudoCommands: string[] = [];
  const killed: number[] = [];
  const modules: Record<string, unknown> = {
    "../register-event": {
      registerEvent: (_name: string, callback: typeof handler) => {
        handler = callback;
      },
    },
    "@main/services": {
      emulators: { closeEmulatorSession: () => false },
      launchedGamePids: new Map(),
      sandboxedGamePids: new Set(),
      logger: { error: () => {} },
      Sandbox: { killSandboxTree: () => {} },
      Wine: { getEffectivePrefixPath: () => null },
      clearGameLaunching: () => {},
    },
    "sudo-prompt": {
      exec: (command: string) => {
        sudoCommands.push(command);
      },
    },
    electron: { app: { getName: () => "Hydra" } },
    "@main/level": {
      gamesSublevel: { get: async () => ({ executablePath: EXECUTABLE }) },
      levelKeys: { game: (shop: string, id: string) => `${shop}:${id}` },
    },
    "@types": {},
    "node:path": path,
    "@main/services/native-addon": {
      NativeAddon: {
        listProcesses: async () => [{ pid: 4242, exe: EXECUTABLE }],
      },
    },
    "@main/services/linux-process-match": {
      processReferencesExecutable: (
        running: { exe?: string },
        target: string
      ) => running.exe === target,
    },
    "@main/helpers/windows-batch-command": { isWindowsBatchFile: () => false },
  };
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL("./close-game.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
      },
    }
  );
  new Function("exports", "require", "process", outputText)(
    {},
    (name: string) => modules[name] ?? assert.fail(`unexpected ${name}`),
    {
      platform: "linux",
      kill: (pid: number) => {
        killed.push(pid);
        if (killError) throw killError;
      },
    }
  );
  return {
    close: () => handler({}, "custom", "some-game"),
    sudoCommands,
    killed,
  };
};

const errno = (code: string) =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;

test("closeGame does not escalate to a root kill for an already reaped process", async () => {
  const fixture = loadCloseGame(errno("ESRCH"));
  await fixture.close();
  assert.deepEqual(fixture.killed, [4242]);
  assert.deepEqual(fixture.sudoCommands, []);
});

test("closeGame still escalates when the kill is not permitted", async () => {
  const fixture = loadCloseGame(errno("EPERM"));
  await fixture.close();
  assert.deepEqual(fixture.sudoCommands, ["kill -9 4242"]);
});
