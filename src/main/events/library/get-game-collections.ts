import { registerEvent } from "../register-event";
import { gameCollectionsSublevel, gamesSublevel } from "@main/level";
import type { GameCollection } from "@types";

/**
 * Lists local collections, deriving `gamesCount` from per-game membership
 * (`Game.collectionIds`). Mirrors the shape returned by the former
 * server-backed `/profile/games/collections` endpoint.
 */
const getGameCollections = async (): Promise<GameCollection[]> => {
  const [collections, games] = await Promise.all([
    gameCollectionsSublevel.values().all(),
    gamesSublevel.values().all(),
  ]);

  const counts = new Map<string, number>();
  for (const game of games) {
    if (game.isDeleted) continue;

    for (const collectionId of game.collectionIds ?? []) {
      counts.set(collectionId, (counts.get(collectionId) ?? 0) + 1);
    }
  }

  return collections
    .map((collection) => ({
      id: collection.id,
      name: collection.name,
      gamesCount: counts.get(collection.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

registerEvent("getGameCollections", getGameCollections);
