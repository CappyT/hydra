import type { ChildProcess } from "node:child_process";
import path from "node:path";

import { within } from "../../helpers/sandbox-paths";

/**
 * A running sandboxed process (port, ROM tool, extractor) can swap a folder it
 * writes for a link to a host folder at any time. The launcher walks and writes
 * those folders only while no such process runs on them, and no such process
 * starts on them while the launcher works there.
 */
export class RecompilationSandboxBusyError extends Error {
  constructor(directory: string) {
    super(`A sandboxed port process can write ${directory}`);
  }
}

/** Writable roots of each live sandboxed process. */
const liveRoots = new Map<ChildProcess, string[]>();
/** Writable roots the launcher sanitizes or writes. */
const quietRoots = new Map<symbol, string[]>();

const resolveRoots = (roots: string[]) =>
  roots.map((root) => path.resolve(root));

const overlapsAny = (held: Iterable<string[]>, roots: string[]) => {
  for (const other of held) {
    if (other.some((a) => roots.some((b) => within(a, b) || within(b, a)))) {
      return true;
    }
  }
  return false;
};

/** Throws when the launcher works in one of `roots` right now. */
export const assertSandboxCanStart = (roots: string[]) => {
  const resolved = resolveRoots(roots);
  if (overlapsAny(quietRoots.values(), resolved)) {
    throw new RecompilationSandboxBusyError(resolved[0]);
  }
};

/** Counts `child` as able to write `roots` until it exits. */
export const trackLiveSandbox = (child: ChildProcess, roots: string[]) => {
  liveRoots.set(child, resolveRoots(roots));
  const release = () => liveRoots.delete(child);
  child.once("exit", release);
  child.once("error", () => {
    if (child.pid === undefined) release();
  });
};

/**
 * Runs `operation` while no sandboxed process can write `roots`; throws when
 * one runs on them. Sandboxes on those roots cannot start until it ends.
 */
export const whileSandboxQuiet = async <T>(
  roots: string[],
  operation: () => Promise<T>
): Promise<T> => {
  const resolved = resolveRoots(roots);
  if (overlapsAny(liveRoots.values(), resolved)) {
    throw new RecompilationSandboxBusyError(resolved[0]);
  }
  const token = Symbol("quiet");
  quietRoots.set(token, resolved);
  try {
    return await operation();
  } finally {
    quietRoots.delete(token);
  }
};
