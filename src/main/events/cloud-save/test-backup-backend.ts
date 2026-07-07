import { registerEvent } from "../register-event";
import type { BackupBackend, BackupBackendTestResult } from "@types";
import { LocalDirectoryBackend, RcloneBackend } from "@main/services";

/**
 * Tests a backup backend configuration without persisting it, so the settings
 * UI can validate before the user saves.
 */
const testBackupBackend = async (
  _event: Electron.IpcMainInvokeEvent,
  backend: BackupBackend,
  config: { localPath?: string | null; rcloneRemote?: string | null }
): Promise<BackupBackendTestResult> => {
  if (backend === "rclone") {
    return new RcloneBackend(config.rcloneRemote).test();
  }

  return new LocalDirectoryBackend(config.localPath).test();
};

registerEvent("testBackupBackend", testBackupBackend);
