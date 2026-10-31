import fs from "node:fs";

/**
 * Writes a JSON sidecar through `<file>.tmp` + rename, so a crash never leaves
 * a truncated sidecar. The `.tmp` suffix keeps the partial file out of every
 * `*.json` listing.
 */
export const writeJsonAtomicSync = (file: string, data: unknown): void => {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
};
