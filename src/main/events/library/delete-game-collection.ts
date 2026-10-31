import { registerEvent } from "../register-event";
import { gameCollectionsSublevel, gamesSublevel } from "@main/level";
import { updateGameRecord } from "@main/services/game-record-updater";

/**
 * Deletes a local collection and strips its id from every game's membership.
 * Games themselves stay in the library.
 */
const deleteGameCollection = async (
  _event: Electron.IpcMainInvokeEvent,
  collectionId: string
): Promise<void> => {
  await gameCollectionsSublevel.del(collectionId);

  const entries = await gamesSublevel.iterator().all();

  for (const [gameKey, game] of entries) {
    if (!game.collectionIds?.includes(collectionId)) continue;

    await updateGameRecord(gameKey, (current) => ({
      collectionIds: current.collectionIds?.filter((id) => id !== collectionId),
    }));
  }
};

registerEvent("deleteGameCollection", deleteGameCollection);
