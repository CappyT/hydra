import fs from "node:fs";
import path from "node:path";
import { BWRAP_PATH } from "./sandbox-command-builder.js";

export interface ExtractionSandboxBind {
  path: string;
  writable: boolean;
}

/**
 * The archive plus the regular files next to it that share its name up to the
 * first dot: the other volumes of a multi-volume set (`.7z.001`, `.part2.rar`,
 * `.r00`, `.z01`). Binding these files instead of their folder keeps the rest
 * of the folder, which can be a user folder, away from 7-Zip.
 */
export const listArchiveVolumes = (archivePath: string): string[] => {
  const resolved = path.resolve(archivePath);
  const directory = path.dirname(resolved);
  const name = path.basename(resolved);
  const dot = name.indexOf(".", 1);
  if (dot < 0) return [resolved];

  const stem = name.slice(0, dot + 1);
  try {
    const volumes = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(stem))
      .map((entry) => path.join(directory, entry.name));
    return volumes.includes(resolved) ? volumes : [resolved, ...volumes];
  } catch {
    return [resolved];
  }
};

const isInside = (parent: string, candidate: string) =>
  candidate === parent || candidate.startsWith(parent + path.sep);

const depth = (target: string) => target.split(path.sep).length;

// A read-only bind inside a writable one adds nothing and, mounted later,
// would make part of the writable tree read-only. The rest go shallow first
// so the more specific bind wins.
const orderBinds = (binds: ExtractionSandboxBind[]) => {
  const resolved = binds.map((bind) => ({
    ...bind,
    path: path.resolve(bind.path),
  }));
  const writable = resolved.filter((bind) => bind.writable);

  return resolved
    .filter(
      (bind) =>
        bind.writable ||
        !writable.some((other) => isInside(other.path, bind.path))
    )
    .sort((a, b) => depth(a.path) - depth(b.path));
};

/**
 * Wraps a 7-Zip invocation in bwrap: no network, no host home, only /usr, the
 * binary and the given binds. Writes through a symlink that leaves the
 * writable bind land on the sandbox tmpfs or fail on a read-only bind.
 */
export const buildExtractionSandboxArgs = (
  command: string,
  args: string[],
  { binds, chdir }: { binds: ExtractionSandboxBind[]; chdir: string }
): { command: string; args: string[] } => {
  const bwrapArgs = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];

  for (const bind of orderBinds(binds)) {
    bwrapArgs.push(
      bind.writable ? "--bind" : "--ro-bind",
      bind.path,
      bind.path
    );
  }

  // The bundled 7zzs lives under the AppImage mount in /tmp, which the tmpfs
  // above hides.
  bwrapArgs.push("--ro-bind", command, command);
  bwrapArgs.push("--chdir", path.resolve(chdir), "--", command, ...args);

  return { command: BWRAP_PATH, args: bwrapArgs };
};
