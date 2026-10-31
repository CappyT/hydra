import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const toggleGameSeccompAudit = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  seccompAudit: boolean
) => {
  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, { seccompAudit });
};

registerEvent("toggleGameSeccompAudit", toggleGameSeccompAudit);
