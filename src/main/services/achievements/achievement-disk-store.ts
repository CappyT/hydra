import type { GameShop, SteamAchievement, UnlockedAchievement } from "@types";

/**
 * Accountless fork: durable backing for upstream's session-scoped
 * AchievementMemoryStore. Upstream dropped local persistence in favor of the
 * Hydra Cloud copy; without an account the disk is the only durable record,
 * so every memory-store write is mirrored to the gameAchievements sublevel
 * and the store is re-hydrated from it at startup (upstream wipes it
 * instead). Level access is imported lazily so this module stays loadable in
 * plain node:test runs.
 */

interface AchievementEntry {
  achievements: SteamAchievement[];
  unlockedAchievements: UnlockedAchievement[];
  language?: string;
  catalogueValidator?: string;
}

// Suspends the write-through while hydration replays disk entries into the
// memory store (each replay goes through AchievementMemoryStore.set, which
// would otherwise echo every record straight back to disk).
let hydrating = false;

export const parseGameKey = (
  key: string
): { shop: GameShop; objectId: string } | null => {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) return null;

  return {
    shop: key.slice(0, separatorIndex) as GameShop,
    objectId: key.slice(separatorIndex + 1),
  };
};

export const persistAchievementEntry = (
  shop: GameShop,
  objectId: string,
  entry: AchievementEntry
): void => {
  // process.type check: only a real Electron main process has the level DB
  // available; keeps the store importable/usable in plain node:test runs.
  // ACCOUNTLESS is also imported lazily for the same reason (no static value
  // imports — the memory store pulls this module into node:test).
  if (hydrating || process.type !== "browser") return;

  void (async () => {
    const { ACCOUNTLESS } = await import("@shared");
    if (!ACCOUNTLESS) return;

    const { gameAchievementsSublevel, levelKeys } = await import("@main/level");

    await gameAchievementsSublevel.put(levelKeys.game(shop, objectId), {
      achievements: entry.achievements,
      unlockedAchievements: entry.unlockedAchievements,
      language: entry.language,
      catalogueValidator: entry.catalogueValidator,
      updatedAt: Date.now(),
    });
  })().catch(async (error) => {
    const { achievementsLogger } = await import("../logger");
    achievementsLogger.error("Failed to persist achievements to disk", error);
  });
};

export const hydrateAchievementsFromDisk = async (): Promise<void> => {
  const { ACCOUNTLESS } = await import("@shared");
  if (!ACCOUNTLESS) return;

  const { gameAchievementsSublevel } = await import("@main/level");
  const { AchievementMemoryStore } = await import("./achievement-memory-store");

  hydrating = true;
  try {
    for await (const [key, value] of gameAchievementsSublevel.iterator()) {
      const parsed = parseGameKey(key);
      if (!parsed) continue;

      AchievementMemoryStore.set(parsed.shop, parsed.objectId, {
        achievements: value.achievements ?? [],
        unlockedAchievements: value.unlockedAchievements ?? [],
        language: value.language,
        catalogueValidator: value.catalogueValidator,
      });
    }
  } finally {
    hydrating = false;
  }
};
