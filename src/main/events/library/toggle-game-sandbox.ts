import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const toggleGameSandbox = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  sandboxDisabled: boolean
) => {
  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, { sandboxDisabled });
};

registerEvent("toggleGameSandbox", toggleGameSandbox);
