import { registerEvent } from "../register-event";
import { RetroAchievementsClient } from "@main/services/retro-achievements/retro-achievements-client";
import { logger } from "@main/services";

export interface ValidateRetroAchievementsWebApiKeyResult {
  valid: boolean;
  userId: string | null;
}

/**
 * Accountless fork: validates a RetroAchievements Web API key by calling the
 * RetroAchievements Web API directly (main process, no CORS), instead of the
 * Hydra profile integration endpoint. A 200 with a matching profile means the
 * credentials are valid; a 401 / non-JSON response means they are not.
 */
const validateRetroAchievementsWebApiKey = async (
  _event: Electron.IpcMainInvokeEvent,
  username: string,
  webApiKey: string
): Promise<ValidateRetroAchievementsWebApiKeyResult> => {
  const trimmedUsername = (username ?? "").trim();
  const trimmedWebApiKey = (webApiKey ?? "").trim();

  if (!trimmedUsername || !trimmedWebApiKey) {
    return { valid: false, userId: null };
  }

  try {
    const profile = await RetroAchievementsClient.getUserProfile({
      username: trimmedUsername,
      webApiKey: trimmedWebApiKey,
    });

    if (!profile || typeof profile.User !== "string") {
      return { valid: false, userId: null };
    }

    const userId =
      profile.ULID ?? (profile.ID != null ? String(profile.ID) : null);

    return { valid: true, userId };
  } catch (error) {
    logger.error("Failed to validate RetroAchievements Web API key", error);
    return { valid: false, userId: null };
  }
};

registerEvent(
  "validateRetroAchievementsWebApiKey",
  validateRetroAchievementsWebApiKey
);
