import fs from "node:fs";
import path from "node:path";

const isExecutableFile = (filePath: string): boolean => {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves the first of the given executables available on the system, so that
 * a distro-packaged (signed) binary is preferred over any bundled copy. Each
 * candidate may be a bare command name (looked up on PATH) or an absolute path.
 * Returns the resolved absolute path, or null when none is found.
 */
export const resolveSystemBinary = (candidates: string[]): string | null => {
  const pathDirectories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (isExecutableFile(candidate)) return candidate;
      continue;
    }

    for (const directory of pathDirectories) {
      const candidatePath = path.join(directory, candidate);
      if (isExecutableFile(candidatePath)) return candidatePath;
    }
  }

  return null;
};
