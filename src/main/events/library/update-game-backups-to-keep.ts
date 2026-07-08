import { gamesSublevel, levelKeys } from "@main/level";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameBackupsToKeep = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  backupsToKeep: number | null
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return;

  await gamesSublevel.put(gameKey, {
    ...game,
    // `null` clears the per-game override so the global default applies again.
    backupsToKeep: backupsToKeep ?? undefined,
  });
};

registerEvent("updateGameBackupsToKeep", updateGameBackupsToKeep);
