import type { SteamAchievement } from "@types";

interface NewAchievement {
  name: string;
  unlockTime: number;
}

/**
 * Pairs each newly unlocked achievement with its metadata, oldest first.
 *
 * Metadata can be missing: the first unlock can happen before the metadata
 * fetch completes, or during an offline session. Such an unlock still becomes
 * a notification, with its raw `name` as the title, so it is never dropped.
 */
export const resolveNotifiedAchievements = (
  newAchievements: NewAchievement[],
  achievementsData: SteamAchievement[]
): SteamAchievement[] =>
  newAchievements
    .toSorted((a, b) => a.unlockTime - b.unlockTime)
    .map(
      (achievement) =>
        achievementsData.find(
          (steamAchievement) =>
            achievement.name.toUpperCase() ===
            steamAchievement.name.toUpperCase()
        ) ?? {
          name: achievement.name,
          displayName: achievement.name,
          icon: "",
          icongray: "",
          hidden: false,
        }
    );
