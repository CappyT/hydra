import { gamesSublevel, levelKeys } from "@main/level";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const updateGameSandboxPaths = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  sandboxExtraPaths: string[]
) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game) return;

  const sanitizedPaths = Array.from(
    new Set(
      (sandboxExtraPaths ?? []).map((value) => value.trim()).filter(Boolean)
    )
  );

  await gamesSublevel.put(gameKey, {
    ...game,
    sandboxExtraPaths: sanitizedPaths,
  });
};

registerEvent("updateGameSandboxPaths", updateGameSandboxPaths);
