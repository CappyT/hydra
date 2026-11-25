import fs from "node:fs";
import path from "node:path";

const isInside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root + path.sep);

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
};

// Resolves the link the way the kernel would: existing components through
// realpath, the first missing component and the rest lexically. A plain
// lexical resolve of a dangling target is wrong when a component is itself a
// link, e.g. `l -> dot/../x` with `dot -> .` reaches the parent of the root.
const resolveLinkTarget = async (linkPath: string, target: string) => {
  let current = path.dirname(linkPath);
  let missing = false;

  for (const component of target.split("/")) {
    if (component === "" || component === ".") continue;

    if (component === ".." || missing) {
      current =
        component === ".."
          ? path.dirname(current)
          : path.join(current, component);
      continue;
    }

    const next = path.join(current, component);
    try {
      current = await fs.promises.realpath(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      current = next;
      missing = true;
    }
  }

  return current;
};

const isEscapingLink = async (realRoot: string, linkPath: string) => {
  const target = await fs.promises.readlink(linkPath);
  if (path.isAbsolute(target)) return true;

  try {
    return !isInside(realRoot, await fs.promises.realpath(linkPath));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  return !isInside(realRoot, await resolveLinkTarget(linkPath, target));
};

const removeEscapingSymlinksOnce = async (realRoot: string) => {
  const removed: string[] = [];
  const directories = [realRoot];

  for (
    let directory = directories.pop();
    directory;
    directory = directories.pop()
  ) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      if (!(await isEscapingLink(realRoot, entryPath))) continue;

      // unlink never follows the last component, so only the link goes.
      await fs.promises.unlink(entryPath);
      removed.push(entryPath);
    }
  }

  return removed;
};

/**
 * Removes every symlink under `root` that is absolute or resolves outside the
 * real root, so no later write through it leaves the extraction destination.
 * Never follows a link while walking and never removes anything else. Passes
 * repeat until one removes nothing, because removing a link can change where
 * a chain of links resolves.
 */
export const removeEscapingSymlinks = async (
  root: string
): Promise<string[]> => {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const removed: string[] = [];
  for (;;) {
    const pass = await removeEscapingSymlinksOnce(realRoot);
    if (pass.length === 0) return removed;
    removed.push(...pass);
  }
};
