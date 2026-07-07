import { db, levelKeys } from "@main/level";
import type { GameArtifact, LocalArtifact, UserPreferences } from "@types";
import type { ArtifactStorageBackend } from "./artifact-storage-backend";
import { LocalDirectoryBackend } from "./local-directory-backend";
import { RcloneBackend } from "./rclone-backend";

export * from "./artifact-storage-backend";
export * from "./local-directory-backend";
export * from "./rclone-backend";

/**
 * Resolves the artifact storage backend selected in the user's preferences.
 * Defaults to the local directory backend when nothing is configured. Reads
 * preferences fresh on every call so settings changes take effect immediately.
 */
export const getArtifactBackend = async (): Promise<ArtifactStorageBackend> => {
  const preferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  if (preferences?.backupBackend === "rclone") {
    return new RcloneBackend(preferences.rcloneRemote);
  }

  return new LocalDirectoryBackend(preferences?.backupLocalPath);
};

/**
 * Maps a local artifact onto the {@link GameArtifact} shape the renderer/UI
 * already consumes, so the components need no structural changes.
 */
export const localArtifactToGameArtifact = (
  artifact: LocalArtifact
): GameArtifact => ({
  id: artifact.id,
  artifactLengthInBytes: artifact.sizeBytes,
  downloadOptionTitle: artifact.downloadOptionTitle,
  createdAt: artifact.createdAt,
  updatedAt: artifact.createdAt,
  hostname: artifact.hostname,
  downloadCount: 0,
  label: artifact.label,
  isFrozen: artifact.isFrozen,
});
