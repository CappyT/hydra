import fs from "node:fs";
import path from "node:path";

import { within } from "../../helpers/sandbox-paths";

export interface PortRomMeta {
  copyTo?: { linux?: string };
  imported?: { linux?: string[] };
  path?: { config?: { file?: string } };
}

/** Host files that the ROM setup copies, reads back or edits for a port. */
export const getRomSetupTemplates = (rom: PortRomMeta | undefined) =>
  [
    rom?.copyTo?.linux,
    ...(rom?.imported?.linux ?? []),
    rom?.path?.config?.file,
  ].filter((template): template is string => Boolean(template));

const TRACK_LIST_PATTERNS: Record<string, RegExp> = {
  ".cue": /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i,
  ".gdi": /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/,
};
const SIDECAR_EXTENSIONS: Record<string, string[]> = {
  ".cue": [".sbi", ".sub"],
  ".ccd": [".img", ".sub"],
  ".mds": [".mdf"],
};

const readLines = async (file: string) =>
  (await fs.promises.readFile(file, "utf-8").catch(() => "")).split(/\r?\n/);

/** Names listed by a disc index: only plain file names count. */
const listedNames = async (indexFile: string): Promise<string[]> => {
  const extension = path.extname(indexFile).toLowerCase();
  const pattern = TRACK_LIST_PATTERNS[extension];
  const names = pattern
    ? (await readLines(indexFile)).flatMap((line) => {
        const match = pattern.exec(line);
        return match ? [match[1] ?? match[2]] : [];
      })
    : [];
  const stem = path.basename(indexFile).slice(0, -extension.length);
  names.push(...(SIDECAR_EXTENSIONS[extension] ?? []).map((ext) => stem + ext));
  return names.filter((name) => name && name === path.basename(name));
};

/**
 * The files of a ROM: the file itself, plus the tracks a disc index lists in
 * its own folder and its same-name sidecars (`.sbi`, `.sub`, ...). An `.m3u`
 * playlist adds each listed disc and its tracks. Names match the folder
 * case-insensitively, as emulators do. A name with a folder part, or a track
 * whose real path leaves the index folder, is ignored, so a downloaded index
 * cannot pull an unrelated host file into the sandbox.
 */
export const listRomFiles = async (romPath: string): Promise<string[]> => {
  const folder = path.dirname(romPath);
  const realFolder = await fs.promises.realpath(folder).catch(() => null);
  const entries = await fs.promises
    .readdir(folder, { withFileTypes: true })
    .catch(() => []);
  const byLowerName = new Map<string, string>(
    entries.map((entry): [string, string] => [
      entry.name.toLowerCase(),
      entry.name,
    ])
  );

  const resolveListed = async (name: string) => {
    const actual = byLowerName.get(name.toLowerCase());
    if (!actual || !realFolder) return null;
    const file = path.join(folder, actual);
    const real = await fs.promises.realpath(file).catch(() => null);
    const stat = real ? await fs.promises.stat(real).catch(() => null) : null;
    return real && stat?.isFile() && path.dirname(real) === realFolder
      ? file
      : null;
  };

  const files = new Set<string>();
  if ((await fs.promises.stat(romPath).catch(() => null))?.isFile()) {
    files.add(romPath);
  }
  const indexes = [romPath];
  if (path.extname(romPath).toLowerCase() === ".m3u") {
    for (const line of await readLines(romPath)) {
      const name = line.trim();
      if (!name || name.startsWith("#") || name !== path.basename(name)) {
        continue;
      }
      const disc = await resolveListed(name);
      if (disc) {
        files.add(disc);
        indexes.push(disc);
      }
    }
  }
  for (const index of indexes) {
    for (const name of await listedNames(index)) {
      const track = await resolveListed(name);
      if (track) files.add(track);
    }
  }
  return [...files];
};

/**
 * The host paths a sandboxed port needs beyond its own install folder: the
 * folders of `setupFiles` read-write, and the ROM files read-only unless a
 * read-write bind already covers them.
 */
export const getRecompilationSandboxPaths = (
  installDirectory: string,
  setupFiles: string[],
  romFiles: string[]
) => {
  const binds = [
    ...new Set(setupFiles.map((file) => path.dirname(file))),
  ].filter((directory) => !within(installDirectory, directory));

  const roBinds = romFiles.filter(
    (file) => ![installDirectory, ...binds].some((root) => within(root, file))
  );

  return { binds, roBinds };
};

/** Read-only system trees a port release may link into, such as a bundled /usr/lib alias. */
const SYSTEM_LINK_ROOTS = ["/usr", "/etc"];

/**
 * Removes every entry under `root` that could redirect or stall a launcher
 * write: a symlink that does not resolve inside `root` or a read-only system
 * tree (dangling links included), and anything that is neither a file nor a
 * folder (FIFOs, sockets, devices). The sandboxed port can write `root`; the
 * launcher reads markers there and extracts updates, copies ROMs and writes
 * configs afterwards. Call it only while the port is not running.
 */
export const removeEscapingSymlinks = async (root: string) => {
  const realRoot = await fs.promises.realpath(root).catch(() => null);
  if (!realRoot) return;

  const pending = [realRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs.promises
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile()) continue;

      if (entry.isSymbolicLink()) {
        const target = await fs.promises.realpath(entryPath).catch(() => null);
        if (
          target &&
          [realRoot, ...SYSTEM_LINK_ROOTS].some((allowed) =>
            within(allowed, target)
          )
        ) {
          continue;
        }
      }
      await fs.promises.unlink(entryPath);
    }
  }
};
