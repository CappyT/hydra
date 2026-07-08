import { gamesSublevel, levelKeys } from "@main/level";
import type { Game, GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameSeccompLevel = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  seccompLevel: Game["seccompLevel"]
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return;

  await gamesSublevel.put(gameKey, {
    ...game,
    seccompLevel,
  });
};

registerEvent("updateGameSeccompLevel", updateGameSeccompLevel);
