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
  isFrozen = false,
  deviceId = "this-device"
): PlannerArtifact => ({ id, createdAt, isFrozen, deviceId });

const OUR_DEVICE = "this-device";
const OTHER_DEVICE = "other-device";

describe("decideLaunchSync (marker decision — the data-safety crux)", () => {
  it("does nothing when there are no backups (first run)", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [],
      ourDeviceId: OUR_DEVICE,
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
      ourDeviceId: OUR_DEVICE,
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
      ourDeviceId: OUR_DEVICE,
    });

    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "new");
    assert.equal(plan.createdAt, "2026-07-06T12:00:00.000Z");
  });

  it("skips when the marker equals the latest backup (in sync)", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-06T12:00:00.000Z",
      artifacts: [artifact("new", "2026-07-06T12:00:00.000Z")],
      ourDeviceId: OUR_DEVICE,
    });

    assert.deepEqual(plan, { action: "none" });
  });

  it("skips when the latest backup is OLDER than the marker (local ahead — crash safety)", () => {
    // A crashed session may have advanced the marker past the newest backup;
    // restoring an older backup would overwrite that progress.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-10T00:00:00.000Z",
      artifacts: [artifact("old", "2026-07-06T12:00:00.000Z")],
      ourDeviceId: OUR_DEVICE,
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
      ourDeviceId: OUR_DEVICE,
    });

    assert.equal(plan.action, "none");
  });

  it("restores our OWN newer backup even when this device has local divergence", () => {
    // The newer remote came from THIS device, so there is nothing to conflict
    // with — a straight restore is safe.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-01T10:00:00.000Z",
      artifacts: [artifact("mine", "2026-07-06T12:00:00.000Z", false, OUR_DEVICE)],
      ourDeviceId: OUR_DEVICE,
      unsyncedSince: "2026-07-05T00:00:00.000Z",
    });

    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "mine");
    assert.equal(plan.createdAt, "2026-07-06T12:00:00.000Z");
  });

  it("restores another device's newer backup when there is NO local divergence", () => {
    // Another device advanced, but this device closed cleanly last time
    // (no un-backed-up changes), so downloading it loses nothing.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-01T10:00:00.000Z",
      artifacts: [
        artifact("theirs", "2026-07-06T12:00:00.000Z", false, OTHER_DEVICE),
      ],
      ourDeviceId: OUR_DEVICE,
      unsyncedSince: null,
    });

    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "theirs");
    assert.equal(plan.createdAt, "2026-07-06T12:00:00.000Z");
  });

  it("reports a conflict when another device advanced AND this device has local divergence", () => {
    // Both sides diverged: another device produced a newer backup while this
    // device still has un-backed-up local changes (e.g. a crashed session).
    const plan = decideLaunchSync({
      lastSyncedBackupAt: "2026-07-01T10:00:00.000Z",
      artifacts: [
        artifact("theirs", "2026-07-06T12:00:00.000Z", false, OTHER_DEVICE),
      ],
      ourDeviceId: OUR_DEVICE,
      unsyncedSince: "2026-07-05T00:00:00.000Z",
    });

    assert.equal(plan.action, "conflict");
    assert.equal(plan.artifactId, "theirs");
    assert.equal(plan.createdAt, "2026-07-06T12:00:00.000Z");
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

  it("never prunes a frozen conflict safety-backup even under many newer backups", () => {
    // The keep-both conflict resolution freezes this device's interrupted local
    // saves; a later close-backup's prune must never delete that safety copy.
    const artifacts = [
      artifact("conflict-safety", "2026-07-01T00:00:00.000Z", true),
      artifact("n1", "2026-07-02T00:00:00.000Z"),
      artifact("n2", "2026-07-03T00:00:00.000Z"),
      artifact("n3", "2026-07-04T00:00:00.000Z"),
      artifact("n4", "2026-07-05T00:00:00.000Z"),
    ];

    const toDelete = selectArtifactsToPrune(artifacts, 1);

    assert.ok(!toDelete.includes("conflict-safety"));
    assert.deepEqual(toDelete.sort(), ["n1", "n2", "n3"]);
  });

  it("returns nothing when all artifacts are frozen", () => {
    const artifacts = [
      artifact("f1", "2026-07-01T00:00:00.000Z", true),
      artifact("f2", "2026-07-02T00:00:00.000Z", true),
    ];

    assert.deepEqual(selectArtifactsToPrune(artifacts, 1), []);
  });
});
