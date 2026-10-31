import { registerEvent } from "../register-event";
import { RetroAchievementsClient } from "@main/services/retro-achievements/retro-achievements-client";
import { logger } from "@main/services";
import axios from "axios";

export interface ValidateRetroAchievementsWebApiKeyResult {
  valid: boolean;
  userId: string | null;
}

/**
 * Accountless fork: validates a RetroAchievements Web API key by calling the
 * RetroAchievements Web API directly (main process, no CORS), instead of the
 * Hydra profile integration endpoint. A 200 with a matching profile means the
 * credentials are valid; a 401 / 403 / body without `User` means they are not.
 * Any other failure (offline, timeout, 5xx) is rethrown so the UI shows its
 * connect error instead of reporting a good key as invalid.
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
    // The AxiosError config holds the Web API key in its params: never log it.
    const status = axios.isAxiosError(error) ? error.response?.status : null;

    if (status === 401 || status === 403) {
      return { valid: false, userId: null };
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to validate RetroAchievements Web API key (status ${status ?? "none"}): ${message}`
    );
    throw new Error("retroachievements-validation-failed");
  }
};

registerEvent(
  "validateRetroAchievementsWebApiKey",
  validateRetroAchievementsWebApiKey
);
