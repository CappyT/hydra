import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";

/**
 * Name of the scratch directory used while restoring a backup. It lives under
 * the backups root but MUST never be treated as backend storage: the local
 * backend stores artifacts directly in `<root>/<shop>-<objectId>/`, so the
 * restore extraction can never reuse that folder or it would wipe the stored
 * `.tar`/`.json` files. Extraction happens under this dedicated dot-directory,
 * which the local backend skips when scanning for game folders.
 */
export const RESTORE_TMP_DIRNAME = ".restore-tmp";

/**
 * Whether a directory entry directly under the backups root is a real game
 * storage folder (`<shop>-<objectId>`) rather than a reserved scratch/cache
 * dot-directory such as `.restore-tmp`, `.rclone-tmp` or `.rclone-cache`.
 * Backend id-scans must skip the reserved ones so they are never mistaken for
 * game folders.
 */
export const isBackupStorageDir = (name: string) => !name.startsWith(".");

/** Scratch directory a given artifact is extracted into during restore. */
export const getRestoreScratchDir = (
  backupsRoot: string,
  shop: string,
  objectId: string
) => path.join(backupsRoot, RESTORE_TMP_DIRNAME, `${shop}-${objectId}`);

/**
 * Extracts a stored artifact tar into a fresh scratch directory, runs the
 * provided restore step against it, then removes the scratch directory.
 *
 * The scratch directory can never collide with backend storage, so no stored
 * backup is ever deleted. Only the scratch directory itself is rm-ed (before
 * extraction to start clean, and in a `finally` afterwards).
 */
export const restoreFromArtifactTar = async (options: {
  backupsRoot: string;
  shop: string;
  objectId: string;
  tarLocation: string;
  restore: (scratchDir: string) => void | Promise<void>;
}): Promise<void> => {
  const { backupsRoot, shop, objectId, tarLocation, restore } = options;

  const scratchDir = getRestoreScratchDir(backupsRoot, shop, objectId);

  if (fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  fs.mkdirSync(scratchDir, { recursive: true });

  try {
    await tar.x({ file: tarLocation, cwd: scratchDir });
    await restore(scratchDir);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
};
