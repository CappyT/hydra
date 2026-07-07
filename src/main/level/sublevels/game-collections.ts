import type { GameCollectionRecord } from "@types";

import { db } from "../level";
import { levelKeys } from "./keys";

/**
 * Local registry of game collections (accountless fork). A collection stores
 * only its identity here; per-game membership lives on each game record's
 * `collectionIds` field (see `assign-game-to-collection.ts`). The key is the
 * collection id.
 */
export const gameCollectionsSublevel = db.sublevel<
  string,
  GameCollectionRecord
>(levelKeys.gameCollections, {
  valueEncoding: "json",
});
