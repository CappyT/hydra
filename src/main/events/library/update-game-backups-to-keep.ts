import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameBackupsToKeep = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  backupsToKeep: number | null
) => {
  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, {
    // `null` clears the per-game override so the global default applies again.
    backupsToKeep: backupsToKeep ?? undefined,
  });
};

registerEvent("updateGameBackupsToKeep", updateGameBackupsToKeep);
