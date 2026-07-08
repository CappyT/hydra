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
}

export type LaunchSyncAction = "none" | "adopt-baseline" | "restore";

export interface LaunchSyncPlan {
  action: LaunchSyncAction;
  /** The artifact to restore (only for `action === "restore"`). */
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
 * Decides what to do with a game's save on launch, given the machine's current
 * sync marker and the list of stored backups. This is the data-safety crux:
 *
 * - No backups → nothing to restore.
 * - Marker UNSET → pre-existing game / first run of this feature: DO NOT
 *   restore (local saves may be newer than the latest backup); adopt the latest
 *   as the baseline instead.
 * - Latest backup strictly NEWER than the marker → another machine produced
 *   newer progress: restore it.
 * - Otherwise (in sync, or local ahead of the latest backup) → skip, so a
 *   crashed/aborted session's progress is never overwritten by an older backup.
 */
export const decideLaunchSync = (params: {
  lastSyncedBackupAt?: string;
  artifacts: PlannerArtifact[];
}): LaunchSyncPlan => {
  const { lastSyncedBackupAt, artifacts } = params;

  const latest = pickLatest(artifacts);
  if (!latest) {
    return { action: "none" };
  }

  if (!lastSyncedBackupAt) {
    // Migration safety: adopt the latest as the baseline without restoring.
    return { action: "adopt-baseline", createdAt: latest.createdAt };
  }

  if (toMs(latest.createdAt) > toMs(lastSyncedBackupAt)) {
    return {
      action: "restore",
      artifactId: latest.id,
      createdAt: latest.createdAt,
    };
  }

  return { action: "none" };
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
