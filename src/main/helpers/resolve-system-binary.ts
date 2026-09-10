import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TRUSTED_SYSTEM_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
];

/** Reject writable ancestors and symlink targets outside the selected trust root. */
export const isTrustedExecutable = (
  candidate: string,
  root: string,
  owner: number
): boolean => {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonical = fs.realpathSync(candidate);
    if (!canonical.startsWith(canonicalRoot + path.sep)) return false;
    if (!fs.statSync(canonical).isFile()) return false;
    fs.accessSync(canonical, fs.constants.X_OK);
    for (let current = canonical; ; current = path.dirname(current)) {
      const stat = fs.statSync(current);
      if ((stat.uid !== 0 && stat.uid !== owner) || (stat.mode & 0o022) !== 0)
        return false;
      if (current === path.dirname(current)) break;
    }
    return true;
  } catch {
    return false;
  }
};

/** Ignore PATH entirely. System tools win; the owner-controlled SteamOS fallback is last. */
export const resolveSystemBinary = (candidates: string[]): string | null => {
  const roots = [
    ...TRUSTED_SYSTEM_BIN_DIRS.map((directory) => ({ directory, owner: 0 })),
    {
      directory: path.join(os.homedir(), ".local", "bin"),
      owner: process.getuid?.() ?? 0,
    },
  ];
  for (const { directory, owner } of roots) {
    for (const candidate of candidates) {
      if (!candidate || candidate.includes("\0")) continue;
      const target = path.isAbsolute(candidate)
        ? candidate
        : path.join(directory, candidate);
      if (candidate.includes(path.sep) && !path.isAbsolute(candidate)) continue;
      if (isTrustedExecutable(target, directory, owner)) return target;
    }
  }
  return null;
};
