import type { AchievementNotificationInfo, SteamAchievement } from "@types";

const isRareAchievement = (points: number) => {
  const rawPercentage = (50 - Math.sqrt(points)) * 2;

  return rawPercentage < 10;
};

interface NewAchievement {
  name: string;
  unlockTime: number;
}

/**
 * Builds the notification payload for newly unlocked achievements.
 *
 * Every newly unlocked achievement is paired with its metadata when available.
 * When metadata is missing (e.g. the first unlock happens before the metadata
 * fetch completes, or during a genuinely offline session) the achievement is
 * still turned into a notification using its raw `name` as the title and safe
 * fallbacks for the remaining fields, so unlocks are never silently dropped.
 */
export const buildAchievementNotificationInfo = (
  newAchievements: NewAchievement[],
  achievementsData: SteamAchievement[],
  previouslyUnlockedCount: number
): AchievementNotificationInfo[] => {
  const sortedNewAchievements = [...newAchievements].toSorted((a, b) => {
    return a.unlockTime - b.unlockTime;
  });

  return sortedNewAchievements.map((achievement, index) => {
    const steamAchievement = achievementsData.find((steamAchievement) => {
      return (
        achievement.name.toUpperCase() === steamAchievement.name.toUpperCase()
      );
    });

    return {
      title: steamAchievement?.displayName ?? achievement.name,
      description: steamAchievement?.description,
      points: steamAchievement?.points,
      isHidden: steamAchievement?.hidden ?? false,
      isRare: steamAchievement?.points
        ? isRareAchievement(steamAchievement.points)
        : false,
      isPlatinum:
        achievementsData.length > 0 &&
        index === sortedNewAchievements.length - 1 &&
        newAchievements.length + previouslyUnlockedCount ===
          achievementsData.length,
      iconUrl: steamAchievement?.icon ?? "",
    };
  });
};
