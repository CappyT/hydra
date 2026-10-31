import { shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GameShop, type Game, type UserPreferences } from "@types";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { updateGameExecutablePath } from "./update-executable-path";
import {
  clearCloudSaveLaunchGuard,
  canRunAutomaticCloudSaveSync,
  canCreateCloudSaveUploadGuard,
  createPendingCloudSaveCustomPathApproval,
  getCloudSaveGameContext,
  rotateCloudSavePrefixGeneration,
  runAutomaticCloudSaveSyncDetailed,
  runWithCloudSaveLaunchGate,
  setCloudSaveLaunchGuard,
  shouldBlockGameLaunchForCloudSave,
} from "@main/services/cloud-save";
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
  type UmuStatus,
} from "@main/services";
import {
  clearGameLauncherStatuses,
  sendGameLauncherStatus,
  wasGameLauncherGameDetected,
} from "@main/services/game-launcher-status";
import { updateGameRecord } from "@main/services/game-record-updater";
import { CommonRedistManager } from "@main/services/common-redist-manager";
import { runAchievementMetadataExport } from "@main/services/achievements/metadata-export";
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
import { shouldPrepareCompatibilityPrefix } from "./should-prepare-compatibility-prefix";
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
import {
  markManagedEpicLaunched,
  prepareManagedEpicLaunch,
  cancelManagedEpicLaunch,
  recordManagedEpicProcess,
  launchPreparedEpicLinuxGame,
} from "@main/services/epic/launch";
import type { EpicLaunchParameters } from "@main/services/epic/launch-protocol";
import { EpicSaveFailure } from "@main/services/epic/cloud-save-protocol";
import {
  getEpicCloudSaveService,
  runWithHydraSaveGuard,
} from "@main/services/epic/cloud-saves";
import { ACCOUNTLESS } from "@shared";

export interface LaunchGameOptions {
  shop: GameShop;
  objectId: string;
  executablePath: string;
  launchOptions?: string | null;
  epicSavePolicy?: "local-once";
  epicOffline?: boolean;
}

const LAUNCH_DELAY_IN_MS = 2_000;

const createUmuStatusReporter =
  (gameKey: string) =>
  (status: UmuStatus): void => {
    if (status.type === "progress") {
      if (wasGameLauncherGameDetected(gameKey)) return;
      sendGameLauncherStatus(
        gameKey,
        "preparing_compatibility_layer",
        status.message
      );
      return;
    }
    if (status.type === "failed") {
      sendGameLauncherStatus(
        gameKey,
        "compatibility_layer_failed",
        status.message
      );
      return;
    }
    sendGameLauncherStatus(gameKey, "compatibility_layer_ready");
  };

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

interface LinuxCompatibilityLaunchContext {
  protonPath: string | null;
  winePrefixPath: string | null;
}

