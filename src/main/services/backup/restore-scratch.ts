import { assertStorageComponent } from "./artifact-validation.js";
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
) => {
  assertStorageComponent(shop);
  assertStorageComponent(objectId);
  return path.join(backupsRoot, RESTORE_TMP_DIRNAME, `${shop}-${objectId}`);
};

/**
 * Extracts a stored artifact tar into a fresh scratch directory, runs the
 * provided restore step against it, then removes the scratch directory.
 *
 * A unique scratch directory avoids races between simultaneous restores and
 * never collides with backend storage. Archive links and traversal are rejected.
 */
export const restoreFromArtifactTar = async (options: {
  backupsRoot: string;
  shop: string;
  objectId: string;
  tarLocation: string;
  restore: (scratchDir: string) => void | Promise<void>;
}): Promise<void> => {
  const { backupsRoot, shop, objectId, tarLocation, restore } = options;

  const prefix = getRestoreScratchDir(backupsRoot, shop, objectId);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const scratchDir = fs.mkdtempSync(prefix + "-");

  try {
    let unsafeEntry = false;
    await tar.x({
      file: tarLocation,
      cwd: scratchDir,
      strict: true,
      filter: (entryPath, entry) => {
        if (
          entryPath.startsWith("/") ||
          entryPath.split("/").includes("..") ||
          !("type" in entry && ["File", "Directory"].includes(entry.type))
        ) {
          unsafeEntry = true;
          return false;
        }
        return true;
      },
    });
    if (unsafeEntry) throw new Error("Unsafe backup archive entry");
    await restore(scratchDir);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
};
