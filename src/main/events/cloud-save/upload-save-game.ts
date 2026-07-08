import { CloudSync } from "@main/services";
import { registerEvent } from "../register-event";
import type { GameShop } from "@types";

const uploadSaveGame = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  downloadOptionTitle: string | null
) => {
  const artifact = await CloudSync.uploadSaveGame(
    objectId,
    shop,
    downloadOptionTitle,
    CloudSync.getBackupLabel(false)
  );

  // Advance the sync marker to this manual backup and enforce retention so the
  // list stays bounded regardless of how the backup was triggered.
  await CloudSync.finalizeBackup(shop, objectId, artifact);
};

registerEvent("uploadSaveGame", uploadSaveGame);
