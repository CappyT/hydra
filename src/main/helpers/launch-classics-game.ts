import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { Sandbox, emulators, logger } from "@main/services";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "./sandbox-launch";
import { buildSandboxEnv } from "./sandbox-env";
import type {
  EmulatorBinary,
  EmulatorConfig,
  EmulatorSystem,
  Game,
  GameShop,
  UserPreferences,
} from "@types";
import { isGamemodeAvailable } from "./is-gamemode-available";
import { isMangohudAvailable } from "./is-mangohud-available";
import {
  isGamescopeAvailable,
  isWaylandSessionAvailable,
} from "./is-gamescope-available";
import { resolveLaunchCommand } from "./resolve-launch-command";

export class EmulatorNotConfiguredError extends Error {
  code = "EMULATOR_NOT_CONFIGURED" as const;
  system: EmulatorSystem;
  constructor(system: EmulatorSystem) {
    super(`Emulator not configured for system ${system}`);
    this.system = system;
  }
}

export class BiosNotConfiguredError extends Error {
  code = "BIOS_NOT_CONFIGURED" as const;
  system: EmulatorSystem;
  constructor(system: EmulatorSystem) {
    super(`BIOS not configured for system ${system}`);
    this.system = system;
  }
}

export class PkgInstallingError extends Error {
  code = "PKG_INSTALLING" as const;
  system: EmulatorSystem;
  constructor(system: EmulatorSystem) {
    super(`Installing PKG for system ${system}`);
    this.system = system;
  }
}

export class PkgUnreadableError extends Error {
  code = "PKG_UNREADABLE" as const;
  system: EmulatorSystem;
  constructor(system: EmulatorSystem) {
    super(`Could not read PKG title id for system ${system}`);
    this.system = system;
  }
}

const isPkgPath = (filePath: string): boolean =>
  filePath.toLowerCase().endsWith(".pkg");

const spawnRpcs3PkgInstall = (
  executableTarget: string,
  pkgPath: string
): void => {
  const child = spawn(executableTarget, ["--installpkg", pkgPath], {
    shell: false,
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(executableTarget),
    env: { ...process.env },
  });
  child.on("error", (error) => {
    logger.error("Failed to spawn RPCS3 for PKG install", error);
  });
  child.unref();
};

const resolvePs3PkgBootTarget = async (params: {
  executablePath: string;
  executableTarget: string;
  pkgPath: string;
  system: EmulatorSystem;
}): Promise<string> => {
  const { executablePath, executableTarget, pkgPath, system } = params;

  const titleId = await emulators.extractTitleIdFromPkg(pkgPath);
  if (!titleId) {
    throw new PkgUnreadableError(system);
  }

  const installedEboot = emulators.findInstalledPs3GameEboot(
    executablePath,
    titleId
  );
  if (installedEboot) {
    return installedEboot;
  }

  spawnRpcs3PkgInstall(executableTarget, pkgPath);
  throw new PkgInstallingError(system);
};

export interface LaunchClassicsGameOptions {
  shop: GameShop;
  objectId: string;
  discPath: string;
  system: EmulatorSystem;
}

const buildEmulatorArgs = (
  binary: EmulatorBinary,
  discPath: string
): string[] => {
  switch (binary) {
    case "duckstation":
      return ["-batch", "-fullscreen", "--", discPath];
    case "pcsx2":
      return ["-batch", "-fullscreen", "--", discPath];
    case "rpcs3":
      return ["--no-gui", discPath];
  }
};

const assertBiosInstalled = async (
  system: EmulatorSystem,
  config: EmulatorConfig
): Promise<void> => {
  if (system !== "ps1" && system !== "ps2") return;

  const biosDir = await emulators.resolveInstalledBiosDir(
    system,
    config.executablePath,
    config.biosPath
  );
  if (!biosDir) {
    throw new BiosNotConfiguredError(system);
  }
  if (biosDir !== config.biosPath) {
    await emulators.updateEmulatorConfig(system, (current) => ({
      ...current,
      biosPath: biosDir,
    }));
  }
};

