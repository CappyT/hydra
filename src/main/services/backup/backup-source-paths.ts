import fs from "node:fs";
import path from "node:path";

/**
 * ludusavi runs on the host and reads game-writable directories. A save file
 * that is a symlink, or that resolves outside the save root, can pull a host
 * file (e.g. an SSH key) into the backup and, on restore, into the sandbox.
 * Throws on the first such path.
 */
export const assertBackupSourcesInsideRoot = (
  files: string[],
  saveRoot: string
): void => {
  const root = fs.realpathSync(saveRoot);

  for (const file of files) {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Backup refused: save file is a symlink: ${file}`);
    }

    const relative = path.relative(root, fs.realpathSync(file));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Backup refused: save file resolves outside ${saveRoot}: ${file}`
      );
    }
  }
};
