import { registerEvent } from "../register-event";
import { validateSteamGridDbApiKey } from "@main/services/steamgriddb/steamgriddb-client";

export interface ValidateSteamGridDbApiKeyResult {
  valid: boolean;
}

/**
 * Accountless fork: validates a SteamGridDB API key by probing the SteamGridDB
 * Web API directly (main process, no CORS), instead of relying on the logged-in
 * Hydra artwork proxy. A 2xx from the probe means the key is valid; anything
 * else (including a missing key or a network error) means it is not.
 */
const validateSteamGridDbApiKeyEvent = async (
  _event: Electron.IpcMainInvokeEvent,
  apiKey: string
): Promise<ValidateSteamGridDbApiKeyResult> => {
  const valid = await validateSteamGridDbApiKey((apiKey ?? "").trim());

  return { valid };
};

registerEvent("validateSteamGridDbApiKey", validateSteamGridDbApiKeyEvent);
