import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { Game, GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameSeccompLevel = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  seccompLevel: Game["seccompLevel"]
) => {
  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, { seccompLevel });
};

registerEvent("updateGameSeccompLevel", updateGameSeccompLevel);
