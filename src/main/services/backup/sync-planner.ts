/**
 * Pure decision helpers for the Steam-Cloud-like save synchronization. Kept
 * free of any Electron/level imports so the data-safety logic (which is the
 * crux of not destroying save progress) can be unit-tested in isolation.
 */

/** Fallback retention when neither a per-game nor a global value is set. */
export const DEFAULT_BACKUPS_TO_KEEP = 10;

/** Minimal artifact shape the planner needs (subset of `LocalArtifact`). */
export interface PlannerArtifact {
  id: string;
  createdAt: string;
  isFrozen?: boolean;
  /** Device that produced the backup; "" for legacy/unknown. */
  deviceId?: string;
  /** Keep-both safety backup; see {@link syncCandidates}. */
  conflictSafety?: boolean;
}

export type LaunchSyncAction =
  | "none"
  | "adopt-baseline"
  | "restore"
  | "conflict";

export interface LaunchSyncPlan {
  action: LaunchSyncAction;
  /**
   * The artifact to restore (for `action === "restore"`) or the remote latest
   * that triggered the conflict (for `action === "conflict"`).
   */
  artifactId?: string;
  /** The `createdAt` to persist as the new `lastSyncedBackupAt` marker. */
  createdAt?: string;
}

const toMs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Returns the artifact with the greatest `createdAt` (parsed to ms). */
const pickLatest = <T extends PlannerArtifact>(artifacts: T[]): T | null => {
  let latest: T | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const artifact of artifacts) {
    const ms = toMs(artifact.createdAt);
    if (ms > latestMs) {
      latestMs = ms;
      latest = artifact;
    }
  }

  return latest;
};

/**
 * Artifacts that can be the "latest" state of a game. A conflict safety backup
 * holds one device's diverged state from before a keep-both restore: on any
 * other device it would win as newest and overwrite newer progress. It stays
 * listed, frozen and manually restorable. Safety backups written before the
 * flag existed carry no marker and still count.
 */
const syncCandidates = <T extends PlannerArtifact>(artifacts: T[]): T[] =>
  artifacts.filter((artifact) => !artifact.conflictSafety);

/**
 * Decides what to do with a game's save on launch, given the machine's current
 * sync marker and the list of stored backups. This is the data-safety crux:
 *
 * - No backups → nothing to restore.
 * - Marker UNSET → pre-existing game / first run of this feature:
 *     - This device has NO local save files (`hasLocalSaves === false`, a POSITIVE
 *       determination by the caller) → restore the latest backup: there is nothing
 *       to clobber, so a first-run download is safe (true Steam-Cloud semantics).
 *     - Otherwise (local saves exist, or existence could not be determined —
 *       `hasLocalSaves` true or undefined) → DO NOT restore (local saves may be
 *       newer than the latest backup); adopt the latest as the baseline instead.
 * - Latest backup strictly NEWER than the marker → another machine produced
 *   newer progress:
 *     - our OWN newer backup → restore it (safe).
 *     - ANOTHER device's newer backup, and this device has NO un-backed-up local
 *       changes (`unsyncedSince` unset) → restore it (clean download).
 *     - ANOTHER device's newer backup, and this device DOES have un-backed-up
 *       local changes (`unsyncedSince` set, e.g. previous session crashed) →
 *       `conflict`: both sides diverged, so the caller keeps both.
 * - Otherwise (in sync, or local ahead of the latest backup) → skip, so a
 *   crashed/aborted session's progress is never overwritten by an older backup.
 */
