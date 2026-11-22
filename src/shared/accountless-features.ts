import { ACCOUNTLESS } from "./accountless";

/**
 * Remote feature flags (`GET /features`) whose surface needs a Hydra account.
 * Under ACCOUNTLESS they read as off, so upstream code that keys a feature on
 * the flag hides it at the source, even while the API serves the flag as on.
 */
export const ACCOUNT_ONLY_FEATURES: ReadonlySet<string> = new Set([
  "CHAT_IMAGES",
  "SCREENSHOT_COMMENTS",
  "GLOBAL_LEADERBOARDS",
  "GAME_LEADERBOARDS_EXTENDED",
  "LEADERBOARD_REPORTS",
  "LEADERBOARD_BADGES",
  "LEADERBOARD_WRITES",
]);

export const filterAccountlessFeatures = <T>(features: T): T =>
  ACCOUNTLESS && Array.isArray(features)
    ? (features.filter((feature) => !ACCOUNT_ONLY_FEATURES.has(feature)) as T)
    : features;
