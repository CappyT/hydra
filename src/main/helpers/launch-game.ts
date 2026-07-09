import { shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GameShop, type Game, type UserPreferences } from "@types";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { updateGameExecutablePath } from "./update-executable-path";
import {
  WindowManager,
  logger,
  Umu,
  PowerSaveBlockerManager,
  Wine,
  NativeAddon,
  launchedGamePids,
  sandboxedGamePids,
  Sandbox,
  CloudSync,
  markGameLaunching,
} from "@main/services";
import { CommonRedistManager } from "@main/services/common-redist-manager";
import { parseExecutablePath } from "../events/helpers/parse-executable-path";
import { isGamemodeAvailable } from "./is-gamemode-available";
import { isMangohudAvailable } from "./is-mangohud-available";
import {
  isGamescopeAvailable,
  isGamescopeSessionActive,
  isWaylandSessionAvailable,
} from "./is-gamescope-available";
import { buildGamescopeWrapper } from "./resolve-gamescope-wrapper";
import { resolveLaunchCommand } from "./resolve-launch-command";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "./sandbox-launch";
import { buildSandboxEnv } from "./sandbox-env";
import {
  buildWindowsBatchCommand,
  isWindowsBatchFile,
} from "./windows-batch-command";

export interface LaunchGameOptions {
  shop: GameShop;
  objectId: string;
  executablePath: string;
  launchOptions?: string | null;
}

const isWindowsExecutable = (executablePath: string) =>
  path.extname(executablePath).toLowerCase() === ".exe";

const ensureExecutablePermission = (executablePath: string) => {
  try {
    const currentMode = fs.statSync(executablePath).mode;
    const hasOwnerExecuteBit = (currentMode & 0o100) !== 0;

    if (!hasOwnerExecuteBit) {
      fs.chmodSync(executablePath, currentMode | 0o100);
    }
  } catch (error) {
    logger.warn("Failed to ensure executable permission", {
      executablePath,
      error,
    });
  }
};

interface SandboxLaunchInput {
  userPreferences?: UserPreferences | null;
  game?: Game | null;
  gameKey?: string;
}

const launchNatively = (
  executablePath: string,
  launchOptions?: string | null,
  useMangohud = false,
  useGamemode = false,
  useGamescope = false,
  sandbox?: SandboxLaunchInput
): number | null => {
  const workingDirectory = path.dirname(executablePath);
  const sandboxEnabled = Sandbox.isEnabled(
    sandbox?.userPreferences,
    sandbox?.game
  );
  const resolvedLaunchCommand = wrapWithSandbox(
    resolveLaunchCommand({
      baseCommand: executablePath,
      launchOptions,
      wrapperCommands: [
        ...(useGamemode ? ["gamemoderun"] : []),
        ...(useGamescope ? [buildGamescopeWrapper()] : []),
        ...(useMangohud ? ["mangohud"] : []),
      ],
    }),
    {
      userPreferences: sandbox?.userPreferences,
      game: sandbox?.game,
      gameKey: sandbox?.gameKey,
      gameDir: workingDirectory,
      hideX11: useGamescope && isWaylandSessionAvailable(),
    }
  );

  if (process.platform === "linux") {
    ensureExecutablePermission(executablePath);
  } else if (
    resolvedLaunchCommand.command === executablePath &&
    resolvedLaunchCommand.args.length === 0 &&
    Object.keys(resolvedLaunchCommand.env).length === 0
  ) {
    shell.openPath(executablePath);
    return null;
  }

  if (
    process.platform === "win32" &&
    isWindowsBatchFile(resolvedLaunchCommand.command)
  ) {
    const processRef = spawn(
      buildWindowsBatchCommand(
        resolvedLaunchCommand.command,
        resolvedLaunchCommand.args
      ),
      {
        shell: true,
        detached: true,
        stdio: "ignore",
        cwd: workingDirectory,
        // See the general spawn below: scrub the inherited env when sandboxed.
        env: {
          ...(sandboxEnabled ? buildSandboxEnv(process.env) : process.env),
          ...resolvedLaunchCommand.env,
        },
      }
    );

    processRef.on("error", (error) => {
      logger.error("Failed to launch game", error);
    });

    processRef.unref();

    return processRef.pid ?? null;
  }

  const seccompFd = openSeccompFd(resolvedLaunchCommand);
  const processRef = spawn(
    resolvedLaunchCommand.command,
    resolvedLaunchCommand.args,
    {
      shell: false,
      detached: true,
      stdio: withSeccompStdio(["ignore", "ignore", "ignore"], seccompFd),
      cwd: workingDirectory,
      // Scrub the inherited env to an allowlist when sandboxed so the game
      // cannot read the user's secrets from /proc/self/environ, then re-apply
      // the launch's explicit env. Full env is kept when the sandbox is off.
      env: {
        ...(sandboxEnabled ? buildSandboxEnv(process.env) : process.env),
        ...resolvedLaunchCommand.env,
      },
    }
  );

  processRef.on("error", (error) => {
    logger.error("Failed to launch game", error);
  });

  processRef.unref();
  // The child inherited its own dup at fd 3; closing this copy is now safe.
  closeSeccompFd(seccompFd);

  return processRef.pid ?? null;
};

