import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { app } from "electron";
import { is } from "@electron-toolkit/utils";
import { SystemPath } from "./system-path";
import { logsPath } from "@main/constants";
import { logger } from "./logger";
import type { Game, ProtonVersion, UserPreferences } from "@types";
import { resolveLaunchCommand } from "@main/helpers/resolve-launch-command";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "@main/helpers/sandbox-launch";
import { buildSandboxEnv } from "@main/helpers/sandbox-env";
import { resolveSystemBinary } from "@main/helpers/resolve-system-binary";
import { isWaylandSessionAvailable } from "@main/helpers/is-gamescope-available";
import { buildGamescopeWrapper } from "@main/helpers/resolve-gamescope-wrapper";
import { Sandbox } from "./sandbox";
import { evaluateUmuPrefixPreparation } from "./umu-prefix-preparation";
import { Wine } from "./wine";
import { getSteamLibraryFolders } from "./steam";
import {
  UmuEarlyExitError,
  observeUmuLaunch,
  watchUmuSetup,
  type UmuStatusListener,
} from "./umu-launch-monitor";
import { getFileSize } from "./umu-output-monitor";
import { spawnSupervisedUmu } from "./umu-supervised-process";
import supervisedRuntimeManifest from "../../shared/epic-linux-runtime-manifest.json";
export type { UmuProcessHandle } from "./umu-supervised-process";

export type { UmuStatus } from "./umu-launch-monitor";

const isValidProtonDirectory = (directoryPath: string) => {
  const protonFilePath = path.join(directoryPath, "proton");
  const toolManifestPath = path.join(directoryPath, "toolmanifest.vdf");

  return fs.existsSync(protonFilePath) && fs.existsSync(toolManifestPath);
};

const getVersionName = (directoryPath: string) => {
  return path.basename(directoryPath);
};

const getSharedUmuLogPath = () => path.join(logsPath, "umu.log");

const getUmuLogPath = (gameId?: string | null) =>
  gameId
    ? path.join(logsPath, `umu-${gameId.replaceAll(/[^\w.-]/g, "_")}.log`)
    : getSharedUmuLogPath();

const appendUmuLogHeader = (umuLogPath: string, header: string) => {
  fs.appendFileSync(umuLogPath, header);
  const sharedLogPath = getSharedUmuLogPath();
  if (umuLogPath !== sharedLogPath) {
    fs.appendFileSync(
      sharedLogPath,
      `${header.trimEnd()}\nOutput: ${path.basename(umuLogPath)}\n`
    );
  }
};

const getBundledUmuBinaryPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "umu-run")
    : path.join(__dirname, "..", "..", "binaries", "umu", "umu-run");

const getUmuBinaryPath = () => {
  // Prefer a system-installed umu-run (e.g. Fedora's umu-launcher package),
  // falling back to the copy fetched into binaries/umu at build time.
  return resolveSystemBinary(["umu-run"]) ?? getBundledUmuBinaryPath();
};

const parsePythonVersion = (versionText: string): [number, number] | null => {
  const match = versionText.trim().match(/^(\d+)\.(\d+)$/);
  if (!match) return null;

  return [Number(match[1]), Number(match[2])];
};

const hasSupportedPythonVersion = (version: [number, number]) => {
  const [major, minor] = version;
  return major > 3 || (major === 3 && minor >= 10);
};

const getCompatiblePythonPath = (): string | null => {
  const candidates = [
    process.env.HYDRA_UMU_PYTHON,
    "/usr/bin/python3",
    "python3",
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      const result = spawnSync(
        candidate,
        [
          "-c",
          "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
          shell: false,
        }
      );

      if (result.status !== 0) continue;

      const version = parsePythonVersion(result.stdout);
      if (!version || !hasSupportedPythonVersion(version)) continue;

      return candidate;
    } catch {
      continue;
    }
  }

  return null;
};

const ensureExecutablePermission = (binaryPath: string) => {
  if (process.platform === "win32") return;

  try {
    const currentMode = fs.statSync(binaryPath).mode;
    const hasAnyExecuteBit = (currentMode & 0o111) !== 0;

    if (!hasAnyExecuteBit) {
      fs.chmodSync(binaryPath, 0o755);
    }
  } catch (error) {
    logger.warn("Failed to ensure umu-run executable permission", {
      binaryPath,
      error,
    });
  }
};

