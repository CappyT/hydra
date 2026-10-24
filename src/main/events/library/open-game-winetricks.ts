import { spawn } from "node:child_process";
import { registerEvent } from "../register-event";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { logger, Sandbox, Wine } from "@main/services";
import type { GameShop, UserPreferences } from "@types";
import {
  wrapWithSandbox,
  openSeccompFd,
  withSeccompStdio,
  closeSeccompFd,
} from "@main/helpers/sandbox-launch";
import { buildSandboxEnv } from "@main/helpers/sandbox-env";

const openGameWinetricks = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<boolean> => {
  if (process.platform !== "linux") {
    return false;
  }

  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return false;

  if (shop === "epic" && game.epicInstallation) {
    try {
      return await (
        await import("@main/services/epic")
      ).openManagedEpicWinetricks(objectId);
    } catch {
      return false;
    }
  }
  const effectivePrefix = Wine.getEffectivePrefixPath(
    game.winePrefixPath,
    objectId
  );

  if (!effectivePrefix) {
    return false;
  }

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const resolved = wrapWithSandbox(
    { command: "winetricks", args: [], env: { WINEPREFIX: effectivePrefix } },
    {
      userPreferences,
      game,
      gameKey,
      gameDir: effectivePrefix,
      winePrefix: effectivePrefix,
    }
  );

  const seccompFd = openSeccompFd(resolved);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        detached: true,
        stdio: withSeccompStdio(["ignore", "ignore", "ignore"], seccompFd),
        shell: false,
        env: {
          ...(Sandbox.isEnabled(userPreferences, game)
            ? buildSandboxEnv(process.env)
            : process.env),
          ...resolved.env,
        },
      });

      child.once("spawn", () => {
        child.unref();
        resolve();
      });

      child.once("error", reject);
    });

    return true;
  } catch (error) {
    logger.error("Failed to launch winetricks", error);
    return false;
  } finally {
    closeSeccompFd(seccompFd);
  }
};

registerEvent("openGameWinetricks", openGameWinetricks);
