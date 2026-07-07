import { spawn } from "node:child_process";
import { registerEvent } from "../register-event";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { logger, Wine } from "@main/services";
import type { GameShop, UserPreferences } from "@types";
import { wrapWithSandbox } from "@main/helpers/sandbox-launch";

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

  const winePrefixPath = Wine.getEffectivePrefixPath(
    game.winePrefixPath,
    objectId
  );

  if (!winePrefixPath) {
    return false;
  }

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const resolved = wrapWithSandbox(
    { command: "winetricks", args: [], env: { WINEPREFIX: winePrefixPath } },
    {
      userPreferences,
      game,
      gameDir: winePrefixPath,
      winePrefix: winePrefixPath,
    }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolved.command, resolved.args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        env: {
          ...process.env,
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
  }
};

registerEvent("openGameWinetricks", openGameWinetricks);