const isValidWinePrefix = (winePrefixPath: string | null) => {
  if (!winePrefixPath) return false;

  try {
    return Wine.validatePrefix(winePrefixPath);
  } catch {
    return false;
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

interface CloudSavePrefixPreparationResult {
  winePrefixPath: string | null;
  readyForRestore: boolean;
  safeForUpload: boolean;
  generationOverride?: Awaited<
    ReturnType<typeof rotateCloudSavePrefixGeneration>
  >;
}

const prepareWinePrefixIfNeeded = async (
  context: LinuxCompatibilityLaunchContext,
  gameKey: string,
  objectId: string,
  prefixWasReadyForRestore: boolean
) => {
  if (prefixWasReadyForRestore) return false;

  try {
    await Umu.preparePrefix({
      winePrefixPath: context.winePrefixPath!,
      protonPath: context.protonPath,
      gameId: objectId,
      onStatus: createUmuStatusReporter(gameKey),
    });
    return false;
  } catch (error) {
    logger.error("Failed to prepare Wine prefix before cloud save restore", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return true;
  }
};

const prepareCompatibilityPrefixForCloudSave = async (
  context: LinuxCompatibilityLaunchContext,
  gameKey: string,
  objectId: string
): Promise<CloudSavePrefixPreparationResult> => {
  const winePrefixPath = context.winePrefixPath;
  if (!winePrefixPath) {
    return {
      winePrefixPath: null,
      readyForRestore: false,
      safeForUpload: false,
    };
  }

  const prefixWasValid = isValidWinePrefix(winePrefixPath);
  const prefixWasReadyForRestore =
    prefixWasValid && Wine.isPrefixReadyForRestore(winePrefixPath);
  const preparationFailed = await prepareWinePrefixIfNeeded(
    context,
    gameKey,
    objectId,
    prefixWasReadyForRestore
  );

  const canonicalWinePrefixPath =
    (await Wine.resolvePrefixPath(winePrefixPath)) ?? winePrefixPath;
  const prefixValid = isValidWinePrefix(canonicalWinePrefixPath);
  const wineProfiles = prefixValid
    ? Wine.getPrefixUserProfiles(canonicalWinePrefixPath)
    : [];
  const readyForRestore = prefixValid && wineProfiles.length > 0;

  logger.info("[Cloud Save] Wine prefix preparation result", {
    objectId,
    requestedWinePrefixPath: winePrefixPath,
    canonicalWinePrefixPath,
    prefixValid,
    wineProfiles,
    readyForRestore,
    preparationFailed,
  });

  if (!readyForRestore) {
    return {
      winePrefixPath: canonicalWinePrefixPath,
      readyForRestore: false,
      safeForUpload: false,
    };
  }

  if (prefixWasReadyForRestore) {
    return {
      winePrefixPath: canonicalWinePrefixPath,
      readyForRestore: true,
      safeForUpload: !preparationFailed,
    };
  }

  const generationOverride = await rotateCloudSavePrefixGeneration(
    canonicalWinePrefixPath
  ).catch((error: unknown) => {
    logger.error("Failed to rotate cloud save prefix generation", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return undefined;
  });

  return {
    winePrefixPath: canonicalWinePrefixPath,
    readyForRestore: true,
    safeForUpload: !preparationFailed && generationOverride?.durable === true,
    generationOverride,
  };
};

const cleanupStaleCompatibilityProcesses = async (
  objectId: string,
  winePrefixPath: string | null
) => {
  if (process.platform !== "linux" || !winePrefixPath) return;

  const defaultPrefixPath = await Wine.resolvePrefixPath(
    Wine.getDefaultPrefixPathForGame(objectId)
  );
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
  compatibilityContext: LinuxCompatibilityLaunchContext,
  launchOptions: string | null | undefined,
  useMangohud: boolean,
  useGamemode: boolean,
  useGamescope: boolean,
  userPreferences: UserPreferences | null,
  game: Game | undefined
): Promise<boolean> => {
  const { protonPath, winePrefixPath } = compatibilityContext;
  const reportUmuStatus = createUmuStatusReporter(gameKey);
  let umuFailureMessage = "umu-run failed to launch the game";

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
      onStatus: reportUmuStatus,
      wasGameDetected: () => wasGameLauncherGameDetected(gameKey),
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
    if (error instanceof Error && error.message) {
      umuFailureMessage = error.message;
    }
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
    reportUmuStatus({ type: "ready" });
    PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
    return true;
  }

  reportUmuStatus({ type: "failed", message: umuFailureMessage });
  return false;
};

interface PreparedLinuxCompatibility {
  context: LinuxCompatibilityLaunchContext | null;
  prefixReadyForRestore: boolean;
  prefixSafeForUpload: boolean;
  prefixGenerationOverride?: Awaited<
    ReturnType<typeof rotateCloudSavePrefixGeneration>
  >;
}

class ManagedEpicLaunchBlockedError extends Error {}

const prepareLinuxCompatibilityForLaunch = async (
  parsedPath: string,
  game: Game | undefined,
  objectId: string,
  shop: GameShop,
  shouldPrepareForCloudSave: boolean
): Promise<PreparedLinuxCompatibility> => {
  if (process.platform !== "linux" || !isWindowsExecutable(parsedPath)) {
    return {
      context: null,
const localPrefixExists = (game: Game | null | undefined, objectId: string) => {
  const prefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );
  return !!prefixPath && fs.existsSync(prefixPath);
};

      prefixReadyForRestore: true,
      prefixSafeForUpload: true,
    };
  }

  const requestedWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );
  let context: LinuxCompatibilityLaunchContext = {
    protonPath: await resolveProtonPathForLaunch(game?.protonPath),
    winePrefixPath: await Wine.resolvePrefixPath(requestedWinePrefixPath),
  };
  logger.info("[Cloud Save] Resolved authoritative launch prefix", {
    shop,
    objectId,
    requestedWinePrefixPath,
    canonicalWinePrefixPath: context.winePrefixPath,
    prefixSource: game?.winePrefixPath ? "game" : "default",
  });
  await cleanupStaleCompatibilityProcesses(objectId, context.winePrefixPath);

  if (!shouldPrepareForCloudSave) {
    return {
      context,
      prefixReadyForRestore: true,
      prefixSafeForUpload: true,
    };
  }

  const prefixPreparation = await prepareCompatibilityPrefixForCloudSave(
    context,
    levelKeys.game(shop, objectId),
    objectId
  );
  context = {
    ...context,
    winePrefixPath: prefixPreparation.winePrefixPath,
  };
  return {
    context,
    prefixReadyForRestore: prefixPreparation.readyForRestore,
    prefixSafeForUpload: prefixPreparation.safeForUpload,
    prefixGenerationOverride: prefixPreparation.generationOverride,
  };
};

const redirectBlockedCloudSaveLaunch = (
  shop: GameShop,
  objectId: string,
  title: string,
  searchParam: "openCloudSavePathApproval" | "openCloudSaveConflict"
) => {
  const searchParams = new URLSearchParams({
    title,
    [searchParam]: "1",
  });
  clearCloudSaveLaunchGuard(objectId, shop);
  WindowManager.closeGameLauncherWindow();
  WindowManager.redirectToGameWindow(
    `game/${shop}/${objectId}?${searchParams.toString()}`
  );
};

const runCommonRedistPreflight = async (shop: GameShop, objectId: string) => {
  if (process.platform !== "win32") return;

  try {
    logger.log("Starting preflight check for game launch", {
      shop,
      objectId,
    });
    const preflightPassed = await CommonRedistManager.runPreflight();
    logger.log("Preflight check result", { passed: preflightPassed });
  } catch (error) {
    logger.error("Preflight check failed with error", error);
  }
};

const launchAuthenticatedEpicGame = (
  parameters: EpicLaunchParameters,
  launchOptions?: string | null
): Promise<number> => {
  const resolved = resolveLaunchCommand({
    baseCommand: parameters.executable,
    baseArgs: parameters.args,
    launchOptions,
  });
  if (isWindowsBatchFile(resolved.command))
    return Promise.reject(new EpicSaveFailure("invalid-path"));
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd: parameters.workingDirectory,
      env: { ...process.env, ...parameters.environment, ...resolved.env },
    });
    child.once("spawn", () => {
      child.unref();
      if (child.pid) resolve(child.pid);
      else reject(new EpicSaveFailure("process-failed"));
    });
    // Never serialize the spawn error: it includes authentication arguments.
    child.once("error", () => reject(new EpicSaveFailure("process-failed")));
  });
};