const STEAM_ROOT_SEGMENTS = [
  [".steam", "steam"],
  [".local", "share", "Steam"],
  [".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"],
  [".var", "app", "com.valvesoftware.Steam", "data", "Steam"],
  ["snap", "steam", "common", ".local", "share", "Steam"],
];

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Umu {
  /** Authenticated integrations use a bounded, private process API. */
  public static launchSupervised = spawnSupervisedUmu;

  /** Only the bundled version has a validated bootstrap protocol today. */
  public static getSupervisedBinaryPath() {
    return getBundledUmuBinaryPath();
  }

  public static getSupervisedRuntime() {
    return {
      binaryPath: getBundledUmuBinaryPath(),
      version: supervisedRuntimeManifest.umu.version,
      sha256: supervisedRuntimeManifest.umu.sha256,
    };
  }

  public static isValidProtonPath(protonPath: string) {
    return isValidProtonDirectory(protonPath);
  }

  public static async getInstalledProtonVersions(): Promise<ProtonVersion[]> {
    const homePath = SystemPath.getPath("home");
    const steamRoots = STEAM_ROOT_SEGMENTS.map((segments) =>
      path.join(homePath, ...segments)
    );
    const libraryFolders = await getSteamLibraryFolders().catch(() => []);

    const steamCommonPaths = [
      ...new Set(
        [...steamRoots, ...libraryFolders].map((root) =>
          path.join(root, "steamapps", "common")
        )
      ),
    ];
    const compatibilityToolPaths = [
      ...steamRoots.map((root) => path.join(root, "compatibilitytools.d")),
      path.join("/usr", "share", "steam", "compatibilitytools.d"),
    ];

    const versions: ProtonVersion[] = [];

    for (const steamCommonPath of steamCommonPaths) {
      if (!fs.existsSync(steamCommonPath)) {
        continue;
      }

      const steamCommonEntries = await fs.promises
        .readdir(steamCommonPath, { withFileTypes: true })
        .catch(() => [] as fs.Dirent[]);

      for (const entry of steamCommonEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith("Proton")) {
          continue;
        }

        const candidatePath = path.join(steamCommonPath, entry.name);

        if (!isValidProtonDirectory(candidatePath)) {
          continue;
        }

        const realPath = await fs.promises.realpath(candidatePath);

        versions.push({
          name: getVersionName(realPath),
          path: realPath,
          source: "steam",
        });
      }
    }

    for (const compatibilityToolPath of compatibilityToolPaths) {
      if (!fs.existsSync(compatibilityToolPath)) {
        continue;
      }

      const compatibilityToolEntries = await fs.promises
        .readdir(compatibilityToolPath, { withFileTypes: true })
        .catch(() => [] as fs.Dirent[]);

      for (const entry of compatibilityToolEntries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const candidatePath = path.join(compatibilityToolPath, entry.name);

        if (!isValidProtonDirectory(candidatePath)) {
          continue;
        }

        const realPath = await fs.promises.realpath(candidatePath);

        versions.push({
          name: getVersionName(realPath),
          path: realPath,
          source: "compatibility_tools",
        });
      }
    }

    const uniqueVersions = new Map<string, ProtonVersion>();

    for (const version of versions) {
      uniqueVersions.set(version.path, version);
    }

    return Array.from(uniqueVersions.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  public static async preparePrefix(options: {
    winePrefixPath: string;
    protonPath?: string | null;
    gameId?: string | null;
    onStatus?: UmuStatusListener;
  }): Promise<void> {
    const umuLogPath = getUmuLogPath(options.gameId);
    const umuBinaryPath = getUmuBinaryPath();
    const pythonPath = getCompatiblePythonPath();
    const command = pythonPath ?? umuBinaryPath;
    const args = pythonPath
      ? [umuBinaryPath, "createprefix"]
      : ["createprefix"];
    const launchEnv = {
      PROTON_LOG: "1",
      WINEPREFIX: options.winePrefixPath,
      ...(options.gameId ? { GAMEID: `umu-${options.gameId}` } : {}),
      ...(options.protonPath ? { PROTONPATH: options.protonPath } : {}),
    };

    fs.mkdirSync(path.dirname(umuLogPath), { recursive: true });
    fs.mkdirSync(path.dirname(options.winePrefixPath), { recursive: true });
    ensureExecutablePermission(umuBinaryPath);
    appendUmuLogHeader(
      umuLogPath,
      `\n[${new Date().toISOString()}] Preparing Wine prefix with umu-run\n`
    );

    logger.info("Preparing Wine prefix with umu-run", {
      command,
      args,
      env: launchEnv,
      umuLogPath,
    });

    await new Promise<void>((resolve, reject) => {
      const shouldPipeToTerminal = is.dev;
      const logFileDescriptor = shouldPipeToTerminal
        ? null
        : fs.openSync(umuLogPath, "a");
      let settled = false;
      const setupWatcher = watchUmuSetup(
        shouldPipeToTerminal ? null : umuLogPath,
        options.onStatus
      );

      const closeLogFileDescriptor = () => {
        if (!settled && logFileDescriptor !== null) {
          fs.closeSync(logFileDescriptor);
        }
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        closeLogFileDescriptor();
        settled = true;
        callback();
      };
      const child = spawn(command, args, {
        detached: false,
        stdio: shouldPipeToTerminal
          ? "inherit"
          : ["ignore", logFileDescriptor, logFileDescriptor],
        shell: false,
        cwd: SystemPath.getPath("home"),
        env: {
          ...process.env,
          ...launchEnv,
        },
      });

      child.once("error", (error) => {
        setupWatcher.complete();
        finish(() => {
          logger.error("Failed to start umu-run prefix preparation", {
            errorName: error.name,
            errorMessage: error.message,
            umuLogPath,
          });
          reject(error);
        });
      });
      child.once("close", (code, signal) => {
        const setup = setupWatcher.complete();
        finish(() => {
          let prefixValid = false;

          try {
            prefixValid = Wine.validatePrefix(options.winePrefixPath);
          } catch {
            prefixValid = false;
          }

          const evaluation = evaluateUmuPrefixPreparation(
            code,
            signal,
            prefixValid
          );
          if (evaluation.success) {
            if (evaluation.acceptedNonZeroExit) {
              logger.warn(
                "umu-run returned a non-zero exit after preparing a valid prefix",
                {
                  code,
                  signal,
                  prefixValid,
                  umuLogPath,
                }
              );
            }
            resolve();
            return;
          }

          const errorMessage = setup.failureMessage
            ? `${evaluation.errorMessage}: ${setup.failureMessage}`
            : evaluation.errorMessage;
          logger.error("umu-run failed to prepare a valid Wine prefix", {
            code,
            signal,
            prefixValid,
            umuLogPath,
            errorMessage,
          });
          reject(new Error(errorMessage));
        });
      });
    });
  }

  public static async launchExecutable(
    executablePath: string,
    launchParameters: string[] = [],
    options?: {
      winePrefixPath?: string | null;
      protonPath?: string | null;
      gameId?: string | null;
      launchOptions?: string | null;
      useMangohud?: boolean;
      useGamemode?: boolean;
      useGamescope?: boolean;
      userPreferences?: UserPreferences | null;
      sandboxGame?: Pick<
        Game,
        "sandboxDisabled" | "sandboxExtraPaths" | "sandboxShareIpc"
      > | null;
      sandboxGameKey?: string | null;
      onStatus?: UmuStatusListener;
      wasGameDetected?: () => boolean;
    }
  ): Promise<number | null> {
    const QUICK_EXIT_THRESHOLD_MS = 3000;
    const workingDirectory = path.dirname(executablePath);
    const umuLogPath = getUmuLogPath(options?.gameId);
    const umuBinaryPath = getUmuBinaryPath();
    const pythonPath = getCompatiblePythonPath();
    const executableToSpawn = pythonPath ?? umuBinaryPath;
    const executableArgs = pythonPath
      ? [umuBinaryPath, executablePath, ...launchParameters]
      : [executablePath, ...launchParameters];

    // umu's Steam-Linux-Runtime is itself a bwrap container and cannot be
    // nested inside our sandbox; disable it so Proton runs directly.
    const sandboxEnabled = Sandbox.isEnabled(
      options?.userPreferences,
      options?.sandboxGame
    );

    const resolvedLaunchCommand = wrapWithSandbox(
      resolveLaunchCommand({
        baseCommand: executableToSpawn,
        baseArgs: executableArgs,
        launchOptions: options?.launchOptions,
        // MangoHud is applied via the MANGOHUD=1 env var below (not a wrapper),
        // so only gamemode and gamescope wrap the command here.
        wrapperCommands: [
          ...(options?.useGamemode ? ["gamemoderun"] : []),
          ...(options?.useGamescope ? [buildGamescopeWrapper()] : []),
        ],
      }),
      {
        userPreferences: options?.userPreferences,
        game: options?.sandboxGame,
        gameKey: options?.sandboxGameKey,
        gameDir: workingDirectory,
        winePrefix: options?.winePrefixPath,
        protonDir: options?.protonPath,
        // The bundled umu-run zipapp lives under the AppImage mount in /tmp
        // (or the repo checkout under /home in dev), both hidden by the
        // sandbox tmpfs mounts — re-expose it read-only.
        additionalRoBinds: [umuBinaryPath],
        hideX11: Boolean(options?.useGamescope) && isWaylandSessionAvailable(),
      }
    );

    fs.mkdirSync(path.dirname(umuLogPath), { recursive: true });
    ensureExecutablePermission(umuBinaryPath);

    const launchEnv = {
      PROTON_LOG: "1",
      ...(options?.gameId ? { GAMEID: `umu-${options.gameId}` } : {}),
      ...(options?.winePrefixPath
        ? { WINEPREFIX: options.winePrefixPath }
        : {}),
      ...(options?.protonPath ? { PROTONPATH: options.protonPath } : {}),
      ...(options?.useMangohud ? { MANGOHUD: "1" } : {}),
      ...(sandboxEnabled ? { UMU_NO_RUNTIME: "1" } : {}),
      ...resolvedLaunchCommand.env,
    };

    const envCommandPart = Object.entries(launchEnv)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const argsCommandPart = resolvedLaunchCommand.args
      .map(shellQuote)
      .join(" ");
    const launchCommand = `${envCommandPart} ${shellQuote(resolvedLaunchCommand.command)}${
      argsCommandPart ? ` ${argsCommandPart}` : ""
    }`;

    const launchHeader =
      `\n[${new Date().toISOString()}] Launching with umu-run\n` +
      `Command: ${launchCommand}\n`;

    appendUmuLogHeader(umuLogPath, launchHeader);

    logger.info("Launching game with umu-run", {
      command: launchCommand,
      umuBinaryPath,
      pythonPath,
      cwd: workingDirectory,
      env: launchEnv,
      umuLogPath,
    });

    const shouldPipeToTerminal = is.dev;
    const logStartOffset = getFileSize(umuLogPath);
    const logFileDescriptor = shouldPipeToTerminal
      ? null
      : fs.openSync(umuLogPath, "a");
    const seccompFd = openSeccompFd(resolvedLaunchCommand);

    try {
      const child = spawn(
        resolvedLaunchCommand.command,
        resolvedLaunchCommand.args,
        {
          detached: true,
          stdio: shouldPipeToTerminal
            ? withSeccompStdio(["inherit", "inherit", "inherit"], seccompFd)
            : withSeccompStdio(
                ["ignore", logFileDescriptor, logFileDescriptor],
                seccompFd
              ),
          shell: false,
          cwd: workingDirectory,
          // Scrub the inherited env to an allowlist when sandboxed so the game
          // cannot read the user's secrets from /proc/self/environ, then re-apply
          // the launch's explicit env on top. When the sandbox is disabled for
          // this game, keep the full inherited env (escape hatch).
          env: {
            ...(sandboxEnabled ? buildSandboxEnv(process.env) : process.env),
            ...launchEnv,
          },
        }
      );

      await observeUmuLaunch({
        child,
        umuLogPath: shouldPipeToTerminal ? null : umuLogPath,
        logStartOffset,
        quickExitThresholdMs: QUICK_EXIT_THRESHOLD_MS,
        onStatus: options?.onStatus,
        wasGameDetected: options?.wasGameDetected,
        onLateFailure: (failure) =>
          logger.error("umu-run failed after the game launch started", {
            ...failure,
            umuLogPath,
          }),
      });
      child.unref();
      return child.pid ?? null;
    } catch (error) {
      const logLine =
        error instanceof UmuEarlyExitError
          ? error.message
          : `Failed to spawn umu-run (${resolvedLaunchCommand.command}): ${String(error)}`;
      fs.appendFileSync(
        umuLogPath,
        `[${new Date().toISOString()}] ${logLine}\n`
      );
      throw error;
    } finally {
      if (logFileDescriptor !== null) fs.closeSync(logFileDescriptor);
      closeSeccompFd(seccompFd);
    }
  }
}