const resolveEmulatorWrappers = (
  preferences: UserPreferences | null,
  game: Game | undefined
): { wrapperCommands: (string | string[])[]; useGamescope: boolean } => {
  const useMangohud =
    (preferences?.autoRunMangohud === true || game?.autoRunMangohud === true) &&
    isMangohudAvailable();

  const useGamemode =
    (preferences?.autoRunGamemode === true || game?.autoRunGamemode === true) &&
    isGamemodeAvailable();

  // Tri-state: explicit per-game choice wins; AUTO (null/undefined) falls back
  // to "gamescope detected", ANDed with availability so a stale explicit true
  // never wraps with a missing binary.
  const gamescopeAvailable = isGamescopeAvailable();
  const useGamescope =
    (game?.useGamescope ?? gamescopeAvailable) && gamescopeAvailable;

  return {
    wrapperCommands: [
      ...(useGamemode ? ["gamemoderun"] : []),
      ...(useGamescope ? [["gamescope", "-f", "--"]] : []),
      ...(useMangohud ? ["mangohud"] : []),
    ],
    useGamescope,
  };
};

const resolveEmulatorDataDirs = (binary: EmulatorBinary): string[] => {
  const home = os.homedir();
  const configDir = path.join(home, ".config");
  const shareDir = path.join(home, ".local", "share");

  switch (binary) {
    case "duckstation":
      return [
        path.join(configDir, "duckstation"),
        path.join(shareDir, "duckstation"),
      ];
    case "pcsx2":
      return [
        path.join(configDir, "PCSX2"),
        path.join(shareDir, "PCSX2"),
        path.join(shareDir, "pcsx2"),
      ];
    case "rpcs3":
      return [path.join(configDir, "rpcs3"), path.join(shareDir, "rpcs3")];
  }
};

export const launchClassicsGame = async (
  options: LaunchClassicsGameOptions
): Promise<void> => {
  const { shop, objectId, discPath, system } = options;

  const config = await emulators.getEmulatorConfig(system);
  if (!config.executablePath || !existsSync(config.executablePath)) {
    throw new EmulatorNotConfiguredError(system);
  }

  // DuckStation/PCSX2 silently crash on launch when no BIOS is present, and the
  // emulator is spawned detached with stdio "ignore" so its own error never
  // reaches us. Detect the missing BIOS up front and block the launch instead.
  await assertBiosInstalled(system, config);

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

  const selectedDisc = game?.discs?.find((d) => d.path === discPath) ?? null;

  const executablePath = path.normalize(config.executablePath);
  const executableTarget =
    emulators.resolveEmulatorExecutableTarget(executablePath);

  if (!executableTarget || !existsSync(executableTarget)) {
    throw new EmulatorNotConfiguredError(system);
  }

  const bootTarget =
    system === "ps3" && isPkgPath(discPath)
      ? await resolvePs3PkgBootTarget({
          executablePath: config.executablePath,
          executableTarget,
          pkgPath: discPath,
          system,
        })
      : discPath;

  if (game) {
    await gamesSublevel.put(gameKey, {
      ...game,
      selectedDiscPath: discPath,
      lastTimePlayed: new Date(),
    });
  }

  const baseArgs = buildEmulatorArgs(config.binary, bootTarget);

  const workingDirectory = path.dirname(executableTarget);

  const emulatorAdditionalBinds = [
    ...resolveEmulatorDataDirs(config.binary),
    path.dirname(bootTarget),
    path.dirname(discPath),
    ...(config.biosPath ? [config.biosPath] : []),
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
      additionalBinds: emulatorAdditionalBinds,
      hideX11: useGamescope && isWaylandSessionAvailable(),
    }
  );

  const seccompFd = openSeccompFd(resolvedLaunchCommand);
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

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        processRef.off("error", onError);
        resolve();
      };
      const onError = () => {
        processRef.off("spawn", onSpawn);
        reject(new EmulatorNotConfiguredError(system));
      };
      processRef.once("spawn", onSpawn);
      processRef.once("error", onError);
    });

    if (game) {
      await emulators.startEmulatorSession({
        game,
        system,
        executablePath: config.executablePath,
        sku: selectedDisc?.sku ?? null,
        child: processRef,
      });
    }

    processRef.unref();
  } catch (error) {
    logger.error("Failed to spawn classics emulator", error);
    throw error;
  } finally {
    // The child inherited its own dup at fd 3; release the parent's copy.
    closeSeccompFd(seccompFd);
  }
};
