import fs from "node:fs";
import path from "node:path";

/**
 * Minimal logger surface used by the matching helpers. Kept electron-free so
 * this module can be unit-tested in isolation (mirrors the silent-logger
 * pattern used by the emulation save store tests).
 */
export interface MatchLogger {
  error: (message: string, ...args: unknown[]) => void;
}

const noopLogger: MatchLogger = { error: () => {} };

/**
 * Top-level `drive_c` subdirectories that never contain a game install and are
 * huge to walk. Compared case-insensitively.
 */
const DRIVE_C_SKIP_DIRS = new Set(["windows", "programdata"]);

export interface CandidateDirectory {
  /** Absolute path of the directory to search. */
  path: string;
  /**
   * When true, `path` is a wine prefix `drive_c` and the top-level `windows`
   * and `ProgramData` subdirectories are skipped during the walk.
   */
  isDriveC?: boolean;
}

/**
 * Recursively searches a folder for a file whose lowercased name is present in
 * `executableNames`. Returns the absolute path of the first match, or null.
 * Never throws: fs errors are logged and treated as "no match".
 */
export async function findExecutableInFolder(
  folderPath: string,
  executableNames: Set<string>,
  logger: MatchLogger = noopLogger
): Promise<string | null> {
  try {
    const entries = await fs.promises.readdir(folderPath, {
      withFileTypes: true,
      recursive: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const fileName = entry.name.toLowerCase();

      if (executableNames.has(fileName)) {
        const parentPath =
          "parentPath" in entry ? entry.parentPath : folderPath;

        return path.join(parentPath, entry.name);
      }
    }
  } catch (err) {
    logger.error(
      `[LocateGameExecutable] Error reading folder ${folderPath}:`,
      err
    );
  }

  return null;
}

/**
 * Searches a wine prefix `drive_c` directory. The huge, install-free top-level
 * `windows` and `ProgramData` directories are skipped (case-insensitive); every
 * other top-level entry is scanned recursively, and files that live directly in
 * `drive_c` are matched too. Never throws.
 */
export async function findExecutableInDriveC(
  driveCPath: string,
  executableNames: Set<string>,
  logger: MatchLogger = noopLogger
): Promise<string | null> {
  let entries: fs.Dirent[];

  try {
    entries = await fs.promises.readdir(driveCPath, { withFileTypes: true });
  } catch (err) {
    logger.error(
      `[LocateGameExecutable] Error reading drive_c ${driveCPath}:`,
      err
    );
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (DRIVE_C_SKIP_DIRS.has(entry.name.toLowerCase())) continue;

      const found = await findExecutableInFolder(
        path.join(driveCPath, entry.name),
        executableNames,
        logger
      );
      if (found) return found;
    } else if (entry.isFile()) {
      if (executableNames.has(entry.name.toLowerCase())) {
        return path.join(driveCPath, entry.name);
      }
    }
  }

  return null;
}

/**
 * Searches an ordered list of candidate directories and returns the first
 * matching executable path, or null. `drive_c` candidates honor the
 * windows/ProgramData exclusion.
 */
export async function searchCandidateDirectories(
  candidates: CandidateDirectory[],
  executableNames: Set<string>,
  logger: MatchLogger = noopLogger
): Promise<string | null> {
  for (const candidate of candidates) {
    const found = candidate.isDriveC
      ? await findExecutableInDriveC(candidate.path, executableNames, logger)
      : await findExecutableInFolder(candidate.path, executableNames, logger);

    if (found) return found;
  }

  return null;
}
