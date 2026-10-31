import { registerEvent } from "../register-event";
import type { GameShop } from "@types";
import { CloudSync } from "@main/services";

const getGameBackupPreview = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop
) => CloudSync.getBackupPreview(shop, objectId);

registerEvent("getGameBackupPreview", getGameBackupPreview);
