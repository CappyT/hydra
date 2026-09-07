import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { Sandbox, emulators, logger, retroarch } from "@main/services";
import type {
  GameShop,
  RetroArchCoreName,
  RetroArchPlatform,
  UserPreferences,
} from "@types";
import { resolveEmulatorWrappers } from "./launch-classics-game";
import { resolveLaunchCommand } from "./resolve-launch-command";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "./sandbox-launch";
import { buildSandboxEnv } from "./sandbox-env";
import { isWaylandSessionAvailable } from "./is-gamescope-available";
import { prepareEmulatorSouvenirs } from "@main/services/emulators/prepare-emulator-souvenirs";
import { cleanupRetroArchSouvenirSession } from "@main/services/emulators/emulator-souvenir-config";

export class RetroArchNotConfiguredError extends Error {
  code = "RETROARCH_NOT_CONFIGURED" as const;
  platform: RetroArchPlatform;
  constructor(platform: RetroArchPlatform) {
    super(`RetroArch not configured for platform ${platform}`);
    this.platform = platform;
  }
}

export class CoreNotInstalledError extends Error {
  code = "CORE_NOT_INSTALLED" as const;
  platform: RetroArchPlatform;
  core: RetroArchCoreName;
  constructor(platform: RetroArchPlatform, core: RetroArchCoreName) {
    super(`Core ${core} not installed for platform ${platform}`);
    this.platform = platform;
    this.core = core;
  }
}

export interface LaunchRetroArchGameOptions {
  shop: GameShop;
  objectId: string;
  romPath: string;
  platform: RetroArchPlatform;
}

export const launchRetroArchGame = async (
  options: LaunchRetroArchGameOptions
): Promise<void> => {
  const { shop, objectId, romPath, platform } = options;

  const config = await retroarch.getRetroArchConfig();
  if (!config.executablePath || !existsSync(config.executablePath)) {
    throw new RetroArchNotConfiguredError(platform);
  }

  const executablePath = path.normalize(config.executablePath);
  const executableTarget =
    emulators.resolveEmulatorExecutableTarget(executablePath);

  if (!executableTarget || !existsSync(executableTarget)) {
    throw new RetroArchNotConfiguredError(platform);
  }

  const coreName = retroarch.PLATFORM_TO_CORE[platform];
  const core = config.cores[coreName];
  if (!core?.installed || !core.path || !existsSync(core.path)) {
    throw new CoreNotInstalledError(platform, coreName);
  }

  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const { wrapperCommands, useGamescope } = resolveEmulatorWrappers(
    userPreferences,
    game
  );

  const sessionGame = game
    ? {
        ...game,
        selectedDiscPath: romPath,
        lastTimePlayed: new Date(),
      }
    : null;

  if (sessionGame) await gamesSublevel.put(gameKey, sessionGame);

  const souvenirSession = sessionGame
    ? await prepareEmulatorSouvenirs(platform, config.executablePath)
    : null;
  const baseArgs = [
    ...(souvenirSession
      ? ["--appendconfig", souvenirSession.appendConfigPath]
      : []),
    "-L",
    core.path,
    romPath,
    "-f",
  ];

  const workingDirectory = path.dirname(executableTarget);

  // Same sandbox treatment as the classics emulators: RetroArch keeps its
  // config/saves/states under ~/.config/retroarch, plus the core and ROM dirs.
  const retroarchAdditionalBinds = [
    path.join(os.homedir(), ".config", "retroarch"),
    path.dirname(core.path),
    path.dirname(romPath),
  ];

  const resolvedLaunchCommand = wrapWithSandbox(
    resolveLaunchCommand({
      baseCommand: executableTarget,
      baseArgs,
      launchOptions: null,
      wrapperCommands,
    }),
    {
      userPreferences,
      game,
      gameKey,
      gameDir: workingDirectory,
      additionalBinds: retroarchAdditionalBinds,
      hideX11: useGamescope && isWaylandSessionAvailable(),
    }
  );

  const seccompFd = openSeccompFd(resolvedLaunchCommand);

  let sessionStarted = false;

  try {
    const processRef = spawn(
      resolvedLaunchCommand.command,
      resolvedLaunchCommand.args,
      {
        shell: false,
        detached: true,
        stdio: withSeccompStdio(["ignore", "ignore", "ignore"], seccompFd),
        cwd: workingDirectory,
        env: {
          ...(Sandbox.isEnabled(userPreferences, game)
            ? buildSandboxEnv(process.env)
            : process.env),
          ...resolvedLaunchCommand.env,
        },
      }
    );

    // Sandboxed spawn kept inline (spawnDetachedEmulator has no sandbox env or
    // seccomp fd); surface a spawn failure like upstream's helper does.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        processRef.off("error", onError);
        resolve();
      };
      const onError = () => {
        processRef.off("spawn", onSpawn);
        reject(new RetroArchNotConfiguredError(platform));
      };
      processRef.once("spawn", onSpawn);
      processRef.once("error", onError);
    });

    if (sessionGame) {
      await emulators.startEmulatorSession({
        game: sessionGame,
        system: platform,
        executablePath: config.executablePath,
        sku: null,
        child: processRef,
        souvenirSession,
      });
      sessionStarted = true;
    }

    processRef.unref();
  } catch (error) {
    if (!sessionStarted) {
      await cleanupRetroArchSouvenirSession(souvenirSession);
    }
    logger.error("Failed to spawn RetroArch", error);
    throw error;
  } finally {
    // The child inherited its own dup at fd 3; release the parent's copy.
    closeSeccompFd(seccompFd);
  }
};
