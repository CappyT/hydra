import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";

import * as commandBuilder from "../services/sandbox-command-builder.ts";
import * as sandboxEnv from "./sandbox-env.ts";
import * as sandboxPaths from "./sandbox-paths.ts";

interface WrapCall {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  extraRoBinds?: string[];
}

interface Resolved {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const loadWrapWithSandbox = (options: {
  enabled: boolean;
  dataDir: string;
  hostEnv: Record<string, string>;
  gamescopePath: string | null;
}) => {
  const calls: WrapCall[] = [];
  const modules: Record<string, unknown> = {
    "node:crypto": {},
    "node:fs": fs,
    "node:path": path,
    "@main/services/sandbox": {
      Sandbox: {
        isEnabled: () => options.enabled,
        isAvailable: () => true,
        wrapCommand: (wrap: WrapCall) => {
          calls.push(wrap);
          return { command: "/usr/bin/bwrap", args: ["--", wrap.command] };
        },
      },
    },
    "@main/services/sandbox-command-builder": commandBuilder,
    "@main/services/sandbox-seccomp": {
      resolveSeccomp: () => ({ enabled: false, source: "global" }),
      buildSeccompFilter: () => Buffer.alloc(0),
    },
    "@main/services/sandbox-network": {
      DNS_FORWARD_ADDRESS: "169.254.1.1",
      isNetworkIsolationEnabled: () => false,
      isNetworkIsolationAvailable: () => false,
      resolveHostResolver: () => null,
      resolvePastaPath: () => null,
      resolveSandboxResolvConfDest: () => "/etc/resolv.conf",
    },
    "@main/services/logger": {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
    "@main/constants": {
      sandboxHomesPath: path.join(options.dataDir, "sandbox-homes"),
      sandboxMachineIdsPath: path.join(options.dataDir, "machine-ids"),
      sandboxResolvConfPath: path.join(options.dataDir, "resolv.conf"),
      sandboxSeccompFilterPath: path.join(options.dataDir, "seccomp.bpf"),
    },
    "./sandbox-paths": sandboxPaths,
    "./sandbox-env": sandboxEnv,
    "./resolve-system-binary": {
      resolveSystemBinary: () => options.gamescopePath,
    },
  };
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL("./sandbox-launch.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
      },
    }
  );
  const exports: {
    wrapWithSandbox?: (
      resolved: Resolved,
      context: { gameDir: string; game?: { sandboxExtraPaths?: string[] } }
    ) => Resolved;
  } = {};
  new Function("exports", "require", "process", "Buffer", outputText)(
    exports,
    (name: string) => modules[name] ?? assert.fail(`unexpected ${name}`),
    { platform: "linux", env: options.hostEnv },
    Buffer
  );
  return { wrapWithSandbox: exports.wrapWithSandbox!, calls };
};

describe("wrapWithSandbox", () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let gameDir: string;
  let hostEnv: Record<string, string>;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-launch-"));
    home = path.join(root, "home");
    dataDir = path.join(home, ".config/hydra");
    gameDir = path.join(home, "Games/Some Game");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
    hostEnv = {
      HOME: home,
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      PATH: "/usr/bin",
    };
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const launch = (): Resolved => ({
    command: "gamemoderun",
    args: [path.join(gameDir, "game")],
    env: {
      LD_PRELOAD: path.join(gameDir, "evil.so"),
      XAUTHORITY: path.join(home, ".ssh/id_ed25519"),
      GAMESCOPE_WAYLAND_DISPLAY: "bus",
    },
  });

  it("runs launch variables only inside the payload, never in the host env", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
    });

    const result = wrapWithSandbox(launch(), { gameDir });

    assert.deepEqual(result.env, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, sandboxEnv.SANDBOX_ENV_PATH);
    assert.deepEqual(calls[0].args, [
      `LD_PRELOAD=${path.join(gameDir, "evil.so")}`,
      `XAUTHORITY=${path.join(home, ".ssh/id_ed25519")}`,
      "GAMESCOPE_WAYLAND_DISPLAY=bus",
      "gamemoderun",
      path.join(gameDir, "game"),
    ]);
    // The bind profile reads the host env only: launch variables cannot pick
    // which host files or runtime sockets get bound.
    assert.deepEqual(calls[0].env, hostEnv);
  });

  it("keeps the launch env on the spawn when the sandbox is off", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: false,
      dataDir,
      hostEnv,
      gamescopePath: null,
    });

    const resolved = launch();
    assert.deepEqual(wrapWithSandbox(resolved, { gameDir }), resolved);
    assert.equal(calls.length, 0);
  });

  it("binds the resolved gamescope binary read-only when the launch uses it", () => {
    const gamescopePath = path.join(home, ".local/bin/gamescope");
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath,
    });

    wrapWithSandbox(
      { command: gamescopePath, args: ["-f", "--", "/usr/bin/game"], env: {} },
      { gameDir }
    );
    wrapWithSandbox(
      { command: "/usr/bin/game", args: [], env: {} },
      { gameDir }
    );

    assert.deepEqual(calls[0].extraRoBinds, [gamescopePath]);
    assert.deepEqual(calls[1].extraRoBinds, []);
  });

  it("refuses an unsafe bind with a SandboxUnavailableError", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
    });

    for (const context of [
      { gameDir: "/" },
      { gameDir, game: { sandboxExtraPaths: ["/run/user/1000"] } },
    ])
      assert.throws(
        () => wrapWithSandbox(launch(), context),
        (error: unknown) =>
          error instanceof commandBuilder.SandboxUnavailableError
      );
    assert.equal(calls.length, 0);
  });
});
