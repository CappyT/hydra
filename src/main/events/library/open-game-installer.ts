import { shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

import { getDownloadsPath } from "../helpers/get-downloads-path";
import { registerEvent } from "../register-event";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { GameShop, type Game, type UserPreferences } from "@types";
import { logger, Sandbox, Umu, Wine } from "@main/services";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "@main/helpers/sandbox-launch";
import { buildSandboxEnv } from "@main/helpers/sandbox-env";

interface InstallerSandboxContext {
  userPreferences?: UserPreferences | null;
  game?: Game | null;
  gameKey?: string;
  winePrefixPath?: string | null;
}

const launchInstallerWithWine = async (
  filePath: string,
  sandbox?: InstallerSandboxContext
): Promise<boolean> => {
  const winePrefixPath = sandbox?.winePrefixPath;
  const sandboxEnabled = Sandbox.isEnabled(
    sandbox?.userPreferences,
    sandbox?.game
  );

  // Point wine at the per-game prefix so the install lands in the same prefix
  // the umu launch path uses; without this, bare wine defaults to ~/.wine (or
  // the ephemeral sandbox-home default).
  if (winePrefixPath) {
    fs.mkdirSync(winePrefixPath, { recursive: true });
  }

  const resolved = wrapWithSandbox(
    {
      command: "wine",
      args: [filePath],
      env: winePrefixPath ? { WINEPREFIX: winePrefixPath } : {},
    },
    {
      userPreferences: sandbox?.userPreferences,
      game: sandbox?.game,
      gameKey: sandbox?.gameKey,
      gameDir: path.dirname(filePath),
      winePrefix: sandbox?.winePrefixPath,
    }
  );

  const seccompFd = openSeccompFd(resolved);
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(resolved.command, resolved.args, {
        detached: true,
        stdio: withSeccompStdio(["ignore", "ignore", "ignore"], seccompFd),
        shell: false,
        // Scrub the inherited env to an allowlist when sandboxed so the
        // installer cannot read the user's secrets from /proc/self/environ,
        // then re-apply the launch env. Full env is kept when the sandbox is
        // off.
        env: {
          ...(sandboxEnabled ? buildSandboxEnv(process.env) : process.env),
          ...resolved.env,
        },
      });

      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });

      child.once("error", (error) => {
        logger.error("Failed to execute game installer with wine", error);
        resolve(false);
      });
    });
  } finally {
    closeSeccompFd(seccompFd);
  }
};

const launchInstallerDirectly = async (filePath: string): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(filePath, [], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });

    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });

    child.once("error", (error) => {
      logger.error("Failed to execute game installer directly", error);
      resolve(false);
    });
  });
};

const openPathAndCheck = async (filePath: string): Promise<boolean> => {
  const openError = await shell.openPath(filePath);
  return openError.length === 0;
};

const executeGameInstaller = async (
  filePath: string,
  options?: {
    gameId?: string;
    gameKey?: string;
    winePrefixPath?: string | null;
    protonPath?: string | null;
    userPreferences?: UserPreferences | null;
    game?: Game | null;
  }
) => {
  if (process.platform === "win32") {
    const launchedDirectly = await launchInstallerDirectly(filePath);
    if (launchedDirectly) {
      return true;
    }

    return await openPathAndCheck(filePath);
  }

  if (process.platform === "linux") {
    try {
      await Umu.launchExecutable(filePath, [], {
        gameId: options?.gameId,
        winePrefixPath: options?.winePrefixPath,
        protonPath: options?.protonPath,
        userPreferences: options?.userPreferences,
        sandboxGame: options?.game,
        sandboxGameKey: options?.gameKey,
      });
      return true;
    } catch (error) {
      logger.error("Failed to execute game installer with umu-run", error);

      const launchedWithWine = await launchInstallerWithWine(filePath, {
        userPreferences: options?.userPreferences,
        game: options?.game,
        gameKey: options?.gameKey,
        winePrefixPath: options?.winePrefixPath,
      });
      if (launchedWithWine) {
        return true;
      }

      return await openPathAndCheck(filePath);
    }
  }

  return await openPathAndCheck(filePath);
};

const openGameInstaller = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  const downloadKey = levelKeys.game(shop, objectId);
  const download = await downloadsSublevel.get(downloadKey);
  const game = await gamesSublevel.get(downloadKey).catch(() => null);
  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);
  const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );

  if (!download?.folderName) return true;

  const gamePath = path.join(
    download.downloadPath ?? (await getDownloadsPath()),
    download.folderName
  );

  if (!fs.existsSync(gamePath)) {
    return true;
  }

  if (process.platform === "darwin") {
    shell.openPath(gamePath);
    return true;
  }

  if (fs.lstatSync(gamePath).isFile()) {
    shell.showItemInFolder(gamePath);
    return true;
  }

  const setupPath = path.join(gamePath, "setup.exe");
  if (fs.existsSync(setupPath)) {
    return await executeGameInstaller(setupPath, {
      gameId: objectId,
      gameKey: downloadKey,
      winePrefixPath: effectiveWinePrefixPath,
      protonPath: game?.protonPath,
      userPreferences,
      game,
    });
  }

  const gamePathFileNames = fs.readdirSync(gamePath);
  const gamePathExecutableFiles = gamePathFileNames.filter(
    (fileName: string) => path.extname(fileName).toLowerCase() === ".exe"
  );

  if (gamePathExecutableFiles.length === 1) {
    return await executeGameInstaller(
      path.join(gamePath, gamePathExecutableFiles[0]),
      {
        gameId: objectId,
        gameKey: downloadKey,
        winePrefixPath: effectiveWinePrefixPath,
        protonPath: game?.protonPath,
        userPreferences,
        game,
      }
    );
  }

  shell.openPath(gamePath);
  return true;
};

registerEvent("openGameInstaller", openGameInstaller);
