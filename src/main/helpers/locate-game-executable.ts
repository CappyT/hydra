import fs from "node:fs";
import path from "node:path";

import type { Game, GameShop } from "@types";
import { Wine } from "@main/services";
import { sandboxHomesPath } from "@main/constants";
import { levelKeys } from "@main/level";
import { getDownloadsPath } from "@main/events/helpers/get-downloads-path";
import { sanitizeSandboxGameKey } from "./sandbox-launch";
import type { CandidateDirectory } from "./locate-game-executable-match";

interface DownloadLike {
  downloadPath?: string | null;
  folderName?: string | null;
}

const existsDir = (dirPath: string): boolean => {
  try {
    return fs.existsSync(dirPath);
  } catch {
    return false;
  }
};

/**
 * Returns the Linux candidate directories to search for a game's installed
 * executable, in priority order:
 *  1. `<effectiveWinePrefix>/drive_c` (windows/ProgramData skipped by the
 *     matcher) — where Proton/wine installers land the game.
 *  2. the persistent per-game sandbox home.
 *  3. the download folder — portable repacks ship the exe directly.
 * Only directories that currently exist are returned. Empty on non-Linux.
 */
export async function getGameCandidateDirectories(
  shop: GameShop,
  objectId: string,
  game?: Pick<Game, "winePrefixPath"> | null,
  download?: DownloadLike | null
): Promise<CandidateDirectory[]> {
  if (process.platform !== "linux") return [];

  const candidates: CandidateDirectory[] = [];

  const effectiveWinePrefix = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );
  if (effectiveWinePrefix) {
    candidates.push({
      path: path.join(effectiveWinePrefix, "drive_c"),
      isDriveC: true,
    });
  }

  const gameKey = levelKeys.game(shop, objectId);
  candidates.push({
    path: path.join(sandboxHomesPath, sanitizeSandboxGameKey(gameKey)),
  });

  if (download?.folderName) {
    const downloadsPath = download.downloadPath ?? (await getDownloadsPath());
    candidates.push({
      path: path.join(downloadsPath, download.folderName),
    });
  }

  return candidates.filter((candidate) => existsDir(candidate.path));
}

/**
 * Best default directory for the manual executable picker on Linux, preferring
 * (a) the directory of an already-set executable, then (b) the game's wine
 * prefix `drive_c`. Returns null when neither exists so the caller falls back
 * to the downloads folder.
 */
export function getExecutablePickerDefaultPath(
  objectId: string,
  game?: Pick<Game, "winePrefixPath" | "executablePath"> | null
): string | null {
  if (game?.executablePath) {
    const dir = path.dirname(game.executablePath);
    if (existsDir(dir)) return dir;
  }

  const effectiveWinePrefix = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );
  if (effectiveWinePrefix) {
    const driveCPath = path.join(effectiveWinePrefix, "drive_c");
    if (existsDir(driveCPath)) return driveCPath;
  }

  return null;
}
