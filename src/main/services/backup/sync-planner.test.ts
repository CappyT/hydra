import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BACKUPS_TO_KEEP,
  decideLaunchSync,
  resolveBackupsToKeep,
  selectArtifactsToPrune,
  type PlannerArtifact,
} from "./sync-planner.ts";

const artifact = (
  id: string,
  createdAt: string,
  isFrozen = false
): PlannerArtifact => ({ id, createdAt, isFrozen });

describe("decideLaunchSync (marker decision — the data-safety crux)", () => {
  it("does nothing when there are no backups (first run)", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [],
    });

    assert.deepEqual(plan, { action: "none" });
  });

  it("adopts the latest as baseline WITHOUT restoring when the marker is unset", () => {
    // Pre-existing game: local saves may be newer than the latest backup, so
    // restoring would destroy them — we only adopt the baseline.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [
        artifact("a", "2026-07-01T10:00:00.000Z"),
        artifact("b", "2026-07-05T10:00:00.000Z"),
      ],
    });

    assert.equal(plan.action, "adopt-baseline");
    assert.equal(plan.createdAt, "2026-07-05T10:00:00.000Z");
    assert.equal(plan.artifactId, undefined);
  });

  it("restores the latest when it is strictly newer than the marker", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-01T10:00:00.000Z",
      artifacts: [
        artifact("old", "2026-07-01T10:00:00.000Z"),
        artifact("new", "2026-07-06T12:00:00.000Z"),
      ],
    });

    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "new");
    assert.equal(plan.createdAt, "2026-07-06T12:00:00.000Z");
  });

  it("skips when the marker equals the latest backup (in sync)", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-06T12:00:00.000Z",
      artifacts: [artifact("new", "2026-07-06T12:00:00.000Z")],
    });

    assert.deepEqual(plan, { action: "none" });
  });

  it("skips when the latest backup is OLDER than the marker (local ahead — crash safety)", () => {
    // A crashed session may have advanced the marker past the newest backup;
    // restoring an older backup would overwrite that progress.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-10T00:00:00.000Z",
      artifacts: [artifact("old", "2026-07-06T12:00:00.000Z")],
    });

    assert.deepEqual(plan, { action: "none" });
  });

  it("compares by parsed milliseconds, not string ordering", () => {
    // These two timestamps sort the OPPOSITE way lexicographically vs. by time.
    const marker = "2026-07-09T23:00:00.000Z";
    const latest = "2026-07-10T01:00:00.000+05:00"; // = 2026-07-09T20:00Z, older
    const plan = decideLaunchSync({
      lastSyncedBackupAt: marker,
      artifacts: [artifact("z", latest)],
    });

    assert.equal(plan.action, "none");
  });
});

describe("resolveBackupsToKeep", () => {
  it("prefers the per-game override", () => {
    assert.equal(resolveBackupsToKeep(3, 20), 3);
  });

  it("falls back to the global default when there is no per-game value", () => {
    assert.equal(resolveBackupsToKeep(undefined, 20), 20);
    assert.equal(resolveBackupsToKeep(null, 20), 20);
  });

  it("falls back to the hard default when nothing is configured", () => {
    assert.equal(
      resolveBackupsToKeep(undefined, undefined),
      DEFAULT_BACKUPS_TO_KEEP
    );
  });

  it("rejects non-positive / non-finite values to avoid wiping every backup", () => {
    assert.equal(resolveBackupsToKeep(0, undefined), DEFAULT_BACKUPS_TO_KEEP);
    assert.equal(resolveBackupsToKeep(-5, undefined), DEFAULT_BACKUPS_TO_KEEP);
    assert.equal(
      resolveBackupsToKeep(Number.NaN, undefined),
      DEFAULT_BACKUPS_TO_KEEP
    );
  });
});

describe("selectArtifactsToPrune (retention)", () => {
  it("keeps the newest N non-frozen and deletes the older ones", () => {
    const artifacts = [
      artifact("a", "2026-07-01T00:00:00.000Z"),
      artifact("b", "2026-07-02T00:00:00.000Z"),
      artifact("c", "2026-07-03T00:00:00.000Z"),
      artifact("d", "2026-07-04T00:00:00.000Z"),
    ];

    const toDelete = selectArtifactsToPrune(artifacts, 2);

    // Keeps d + c (newest two), deletes a + b.
    assert.deepEqual(toDelete.sort(), ["a", "b"]);
  });

  it("never deletes frozen backups, even beyond the retention count", () => {
    const artifacts = [
      artifact("frozen-old", "2026-07-01T00:00:00.000Z", true),
      artifact("n1", "2026-07-02T00:00:00.000Z"),
      artifact("n2", "2026-07-03T00:00:00.000Z"),
      artifact("n3", "2026-07-04T00:00:00.000Z"),
    ];

    const toDelete = selectArtifactsToPrune(artifacts, 1);

    // Keeps the frozen one (always) + n3 (newest non-frozen); deletes n1, n2.
    assert.deepEqual(toDelete.sort(), ["n1", "n2"]);
  });

  it("deletes nothing when within the retention count", () => {
    const artifacts = [
      artifact("a", "2026-07-01T00:00:00.000Z"),
      artifact("b", "2026-07-02T00:00:00.000Z"),
    ];

    assert.deepEqual(selectArtifactsToPrune(artifacts, 5), []);
  });

  it("returns nothing when all artifacts are frozen", () => {
    const artifacts = [
      artifact("f1", "2026-07-01T00:00:00.000Z", true),
      artifact("f2", "2026-07-02T00:00:00.000Z", true),
    ];

    assert.deepEqual(selectArtifactsToPrune(artifacts, 1), []);
  });
});