const launchWithWine = async (
  executablePath: string,
  launchOptions?: string | null,
  useMangohud = false,
  useGamemode = false,
  useGamescope = false,
  sandbox?: SandboxLaunchInput & {
    winePrefix?: string | null;
    gameKey?: string;
  }
): Promise<boolean> => {
  const workingDirectory = path.dirname(executablePath);
  const winePrefix = sandbox?.winePrefix;
  const sandboxEnabled = Sandbox.isEnabled(
    sandbox?.userPreferences,
    sandbox?.game
  );

  // Point wine at the per-game prefix so this fallback reads/writes the same
  // prefix as the umu path; without this, bare wine defaults to ~/.wine (or the
  // ephemeral sandbox-home default).
  if (winePrefix) {
    fs.mkdirSync(winePrefix, { recursive: true });
  }

  const resolvedLaunchCommand = wrapWithSandbox(
    resolveLaunchCommand({
      baseCommand: "wine",
      baseArgs: [executablePath],
      launchOptions,
      wrapperCommands: [
        ...(useGamemode ? ["gamemoderun"] : []),
        ...(useGamescope ? [buildGamescopeWrapper()] : []),
        ...(useMangohud ? ["mangohud"] : []),
      ],
    }),
    {
      userPreferences: sandbox?.userPreferences,
      game: sandbox?.game,
      gameKey: sandbox?.gameKey,
      gameDir: workingDirectory,
      winePrefix,
      hideX11: useGamescope && isWaylandSessionAvailable(),
    }
  );

  const seccompFd = openSeccompFd(resolvedLaunchCommand);
  try {
    return await new Promise<boolean>((resolve) => {
      const processRef = spawn(
        resolvedLaunchCommand.command,
        resolvedLaunchCommand.args,
        {
          shell: false,
          detached: true,
          stdio: withSeccompStdio(["ignore", "ignore", "ignore"], seccompFd),
          cwd: workingDirectory,
          // Scrub the inherited env to an allowlist when sandboxed so the game
          // cannot read the user's secrets from /proc/self/environ, then
          // re-apply the prefix and launch env. Full env kept when sandbox off.
          env: {
            ...(sandboxEnabled ? buildSandboxEnv(process.env) : process.env),
            ...(winePrefix ? { WINEPREFIX: winePrefix } : {}),
            ...resolvedLaunchCommand.env,
          },
        }
      );

      processRef.once("spawn", () => {
        if (processRef.pid && sandbox?.gameKey && sandboxEnabled) {
          launchedGamePids.set(sandbox.gameKey, processRef.pid);
          sandboxedGamePids.add(sandbox.gameKey);
        }

        processRef.unref();
        resolve(true);
      });

      processRef.once("error", (error) => {
        logger.error("Failed to launch game with Wine", error);
        resolve(false);
      });
    });
  } finally {
    // The child inherited its own dup at fd 3 once spawn returned; release ours.
    closeSeccompFd(seccompFd);
  }
};

