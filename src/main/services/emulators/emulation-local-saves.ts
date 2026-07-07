import { backupsPath } from "@main/constants";
import { db, levelKeys } from "@main/level";
import type { EmulationCloudSave, UserPreferences } from "@types";

import { logger } from "../logger";
import { EmulationSaveStore } from "./emulation-save-store";
import type { UploadEmulationSaveInput } from "./emulation-save-store";

/*
 * Local emulation-saves client. Exposes the same surface the events layer used
 * to reach through the Hydra Cloud `/profile/emulation-saves` API — now backed
 * entirely by {@link EmulationSaveStore} on the user's filesystem. No HydraApi,
 * no auth, no subscription. Preferences are read fresh per call (mirroring
 * `getArtifactBackend`) so a changed backup path takes effect immediately.
 *
 * Unlike save-game backups, the rclone backend does not apply here: memory-card
 * saves are tiny and stay on the local disk by design.
 */

export { toEmulationSaveEmulator } from "./emulation-save-store";
export type { UploadEmulationSaveInput } from "./emulation-save-store";

const resolveStore = async (): Promise<EmulationSaveStore> => {
  const preferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const localPath = preferences?.backupLocalPath;
  const root =
    localPath && localPath.trim().length > 0 ? localPath : backupsPath;

  return new EmulationSaveStore(root, logger);
};

export const uploadEmulationSave = async (
  input: UploadEmulationSaveInput
): Promise<EmulationCloudSave> => (await resolveStore()).upload(input);

export const listEmulationSaves = async (
  platform: EmulationCloudSave["platform"],
  emulator: EmulationCloudSave["emulator"],
  objectId?: string | null
): Promise<EmulationCloudSave[]> =>
  (await resolveStore()).list(platform, emulator, objectId);

export const downloadEmulationSaveBytes = async (id: string): Promise<Buffer> =>
  (await resolveStore()).downloadBytes(id);

export const deleteEmulationSave = async (id: string): Promise<void> => {
  await (await resolveStore()).delete(id);
};

export const updateEmulationSave = async (
  id: string,
  body: { label?: string | null; metadata?: Record<string, unknown> | null }
): Promise<EmulationCloudSave> => (await resolveStore()).update(id, body);
