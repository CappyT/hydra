import fs from "node:fs";
import path from "node:path";
import { parseBuffer, writeBuffer } from "steam-shortcut-editor";

type ShortcutEntry = Record<string, unknown>;

const findKey = (entry: ShortcutEntry, name: string) =>
  Object.keys(entry).find((key) => key.toLowerCase() === name);

const unquote = (value: string) =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;

// Keeps the quoting style of the stored value (create-steam-shortcut quotes).
const requote = (stored: string, value: string) =>
  stored !== unquote(stored) ? `"${value}"` : value;

/**
 * Points every shortcut whose Exe is `oldPath` (quoted or not) at `newPath`.
 * StartDir moves too when it is still the directory of the old Exe; a custom
 * StartDir is left alone. Other shortcuts are returned untouched.
 */
export const rewriteShortcutTargets = <T extends object>(
  shortcuts: T[],
  oldPath: string,
  newPath: string
): { shortcuts: T[]; changed: number } => {
  let changed = 0;

  const rewritten = shortcuts.map((shortcut) => {
    const entry = shortcut as ShortcutEntry;
    const exeKey = findKey(entry, "exe");
    const exe = exeKey ? entry[exeKey] : undefined;

    if (!exeKey || typeof exe !== "string" || unquote(exe) !== oldPath) {
      return shortcut;
    }

    const next: ShortcutEntry = { ...entry, [exeKey]: requote(exe, newPath) };

    const startDirKey = findKey(entry, "startdir");
    const startDir = startDirKey ? entry[startDirKey] : undefined;

    if (
      startDirKey &&
      typeof startDir === "string" &&
      unquote(startDir) === path.dirname(oldPath)
    ) {
      next[startDirKey] = requote(startDir, path.dirname(newPath));
    }

    changed += 1;
    return next as T;
  });

  return { shortcuts: rewritten, changed };
};

/**
 * Synchronous on purpose: electron-updater emits `appimage-filename-updated`
 * right before it runs or spawns the new AppImage and the app quits, so an
 * async rewrite could be cut off. Returns the number of shortcuts rewritten.
 */
export const rewriteSteamShortcutTargetsSync = (
  steamLocation: string,
  oldPath: string,
  newPath: string
): number => {
  const userDataPath = path.join(steamLocation, "userdata");
  if (!fs.existsSync(userDataPath)) return 0;

  let total = 0;

  for (const dir of fs.readdirSync(userDataPath, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const shortcutsPath = path.join(
      userDataPath,
      dir.name,
      "config",
      "shortcuts.vdf"
    );
    if (!fs.existsSync(shortcutsPath)) continue;

    const parsed = parseBuffer(fs.readFileSync(shortcutsPath));
    const { shortcuts, changed } = rewriteShortcutTargets(
      (parsed.shortcuts ?? []) as object[],
      oldPath,
      newPath
    );
    if (changed === 0) continue;

    // Write-then-rename so a crash cannot leave a truncated shortcuts.vdf.
    const tempPath = `${shortcutsPath}.hydra-tmp`;
    fs.writeFileSync(tempPath, writeBuffer({ ...parsed, shortcuts }));
    fs.renameSync(tempPath, shortcutsPath);
    total += changed;
  }

  return total;
};
