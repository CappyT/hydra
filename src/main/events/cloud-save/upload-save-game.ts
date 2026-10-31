import { CloudSync } from "@main/services";
import { isGameRunning } from "@main/services/process-watcher";
import { registerEvent } from "../register-event";
import type { GameShop } from "@types";
import { runWithHydraSaveGuard } from "@main/services/epic/cloud-saves";

const uploadSaveGame = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  downloadOptionTitle: string | null
) => {
  // finalizeBackup clears unsyncedSince; mid-session that hides the session's
  // divergence from conflict detection if the game then crashes.
  if (isGameRunning(objectId, shop)) {
    throw new Error("Saves cannot be backed up while the game is running");
  }

  const artifact = await runWithHydraSaveGuard(() =>
    CloudSync.uploadSaveGame(
      objectId,
      shop,
      downloadOptionTitle,
      CloudSync.getBackupLabel(false)
    )
  );

  // Advance the sync marker to this manual backup and enforce retention so the
  // list stays bounded regardless of how the backup was triggered.
  await CloudSync.finalizeBackup(shop, objectId, artifact);
};

registerEvent("uploadSaveGame", uploadSaveGame);
