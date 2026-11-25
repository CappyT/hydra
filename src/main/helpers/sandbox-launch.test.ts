import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ts from "typescript";

import * as commandBuilder from "../services/sandbox-command-builder.ts";
import * as sandboxEgress from "../services/sandbox-egress.ts";
import * as sandboxPermissions from "../services/sandbox-permissions.ts";
import * as sandboxEnv from "./sandbox-env.ts";
import * as sandboxPaths from "./sandbox-paths.ts";

interface WrapCall {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  extraRoBinds?: string[];
  audio?: { hostSockets: "pulse" | "all" } | { pulseSocket: string };
  cameraDevices?: string[];
  networkIsolation?: {
    egress?: {
      nftPath?: string;
      nftRuleset: string;
      ipPath?: string;
      ipCommands: string[][];
    };
  };
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
  /** Trusted tools by name; absent = `/usr/bin/<name>`, null = not installed. */
  tools?: Record<string, string | null>;
  networkIsolation?: boolean;
  ipAddrJson?: string | null;
  audioFails?: boolean;
  cameras?: string[];
}) => {
  const calls: WrapCall[] = [];
  const resolveTool = (names: string[]): string | null => {
    const [name] = names;
    if (name === "gamescope") return options.gamescopePath;
    return options.tools && name in options.tools
      ? options.tools[name]
      : `/usr/bin/${name}`;
  };
  const modules: Record<string, unknown> = {
    "node:crypto": {},
    "node:child_process": {
      spawnSync: () =>
        options.ipAddrJson === null
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: options.ipAddrJson ?? "[]" },
    },
    "@main/services/sandbox-egress": sandboxEgress,
    "@main/services/sandbox-permissions": sandboxPermissions,
    "@main/services/sandbox-audio": {
      ensureFilteredPulseSocket: (audio: { directory: string }) => {
        if (options.audioFails) throw new Error("no pipewire");
        return path.join(audio.directory, "native");
      },
    },
    "@main/services/sandbox-input": {
      listSandboxCameraDevices: () => options.cameras ?? [],
    },
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
      isNetworkIsolationEnabled: () => options.networkIsolation === true,
      isNetworkIsolationAvailable: () => options.networkIsolation === true,
      resolveHostResolver: () => null,
      resolvePastaPath: () =>
        options.networkIsolation ? "/usr/bin/pasta" : null,
      resolveSandboxResolvConfDest: () => "/etc/resolv.conf",
    },
    "@main/services/logger": {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
    "@main/constants": {
      sandboxAudioPath: path.join(options.dataDir, "sandbox-audio"),
      sandboxHomesPath: path.join(options.dataDir, "sandbox-homes"),
      sandboxMachineIdsPath: path.join(options.dataDir, "machine-ids"),
      sandboxResolvConfPath: path.join(options.dataDir, "resolv.conf"),
      sandboxSeccompFilterPath: path.join(options.dataDir, "seccomp.bpf"),
    },
    "./sandbox-paths": sandboxPaths,
    "./sandbox-env": sandboxEnv,
    "./resolve-system-binary": { resolveSystemBinary: resolveTool },
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
      context: {
        gameDir: string;
        userPreferences?: Record<string, unknown>;
        game?: Record<string, unknown>;
      }
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
  it("gives the filtered audio endpoint unless the microphone is allowed", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
    });

    wrapWithSandbox(launch(), { gameDir });
    wrapWithSandbox(launch(), { gameDir, game: { allowMicrophone: true } });
    wrapWithSandbox(launch(), {
      gameDir,
      userPreferences: { allowMicrophone: true },
      game: { allowMicrophone: false },
    });

    const filtered = {
      pulseSocket: path.join(dataDir, "sandbox-audio", "native"),
    };
    assert.deepEqual(calls[0].audio, filtered);
    assert.deepEqual(calls[1].audio, { hostSockets: "pulse" });
    assert.deepEqual(calls[2].audio, filtered);
  });

  it("gives the session PipeWire socket only with microphone and camera", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
    });

    wrapWithSandbox(launch(), {
      gameDir,
      game: { allowMicrophone: true, allowCamera: true },
    });
    wrapWithSandbox(launch(), { gameDir, game: { allowCamera: true } });

    assert.deepEqual(calls[0].audio, { hostSockets: "all" });
    assert.deepEqual(calls[1].audio, {
      pulseSocket: path.join(dataDir, "sandbox-audio", "native"),
    });
  });

  it("refuses the launch when the filtered audio endpoint cannot start", () => {
    for (const broken of [
      { audioFails: true },
      { tools: { "pipewire-pulse": null } },
    ]) {
      const { wrapWithSandbox, calls } = loadWrapWithSandbox({
        enabled: true,
        dataDir,
        hostEnv,
        gamescopePath: null,
        ...broken,
      });

      assert.throws(
        () => wrapWithSandbox(launch(), { gameDir }),
        (error: unknown) =>
          error instanceof commandBuilder.SandboxUnavailableError
      );
      // The explicit permission is the only way to the session sockets.
      wrapWithSandbox(launch(), { gameDir, game: { allowMicrophone: true } });
      assert.deepEqual(calls.at(-1)?.audio, { hostSockets: "pulse" });
    }
  });

  it("exposes camera devices only with the camera permission", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
      cameras: ["/dev/video0"],
    });

    wrapWithSandbox(launch(), { gameDir });
    wrapWithSandbox(launch(), { gameDir, game: { allowCamera: true } });

    assert.deepEqual(calls[0].cameraDevices, []);
    assert.deepEqual(calls[1].cameraDevices, ["/dev/video0"]);
  });

  it("always blocks the host addresses and blocks the LAN without the permission", () => {
    const ipAddrJson = JSON.stringify([
      {
        ifname: "docker0",
        addr_info: [{ family: "inet", local: "172.17.0.1", prefixlen: 16 }],
      },
    ]);
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
      networkIsolation: true,
      ipAddrJson,
    });

    wrapWithSandbox(launch(), { gameDir });
    wrapWithSandbox(launch(), { gameDir, game: { allowLocalNetwork: true } });

    const denied = calls[0].networkIsolation?.egress;
    const allowed = calls[1].networkIsolation?.egress;
    assert.equal(denied?.nftPath, "/usr/bin/nft");
    assert.equal(denied?.ipPath, "/usr/bin/ip");
    for (const egress of [denied, allowed]) {
      assert.match(egress!.nftRuleset, /ip daddr 172\.17\.0\.1\/32 reject/);
    }
    assert.match(denied!.nftRuleset, /ip daddr 192\.168\.0\.0\/16 reject/);
    assert.doesNotMatch(allowed!.nftRuleset, /192\.168\.0\.0\/16/);
  });

  it("refuses an isolated launch when the host addresses cannot be read", () => {
    for (const broken of [
      { ipAddrJson: null },
      { ipAddrJson: "not json" },
      { ipAddrJson: "{}" },
      { tools: { ip: null } },
    ]) {
      const { wrapWithSandbox, calls } = loadWrapWithSandbox({
        enabled: true,
        dataDir,
        hostEnv,
        gamescopePath: null,
        networkIsolation: true,
        ...broken,
      });

      assert.throws(
        () => wrapWithSandbox(launch(), { gameDir }),
        (error: unknown) =>
          error instanceof commandBuilder.SandboxUnavailableError
      );
      assert.equal(calls.length, 0);
    }
  });

  it("uses the ip-rule rendering alone when nft is not installed", () => {
    const { wrapWithSandbox, calls } = loadWrapWithSandbox({
      enabled: true,
      dataDir,
      hostEnv,
      gamescopePath: null,
      networkIsolation: true,
      tools: { nft: null },
    });

    wrapWithSandbox(launch(), { gameDir });

    const egress = calls[0].networkIsolation?.egress;
    assert.equal(egress?.nftPath, undefined);
    assert.equal(egress?.ipPath, "/usr/bin/ip");
    assert.ok(egress!.ipCommands.length > 0);
  });
});