export const decideLaunchSync = (params: {
  lastSyncedBackupAt?: string;
  artifacts: PlannerArtifact[];
  /** This device's stable id, to tell our own backups from other devices'. */
  ourDeviceId: string;
  /** Set when this device has local changes not yet backed up (divergence). */
  unsyncedSince?: string | null;
  /**
   * Whether this device currently has local save files for the game. Only
   * meaningful (and only computed by the caller) when the marker is unset.
   * `false` MUST be a POSITIVE determination that zero save files exist; any
   * error/ambiguity leaves this undefined so we fall back to adopt-baseline.
   */
  hasLocalSaves?: boolean;
}): LaunchSyncPlan => {
  const { lastSyncedBackupAt, artifacts, ourDeviceId, unsyncedSince } = params;

  const latest = pickLatest(syncCandidates(artifacts));
  if (!latest) {
    return { action: "none" };
  }

  if (!lastSyncedBackupAt) {
    // Fresh device with NO local save files: nothing to clobber, so restoring
    // the latest backup on first launch is safe (true Steam-Cloud first run).
    if (params.hasLocalSaves === false) {
      return {
        action: "restore",
        artifactId: latest.id,
        createdAt: latest.createdAt,
      };
    }

    // Otherwise (local saves may exist, or existence could not be determined):
    // migration safety — adopt the latest as the baseline without restoring.
    return { action: "adopt-baseline", createdAt: latest.createdAt };
  }

  const remoteNewer = toMs(latest.createdAt) > toMs(lastSyncedBackupAt);
  if (!remoteNewer) {
    return { action: "none" };
  }

  // Our own newer backup, or another device's with no local divergence here:
  // a straight restore is safe (no local changes are at risk).
  if (latest.deviceId === ourDeviceId || !unsyncedSince) {
    return {
      action: "restore",
      artifactId: latest.id,
      createdAt: latest.createdAt,
    };
  }

  // Another device advanced AND this device has un-backed-up local changes:
  // both sides diverged — the caller must preserve both (keep-both).
  return {
    action: "conflict",
    artifactId: latest.id,
    createdAt: latest.createdAt,
  };
};

/**
 * Resolves the effective retention: per-game override, else global default,
 * else the hard-coded fallback. Non-positive values fall back to the default
 * so a misconfiguration can never wipe out every backup.
 */
export const resolveBackupsToKeep = (
  gameBackupsToKeep?: number | null,
  defaultBackupsToKeep?: number | null
): number => {
  const candidate =
    gameBackupsToKeep ?? defaultBackupsToKeep ?? DEFAULT_BACKUPS_TO_KEEP;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_BACKUPS_TO_KEEP;
  }

  return Math.floor(candidate);
};

/**
 * Selects which artifacts to delete under the retention policy: keep ALL frozen
 * artifacts plus the newest `keep` non-frozen ones (by `createdAt` desc), delete
 * the rest. Returns the ids to delete.
 */
export const selectArtifactsToPrune = (
  artifacts: PlannerArtifact[],
  keep: number
): string[] => {
  const nonFrozen = artifacts
    .filter((artifact) => !artifact.isFrozen)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));

  return nonFrozen.slice(Math.max(0, keep)).map((artifact) => artifact.id);
};

/** Returns the later of two ISO timestamps (by parsed milliseconds). */
export const laterTimestamp = (a: string, b: string): string =>
  toMs(b) > toMs(a) ? b : a;

/**
 * Picks another device's backup that this device's just-uploaded backup would
 * silently supersede: the newest backup with a known, foreign device id that is
 * newer than the marker captured before the upload. An unset marker means this
 * device never synced, so every foreign backup counts. Legacy backups without a
 * device id are ignored.
 */
export const findSupersededRemoteBackup = <T extends PlannerArtifact>(params: {
  lastSyncedBackupAt?: string | null;
  artifacts: T[];
  ourDeviceId: string;
  uploadedArtifactId: string;
}): T | null => {
  const { lastSyncedBackupAt, artifacts, ourDeviceId, uploadedArtifactId } =
    params;
  const markerMs = lastSyncedBackupAt
    ? toMs(lastSyncedBackupAt)
    : Number.NEGATIVE_INFINITY;

  return pickLatest(
    syncCandidates(artifacts).filter(
      (artifact) =>
        artifact.id !== uploadedArtifactId &&
        !!artifact.deviceId &&
        artifact.deviceId !== ourDeviceId &&
        toMs(artifact.createdAt) > markerMs
    )
  );
};

/** Minimal ludusavi preview shape needed to detect local save files. */
export interface LocalSavePreview {
  overall?: { totalGames?: number };
  games?: Record<string, { files?: Record<string, unknown> } | undefined>;
}

/**
 * Interprets a ludusavi backup preview as "this device has local save files".
 * Returns `false` ONLY on a positive zero-files determination; anything
 * ambiguous returns `true` so the planner adopts the baseline instead of
 * restoring. ludusavi omits a game with zero files from `games`; that absence
 * counts as zero only for Wine games, where the preview scans the same prefix
 * the restore writes into.
 */
export const previewHasLocalSaves = (
  preview: LocalSavePreview | null | undefined,
  objectId: string,
  wine: boolean
): boolean => {
  if (!preview) return true;

  const gameData = preview.games?.[objectId];
  if (!gameData) {
    return !(wine && preview.overall?.totalGames === 0);
  }

  if (!gameData.files) return true;
  return Object.keys(gameData.files).length > 0;
};
