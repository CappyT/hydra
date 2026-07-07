import { registerEvent } from "../register-event";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import type { GameShop } from "@types";
import { GameExecutables, logger } from "@main/services";
import { updateGameExecutablePath } from "@main/helpers/update-executable-path";
import {
  getExecutablePickerDefaultPath as computePickerDefaultPath,
  getGameCandidateDirectories,
} from "@main/helpers/locate-game-executable";
import { searchCandidateDirectories } from "@main/helpers/locate-game-executable-match";

/**
 * Targeted, per-game scan for the installed executable. On Linux the game is
 * installed into its wine prefix `drive_c` (or the per-game sandbox home) by the
 * Windows installer, which the generic `scanInstalledGames` Windows paths never
 * cover. Returns the found (and persisted) executable path, the existing one if
 * already set, or null. Never throws on fs errors.
 */
const locateGameExecutable = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<string | null> => {
  try {
    const gameKey = levelKeys.game(shop, objectId);
    const game = await gamesSublevel.get(gameKey).catch(() => null);

    if (!game || game.isDeleted) return null;
    if (game.executablePath) return game.executablePath;

    const executableNames = GameExecutables.getExecutablesForGame(objectId);
    if (!executableNames || executableNames.length === 0) return null;

    const normalizedNames = new Set(
      executableNames.map((name) => name.toLowerCase())
    );

    const download = await downloadsSublevel.get(gameKey).catch(() => null);
    const candidates = await getGameCandidateDirectories(
      shop,
      objectId,
      game,
      download
    );

    const foundPath = await searchCandidateDirectories(
      candidates,
      normalizedNames,
      logger
    );

    if (!foundPath) return null;

    await gamesSublevel.put(gameKey, updateGameExecutablePath(game, foundPath));

    logger.info(
      `[LocateGameExecutable] Found executable for ${objectId}: ${foundPath}`
    );

    return foundPath;
  } catch (error) {
    logger.error("[LocateGameExecutable] Failed to locate executable", error);
    return null;
  }
};

/**
 * Best default directory for the manual executable picker dialog. Prefers the
 * directory of a set executable, then the game's wine prefix `drive_c`. Returns
 * null when the renderer should fall back to the downloads folder.
 */
const getExecutablePickerDefaultPath = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<string | null> => {
  try {
    const gameKey = levelKeys.game(shop, objectId);
    const game = await gamesSublevel.get(gameKey).catch(() => null);

    return computePickerDefaultPath(objectId, game);
  } catch (error) {
    logger.error(
      "[LocateGameExecutable] Failed to compute picker default path",
      error
    );
    return null;
  }
};

registerEvent("locateGameExecutable", locateGameExecutable);
registerEvent("getExecutablePickerDefaultPath", getExecutablePickerDefaultPath);
