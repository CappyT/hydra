import { levelKeys } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameSandboxPaths = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  sandboxExtraPaths: string[]
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const sanitizedPaths = Array.from(
    new Set(
      (sandboxExtraPaths ?? []).map((value) => value.trim()).filter(Boolean)
    )
  );

  await updateGameRecord(gameKey, { sandboxExtraPaths: sanitizedPaths });
};

registerEvent("updateGameSandboxPaths", updateGameSandboxPaths);
