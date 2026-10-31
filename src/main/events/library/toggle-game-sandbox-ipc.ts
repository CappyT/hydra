import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const toggleGameSandboxIpc = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  sandboxShareIpc: boolean
) => {
  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, { sandboxShareIpc });
};

registerEvent("toggleGameSandboxIpc", toggleGameSandboxIpc);
