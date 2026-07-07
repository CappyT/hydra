import { randomUUID } from "node:crypto";

import { registerEvent } from "../register-event";
import { gameCollectionsSublevel } from "@main/level";
import type { GameCollection } from "@types";

const createGameCollection = async (
  _event: Electron.IpcMainInvokeEvent,
  name: string
): Promise<GameCollection> => {
  const trimmedName = (name ?? "").trim();

  if (!trimmedName) {
    throw new Error("game/collection-name-required");
  }

  const existing = await gameCollectionsSublevel.values().all();
  const normalizedName = trimmedName.toLocaleLowerCase();

  if (
    existing.some(
      (collection) =>
        collection.name.trim().toLocaleLowerCase() === normalizedName
    )
  ) {
    throw new Error("game/collection-name-already-in-use");
  }

  const id = randomUUID();

  await gameCollectionsSublevel.put(id, {
    id,
    name: trimmedName,
    createdAt: new Date().toISOString(),
  });

  return { id, name: trimmedName, gamesCount: 0 };
};

registerEvent("createGameCollection", createGameCollection);
