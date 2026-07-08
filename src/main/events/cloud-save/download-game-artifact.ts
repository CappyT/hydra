import { CloudSync, logger, WindowManager } from "@main/services";
import { registerEvent } from "../register-event";
import path from "node:path";
import type { GameShop } from "@types";

import { addTrailingSlash } from "@main/helpers";

/**
 * Retained for upstream mergeability. The canonical restore implementation now
 * lives in {@link CloudSync.restoreArtifact} (shared with the launch-time
 * auto-sync); these standalone helpers are superseded and unreferenced.
 */
export const transformLudusaviBackupPathIntoWindowsPath = (
  backupPath: string,
  winePrefixPath?: string | null
) => {
  return backupPath
    .replace(winePrefixPath ? addTrailingSlash(winePrefixPath) : "", "")
    .replace("drive_c", "C:");
};

export const addWinePrefixToWindowsPath = (
  windowsPath: string,
  winePrefixPath?: string | null
) => {
  if (!winePrefixPath) {
    return windowsPath;
  }

  return path.join(winePrefixPath, windowsPath.replace("C:", "drive_c"));
};

const downloadGameArtifact = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  gameArtifactId: string
) => {
  try {
    await CloudSync.restoreArtifact(shop, objectId, gameArtifactId);

    WindowManager.sendToAppWindows(
      `on-backup-download-complete-${objectId}-${shop}`,
      true
    );
  } catch (err) {
    logger.error("Failed to download game artifact", err);

    WindowManager.sendToAppWindows(
      `on-backup-download-complete-${objectId}-${shop}`,
      false
    );
  }
};

registerEvent("downloadGameArtifact", downloadGameArtifact);