const resolveProtonPathForLaunch = async (
  gameProtonPath?: string | null
): Promise<string | null> => {
  if (gameProtonPath && Umu.isValidProtonPath(gameProtonPath)) {
    return gameProtonPath;
  }

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const defaultProtonPath = userPreferences?.defaultProtonPath;

  if (defaultProtonPath && Umu.isValidProtonPath(defaultProtonPath)) {
    return defaultProtonPath;
  }

  return null;
};

const cleanupStaleCompatibilityProcesses = async (
  objectId: string,
  winePrefixPath: string | null
) => {
  if (process.platform !== "linux" || !winePrefixPath) return;

  const defaultPrefixPath = Wine.getDefaultPrefixPathForGame(objectId);
  if (defaultPrefixPath !== winePrefixPath) return;

  const processes = await NativeAddon.listProcesses();

  const stalePids = processes
    .filter((runningProcess) => {
      const processPrefix = runningProcess.environ?.STEAM_COMPAT_DATA_PATH;
      if (processPrefix !== winePrefixPath) return false;

      const processExe = runningProcess.exe?.toLowerCase() ?? "";
      const processName = runningProcess.name.toLowerCase();

      return (
        processExe.includes("wine") ||
        processName.endsWith(".exe") ||
        processName === "wineserver"
      );
    })
    .map((runningProcess) => runningProcess.pid);

  if (!stalePids.length) return;

  logger.info("Killing stale compatibility processes before game launch", {
    objectId,
    winePrefixPath,
    stalePids,
  });

  for (const pid of stalePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore races and missing permissions.
    }
  }
};

const launchWindowsBinaryOnLinux = async (
  gameKey: string,
  objectId: string,
  parsedPath: string,
  game: Game | undefined,
  launchOptions: string | null | undefined,
  useMangohud: boolean,
  useGamemode: boolean,
  useGamescope: boolean,
  userPreferences: UserPreferences | null
): Promise<boolean> => {
  const protonPath = await resolveProtonPathForLaunch(game?.protonPath);
  const winePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  await cleanupStaleCompatibilityProcesses(objectId, winePrefixPath);

  try {
    const umuPid = await Umu.launchExecutable(parsedPath, [], {
      winePrefixPath,
      protonPath,
      gameId: objectId,
      launchOptions,
      useGamemode,
      useMangohud,
      useGamescope,
      userPreferences,
      sandboxGame: game,
      sandboxGameKey: gameKey,
    });
    if (umuPid !== null) {
      launchedGamePids.set(gameKey, umuPid);
      if (Sandbox.isEnabled(userPreferences, game)) {
        sandboxedGamePids.add(gameKey);
      }
    }
    PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
    return true;
  } catch (error) {
    logger.error("Failed to launch game with umu-run, falling back", error);
  }

  const launchedWithWine = await launchWithWine(
    parsedPath,
    launchOptions,
    useMangohud,
    useGamemode,
    useGamescope,
    {
      userPreferences,
      game,
      winePrefix: winePrefixPath,
      gameKey,
    }
  );

  if (launchedWithWine) {
    PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
    return true;
  }

  return false;
};

/**
 * Shows the launcher window and launches the game executable
 * Shared between deep link handler and openGame event
 */
