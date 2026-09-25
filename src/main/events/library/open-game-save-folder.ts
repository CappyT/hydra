import { shell } from "electron";
import { registerEvent } from "../register-event";
import type { GameShop } from "@types";
import fs from "node:fs";
import { openExistingGameSaveFolder } from "./open-game-save-folder-core";

const openGameSaveFolder = async (
  _event: Electron.IpcMainInvokeEvent,
  _shop: GameShop,
  _objectId: string,
  saveFolderPath: string
): Promise<boolean> => {
  return openExistingGameSaveFolder({
    saveFolderPath,
    platform: process.platform,
    // Save paths live in dirs the sandboxed game can write: never hand a
    // file to xdg-open, it would run with the host's default handler.
    exists: (folderPath) =>
      fs.statSync(folderPath, { throwIfNoEntry: false })?.isDirectory() ??
      false,
    openPath: (folderPath) => shell.openPath(folderPath),
  });
};

registerEvent("openGameSaveFolder", openGameSaveFolder);
