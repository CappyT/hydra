import { registerEvent } from "../register-event";
import { gameCollectionsSublevel } from "@main/level";

const renameGameCollection = async (
  _event: Electron.IpcMainInvokeEvent,
  collectionId: string,
  name: string
): Promise<void> => {
  const trimmedName = (name ?? "").trim();

  if (!trimmedName) {
    throw new Error("game/collection-name-required");
  }

  const collection = await gameCollectionsSublevel.get(collectionId);

  if (!collection) {
    throw new Error("game/collection-not-found");
  }

  const existing = await gameCollectionsSublevel.values().all();
  const normalizedName = trimmedName.toLocaleLowerCase();

  if (
    existing.some(
      (item) =>
        item.id !== collectionId &&
        item.name.trim().toLocaleLowerCase() === normalizedName
    )
  ) {
    throw new Error("game/collection-name-already-in-use");
  }

  await gameCollectionsSublevel.put(collectionId, {
    ...collection,
    name: trimmedName,
  });
};

registerEvent("renameGameCollection", renameGameCollection);
