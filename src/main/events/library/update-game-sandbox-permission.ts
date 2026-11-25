import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import { isSandboxPermission } from "@main/services/sandbox-permissions";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

/** `null` clears the per-game value, so the game follows the global default. */
const updateGameSandboxPermission = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  permission: unknown,
  value: unknown
) => {
  if (!isSandboxPermission(permission)) {
    throw new Error("Unknown sandbox permission");
  }
  if (value !== null && typeof value !== "boolean") {
    throw new Error("Invalid sandbox permission value");
  }

  const gameKey = levelKeys.game(shop, objectId);
  await updateGameRecord(gameKey, { [permission]: value });
};

registerEvent("updateGameSandboxPermission", updateGameSandboxPermission);
