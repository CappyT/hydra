import fs from "node:fs";
import path from "node:path";

const isStrictlyInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const realpathOrNull = (value: string): string | null => {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
};

/**
 * Picks the directory the sandbox binds read-write for a game executable. An
 * executable inside its download's install dir (`<downloadPath>/<folderName>`)
 * gets the whole install dir, so an exe in `Binaries/Win64/` still sees the
 * assets in its parent dirs. Anything else keeps the executable's own dir. The
 * downloads root itself is never returned: it holds other games.
 */
export const resolveSandboxGameDir = (
  executablePath: string,
  download?: { downloadPath?: string | null; folderName?: string | null } | null
): string => {
  const executableDir = path.dirname(executablePath);
  if (!download?.downloadPath || !download.folderName) return executableDir;

  const downloadRoot = path.resolve(download.downloadPath);
  const installDir = path.resolve(downloadRoot, download.folderName);
  if (!isStrictlyInside(downloadRoot, installDir)) return executableDir;

  const realInstallDir = realpathOrNull(installDir);
  const realExecutable = realpathOrNull(executablePath);
  const realDownloadRoot = realpathOrNull(downloadRoot);
  if (!realInstallDir || !realExecutable || !realDownloadRoot)
    return executableDir;
  if (!isStrictlyInside(realDownloadRoot, realInstallDir)) return executableDir;

  return isStrictlyInside(realInstallDir, realExecutable)
    ? installDir
    : executableDir;
};