export const launchGame = async (
  options: LaunchGameOptions
): Promise<number | null> => {
  const { shop, objectId, executablePath, launchOptions } = options;

  const parsedPath = parseExecutablePath(executablePath);

  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  // Open a launch-grace window covering the whole startup: the spawned
  // bwrap/pasta/umu/proton chain churns short-lived bootstrap processes that
  // the process watcher transiently matches and then loses again before the
  // game's own process is matchable, which used to bounce the running-games
  // feed (launch/close button flashing close→launch mid-startup). While the
  // grace is active the watcher does not trust the ABSENCE of a match (see
  // process-watcher); an explicit user close still clears it immediately.
  markGameLaunching(gameKey);

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const useMangohud =
    (userPreferences?.autoRunMangohud === true ||
      game?.autoRunMangohud === true) &&
    isMangohudAvailable();

  const useGamemode =
    (userPreferences?.autoRunGamemode === true ||
      game?.autoRunGamemode === true) &&
    isGamemodeAvailable();

  // Tri-state: explicit per-game choice wins; AUTO (null/undefined) falls back
  // to "gamescope detected". ANDed with availability so an explicit true never
  // wraps the launch with a missing binary (mirrors mangohud/gamemode).
  // Inside a gamescope session (Steam Deck gaming mode) wrapping is forced OFF
  // even when explicitly enabled: the game presents to the session compositor
  // directly, and a nested gamescope there cannot initialise its display.
  const gamescopeAvailable = isGamescopeAvailable();
  const gamescopeSession = isGamescopeSessionActive();
  const useGamescope =
    (game?.useGamescope ?? gamescopeAvailable) &&
    gamescopeAvailable &&
    !gamescopeSession;

  if (gamescopeSession && (game?.useGamescope ?? gamescopeAvailable)) {
    logger.log(
      "Skipping gamescope wrapper: already inside a gamescope session"
    );
  }

  if (game) {
    await gamesSublevel.put(gameKey, {
      ...updateGameExecutablePath(game, parsedPath),
      launchOptions,
    });
  }

  await WindowManager.createGameLauncherWindow(shop, objectId);

  // Run preflight check for common redistributables (Windows only)
  // Wrapped in try/catch to ensure game launch is never blocked
  if (process.platform === "win32") {
    try {
      logger.log("Starting preflight check for game launch", {
        shop,
        objectId,
      });
      const preflightPassed = await CommonRedistManager.runPreflight();
      logger.log("Preflight check result", { passed: preflightPassed });
    } catch (error) {
      logger.error(
        "Preflight check failed with error, continuing with launch",
        error
      );
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Steam-Cloud-like restore/sync-in BEFORE any spawn: if another machine has a
  // newer backup than this one, restore it first. Gated on automaticCloudSync
  // and awaited so saves are in place before the game starts. syncOnLaunch is
  // fail-safe (never throws); the extra guard keeps a launch alive even if that
  // contract ever regresses.
  if (game?.automaticCloudSync) {
    try {
      await CloudSync.syncOnLaunch(shop, objectId);
    } catch (error) {
      logger.error("Cloud sync on launch threw unexpectedly", error);
    }

    // Mark the start of a play session as local divergence: from now on this
    // device has (potentially) un-backed-up save changes. A clean close-backup
    // clears this; if the session crashes/is killed it stays set, so the next
    // launch can detect a true cross-device conflict. Re-read first because
    // syncOnLaunch may have just written the record.
    try {
      const currentGame = await gamesSublevel.get(gameKey);
      if (currentGame) {
        await gamesSublevel.put(gameKey, {
          ...currentGame,
          unsyncedSince: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error("Failed to mark play session start for cloud sync", error);
    }
  }

  if (process.platform === "linux") {
    if (isWindowsExecutable(parsedPath)) {
      const launched = await launchWindowsBinaryOnLinux(
        gameKey,
        objectId,
        parsedPath,
        game,
        launchOptions,
        useMangohud,
        useGamemode,
        useGamescope,
        userPreferences
      );

      if (launched) return launchedGamePids.get(gameKey) ?? null;
    }

    const pid = launchNatively(
      parsedPath,
      launchOptions,
      useMangohud,
      useGamemode,
      useGamescope,
      { userPreferences, game, gameKey }
    );

    if (pid !== null) {
      launchedGamePids.set(gameKey, pid);
      if (Sandbox.isEnabled(userPreferences, game)) {
        sandboxedGamePids.add(gameKey);
      }
    }

    return pid;
  }

  return launchNatively(
    parsedPath,
    launchOptions,
    useMangohud,
    useGamemode,
    useGamescope
  );
};