/**
 * Shows the launcher window and launches the game executable
 * Shared between deep link handler and openGame event
 */
const launchGameWithCloudSaveChecks = async (
  options: LaunchGameOptions
): Promise<number | null> => {
  const { shop, objectId, executablePath, launchOptions } = options;

  const parsedPath = parseExecutablePath(executablePath);

  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);
  clearCloudSaveLaunchGuard(objectId, shop);

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

  // Log only when the session is the reason we drop the wrapper: the wrapper
  // would otherwise be used (gamescope available AND enabled). Without the
  // availability factor this also fired when gamescope simply is not installed,
  // where the real reason is unavailability, not the session.
  if (
    gamescopeSession &&
    gamescopeAvailable &&
    (game?.useGamescope ?? gamescopeAvailable)
  ) {
    logger.log(
      "Skipping gamescope wrapper: already inside a gamescope session"
    );
  }

  const updatedGame = game
    ? await updateGameRecord(gameKey, (currentGame) => ({
        ...updateGameExecutablePath(currentGame, parsedPath),
        launchOptions,
      }))
    : null;
  const launchGameRecord = updatedGame ?? game;
  const managedEpic =
    !ACCOUNTLESS && shop === "epic" && !!launchGameRecord?.epicInstallation;

  clearGameLauncherStatuses(gameKey);
  await WindowManager.createGameLauncherWindow(shop, objectId);

  const shouldRunV2AutomaticSync = await canRunAutomaticCloudSaveSync(
    objectId,
    shop
  );
  let preparedCompatibility: PreparedLinuxCompatibility;
  if (managedEpic) {
    preparedCompatibility = {
      context: null,
      prefixReadyForRestore: true,
      prefixSafeForUpload: true,
      prefixGenerationOverride: undefined,
    };
  } else {
    preparedCompatibility = await prepareLinuxCompatibilityForLaunch(
      parsedPath,
      launchGameRecord,
      objectId,
      shop,
      // Local sync-in restores into the prefix, so it must exist before then.
      // Preparation runs on the host, so never on an existing (game-writable)
      // prefix.
      shouldPrepareCompatibilityPrefix({
        v2AutomaticSync: shouldRunV2AutomaticSync,
        managedEpic,
        localAutomaticSync: !!launchGameRecord?.automaticCloudSync,
        prefixExists: localPrefixExists(launchGameRecord, objectId),
      })
    );
  }
  const {
    context: compatibilityContext,
    prefixReadyForRestore,
    prefixSafeForUpload,
    prefixGenerationOverride,
  } = preparedCompatibility;

  // Returns false when Hydra's pre-launch sync blocked the launch.
  const runHydraPreLaunchSync = async (
    winePrefixPath: string | undefined
  ): Promise<boolean> => {
    const cloudSaveContext = shouldRunV2AutomaticSync
      ? await getCloudSaveGameContext(objectId, shop, {
          executablePath: parsedPath,
          winePrefixPath,
          prefixGenerationOverride,
        }).catch((error: unknown) => {
          logger.error(
            "Failed to resolve cloud save launch environment",
            error
          );
          return null;
        })
      : null;
    const customPathApproval =
      prefixReadyForRestore && cloudSaveContext
        ? await createPendingCloudSaveCustomPathApproval(
            options,
            cloudSaveContext
          ).catch((error: unknown) => {
            logger.error(
              "[Cloud Save] Failed to inspect custom restore destinations",
              error
            );
            return null;
          })
        : null;

    if (customPathApproval) {
      logger.warn(
        "[Cloud Save] Game launch blocked by an unapproved custom restore path",
        {
          shop,
          objectId,
          rawPath: customPathApproval.rawPath,
        }
      );
      redirectBlockedCloudSaveLaunch(
        shop,
        objectId,
        launchGameRecord?.title ?? objectId,
        "openCloudSavePathApproval"
      );
      return false;
    }

    const preLaunchOutcome =
      shouldRunV2AutomaticSync && prefixReadyForRestore
        ? await runAutomaticCloudSaveSyncDetailed(
            objectId,
            shop,
            "pre-launch",
            cloudSaveContext ?? undefined
          )
        : { status: "skipped" as const, result: null };
    const preLaunchResult = preLaunchOutcome.result;
    const hasPreLaunchConflict =
      preLaunchResult?.trigger === "pre-launch" &&
      preLaunchResult.action === "conflict";

    if (shouldRunV2AutomaticSync && !prefixReadyForRestore) {
      logger.warn(
        "[Cloud Save] Pre-launch restore skipped because Wine prefix is invalid",
        { shop, objectId }
      );
    }

    if (
      shouldBlockGameLaunchForCloudSave(
        preLaunchResult,
        preLaunchOutcome.status === "failed"
      )
    ) {
      logger.warn("[Cloud Save] Game launch blocked by pre-launch sync", {
        shop,
        objectId,
        reason: hasPreLaunchConflict ? "conflict" : "restore_failed",
      });
      if (hasPreLaunchConflict) {
        redirectBlockedCloudSaveLaunch(
          shop,
          objectId,
          launchGameRecord?.title ?? objectId,
          "openCloudSaveConflict"
        );
      } else {
        clearCloudSaveLaunchGuard(objectId, shop);
        WindowManager.closeGameLauncherWindow();
      }
      return false;
    }

    if (cloudSaveContext) {
      setCloudSaveLaunchGuard(objectId, shop, {
        environmentId: cloudSaveContext.environmentId,
        baseRemoteHash: preLaunchResult?.remoteHash ?? null,
        uploadAllowed: canCreateCloudSaveUploadGuard(
          prefixSafeForUpload &&
            cloudSaveContext.prefixIdentityMode !== "session",
          cloudSaveContext.environmentId,
          preLaunchResult
        ),
        createdAt: new Date().toISOString(),
      });
    }
    return true;
  };

  if (managedEpic && launchGameRecord) {
    return getEpicCloudSaveService().runLaunchGate(objectId, async () => {
      try {
        const prepared = await prepareManagedEpicLaunch(
          launchGameRecord,
          parsedPath,
          {
            winePrefixPath: compatibilityContext?.winePrefixPath,
            epicSavePolicy: options.epicSavePolicy,
            epicOffline: options.epicOffline,
            onStatus: createUmuStatusReporter(gameKey),
            // Runs once the Linux prefix exists, so Hydra restores into it and
            // records its upload guard against the prepared environment.
            beforeSaveSync: async (winePrefixPath) => {
              if (!(await runHydraPreLaunchSync(winePrefixPath)))
                throw new ManagedEpicLaunchBlockedError();
            },
          }
        );
        await runCommonRedistPreflight(shop, objectId);
        let pid: number;
        try {
          await markManagedEpicLaunched(prepared.session);
          getEpicCloudSaveService().assertSessionCurrent(prepared.session);
          if (prepared.linuxContext) {
            const handle = await launchPreparedEpicLinuxGame(
              prepared.session,
              prepared.parameters,
              {
                launchOptions,
                useGamemode,
                useMangohud,
                onStatus: createUmuStatusReporter(gameKey),
              }
            );
            pid = handle.pid;
            PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
          } else {
            pid = await launchAuthenticatedEpicGame(
              prepared.parameters,
              launchOptions
            );
            recordManagedEpicProcess(prepared.session, pid);
          }
        } catch (error) {
          await cancelManagedEpicLaunch(prepared.session);
          throw error;
        }
        launchedGamePids.set(gameKey, pid);
        return pid;
      } catch (error) {
        if (error instanceof ManagedEpicLaunchBlockedError) return null;
        WindowManager.closeGameLauncherWindow();
        // Auth or save preparation failures must never fall through to a raw launch.
        throw error;
      }
    });
  }

  if (
    !(await runHydraPreLaunchSync(
      compatibilityContext?.winePrefixPath ?? undefined
    ))
  )
    return null;

  // Run preflight check for common redistributables (Windows only)
  // Wrapped in try/catch to ensure game launch is never blocked
  await runCommonRedistPreflight(shop, objectId);

  if (updatedGame) {
    void runAchievementMetadataExport(gameKey, updatedGame);
  }

  await new Promise((resolve) => setTimeout(resolve, LAUNCH_DELAY_IN_MS));

  // Steam-Cloud-like restore/sync-in BEFORE any spawn: if another machine has a
  // newer backup than this one, restore it first. Gated on automaticCloudSync
  // and awaited so saves are in place before the game starts. syncOnLaunch is
  // fail-safe (never throws); the extra guard keeps a launch alive even if that
  // contract ever regresses.
  if (game?.automaticCloudSync) {
    try {
      await runWithHydraSaveGuard(() => CloudSync.syncOnLaunch(shop, objectId));
    } catch (error) {
      logger.error("Cloud sync on launch threw unexpectedly", error);
    }
    // The process watcher marks the play session (unsyncedSince) once the game
    // is seen running, so a refused or failed spawn leaves no false divergence.
  }

  if (process.platform === "linux") {
    if (isWindowsExecutable(parsedPath)) {
      if (!compatibilityContext) {
        clearCloudSaveLaunchGuard(objectId, shop);
        return null;
      }

      const launched = await launchWindowsBinaryOnLinux(
        gameKey,
        objectId,
        parsedPath,
        compatibilityContext,
        launchOptions,
        useMangohud,
        useGamemode,
        useGamescope,
        userPreferences,
        game
      );

      if (launched) return launchedGamePids.get(gameKey) ?? null;
      clearCloudSaveLaunchGuard(objectId, shop);
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

const hasLaunchableExecutable = (executablePath: string) => {
  if (!executablePath || !fs.existsSync(executablePath)) return false;

  try {
    return fs.existsSync(parseExecutablePath(executablePath));
  } catch {
    return false;
  }
};

export const launchGame = async (options: LaunchGameOptions) => {
  if (!hasLaunchableExecutable(options.executablePath)) {
    logger.warn("Game executable not found", {
      shop: options.shop,
      objectId: options.objectId,
      executablePath: options.executablePath,
    });
    WindowManager.sendToAppWindows(
      "on-game-executable-not-found",
      options.shop,
      options.objectId
    );

    if (options.shop === "steam") {
      void import(
        "@main/services/steam-integration/link-imported-steam-executables"
      )
        .then(({ refreshSteamGameExecutable }) =>
          refreshSteamGameExecutable(options.objectId)
        )
        .then((changed) => {
          if (changed) {
            WindowManager.sendToAppWindows("on-library-batch-complete");
          }
        });
    }

    return null;
  }

  return runWithCloudSaveLaunchGate(options.objectId, options.shop, () =>
    launchGameWithCloudSaveChecks(options)
  );
};
