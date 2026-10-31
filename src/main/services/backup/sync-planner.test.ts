import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BACKUPS_TO_KEEP,
  decideLaunchSync,
  findSupersededRemoteBackup,
  laterTimestamp,
  previewHasLocalSaves,
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

  it("restores the latest on a fresh device with NO local saves (marker unset)", () => {
    // True Steam-Cloud first run: nothing local to clobber, so download+restore.
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [
        artifact("a", "2026-07-01T10:00:00.000Z"),
        artifact("b", "2026-07-05T10:00:00.000Z"),
      ],
      ourDeviceId: OUR_DEVICE,
      hasLocalSaves: false,
    });

    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "b");
    assert.equal(plan.createdAt, "2026-07-05T10:00:00.000Z");
  });

  it("adopts baseline (no restore) when the marker is unset but local saves EXIST", () => {
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [
        artifact("a", "2026-07-01T10:00:00.000Z"),
        artifact("b", "2026-07-05T10:00:00.000Z"),
      ],
      ourDeviceId: OUR_DEVICE,
      hasLocalSaves: true,
    });

    assert.equal(plan.action, "adopt-baseline");
    assert.equal(plan.createdAt, "2026-07-05T10:00:00.000Z");
    assert.equal(plan.artifactId, undefined);
  });

  it("adopts baseline when the marker is unset and local-save existence is undetermined", () => {
    // Fail-safe: hasLocalSaves undefined (detection failed/skipped) must NOT
    // restore — it behaves exactly like "local saves exist".
    const plan = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [artifact("b", "2026-07-05T10:00:00.000Z")],
      ourDeviceId: OUR_DEVICE,
      hasLocalSaves: undefined,
    });

    assert.equal(plan.action, "adopt-baseline");
    assert.equal(plan.createdAt, "2026-07-05T10:00:00.000Z");
    assert.equal(plan.artifactId, undefined);
  });

  it("does nothing when the marker is unset and there are NO backups, regardless of local saves", () => {
    // No artifacts short-circuits to "none" before hasLocalSaves is ever read.
    for (const hasLocalSaves of [false, true, undefined]) {
      const plan = decideLaunchSync({
        lastSyncedBackupAt: undefined,
        artifacts: [],
        ourDeviceId: OUR_DEVICE,
        hasLocalSaves,
      });

      assert.deepEqual(plan, { action: "none" });
    }
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
      artifacts: [
        artifact("mine", "2026-07-06T12:00:00.000Z", false, OUR_DEVICE),
      ],
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

describe("keep-both conflict marker", () => {
  it("persists the safety backup's date so the next launch never restores it", () => {
    const a1 = artifact("a1", "2026-10-01T10:00:00.000Z", false, OUR_DEVICE);
    const b2 = artifact("b2", "2026-10-01T12:00:00.000Z", false, OTHER_DEVICE);
    const first = decideLaunchSync({
      lastSyncedBackupAt: a1.createdAt,
      artifacts: [a1, b2],
      ourDeviceId: OUR_DEVICE,
      unsyncedSince: "2026-10-01T11:00:00.000Z",
    });
    assert.equal(first.action, "conflict");

    // The conflict path uploads a frozen safety backup of the local state.
    const c3 = artifact("c3", "2026-10-01T13:00:00.000Z", true, OUR_DEVICE);
    const marker = laterTimestamp(first.createdAt!, c3.createdAt);
    assert.equal(marker, c3.createdAt);

    // The post-conflict session then ends without a close-backup.
    const next = decideLaunchSync({
      lastSyncedBackupAt: marker,
      artifacts: [a1, b2, c3],
      ourDeviceId: OUR_DEVICE,
      unsyncedSince: "2026-10-01T13:05:00.000Z",
    });
    assert.equal(next.action, "none");
  });

  it("never makes another device restore the conflict safety backup", () => {
    const DEVICE_A = "device-a";
    const DEVICE_B = "device-b";
    const a1 = artifact("a1", "2026-10-01T10:00:00.000Z", false, DEVICE_A);
    const b2 = artifact("b2", "2026-10-01T12:00:00.000Z", false, DEVICE_B);

    // A crashed after a1, so it diverged; B's b2 is newer.
    const onA = decideLaunchSync({
      lastSyncedBackupAt: a1.createdAt,
      artifacts: [a1, b2],
      ourDeviceId: DEVICE_A,
      unsyncedSince: "2026-10-01T11:00:00.000Z",
    });
    assert.deepEqual(onA, {
      action: "conflict",
      artifactId: "b2",
      createdAt: b2.createdAt,
    });

    // A keeps its crashed state as a frozen safety backup, then restores b2.
    const c3: PlannerArtifact = {
      ...artifact("c3", "2026-10-01T13:00:00.000Z", true, DEVICE_A),
      conflictSafety: true,
    };

    // B is clean at b2 and must keep its own progress.
    const onB = decideLaunchSync({
      lastSyncedBackupAt: b2.createdAt,
      artifacts: [a1, b2, c3],
      ourDeviceId: DEVICE_B,
      unsyncedSince: null,
    });
    assert.deepEqual(onB, { action: "none" });

    // B's next close-backup does not report c3 as a superseded remote.
    const b4 = artifact("b4", "2026-10-01T15:00:00.000Z", false, DEVICE_B);
    assert.equal(
      findSupersededRemoteBackup({
        lastSyncedBackupAt: b2.createdAt,
        artifacts: [a1, b2, c3, b4],
        ourDeviceId: DEVICE_B,
        uploadedArtifactId: "b4",
      }),
      null
    );

    // A fresh device restores the latest real state, not the safety backup.
    const fresh = decideLaunchSync({
      lastSyncedBackupAt: undefined,
      artifacts: [a1, b2, c3],
      ourDeviceId: "device-c",
      hasLocalSaves: false,
    });
    assert.equal(fresh.artifactId, "b2");
  });

  it("still counts an unmarked legacy safety backup as the latest", () => {
    const b2 = artifact("b2", "2026-10-01T12:00:00.000Z", false, "device-b");
    const legacyC3 = artifact(
      "c3",
      "2026-10-01T13:00:00.000Z",
      true,
      "device-a"
    );

    const plan = decideLaunchSync({
      lastSyncedBackupAt: b2.createdAt,
      artifacts: [b2, legacyC3],
      ourDeviceId: "device-b",
      unsyncedSince: null,
    });
    assert.equal(plan.action, "restore");
    assert.equal(plan.artifactId, "c3");
  });

  it("laterTimestamp compares parsed milliseconds", () => {
    assert.equal(
      laterTimestamp("2026-10-01T12:00:00.000Z", "2026-10-01T11:00:00Z"),
      "2026-10-01T12:00:00.000Z"
    );
    assert.equal(
      laterTimestamp("2026-10-01T09:00:00.000Z", "2026-10-01T10:00:00Z"),
      "2026-10-01T10:00:00Z"
    );
  });
});

describe("findSupersededRemoteBackup", () => {
  const ours = artifact("ours", "2026-10-02T20:00:00.000Z", false, OUR_DEVICE);

  it("returns another device's backup uploaded during the session", () => {
    const remote = artifact(
      "r1",
      "2026-10-02T18:00:00.000Z",
      false,
      OTHER_DEVICE
    );
    const found = findSupersededRemoteBackup({
      lastSyncedBackupAt: "2026-10-02T10:00:00.000Z",
      artifacts: [artifact("old", "2026-10-02T10:00:00.000Z"), remote, ours],
      ourDeviceId: OUR_DEVICE,
      uploadedArtifactId: ours.id,
    });
    assert.equal(found?.id, "r1");
  });

  it("returns the newest of several foreign backups", () => {
    const found = findSupersededRemoteBackup({
      lastSyncedBackupAt: "2026-10-02T10:00:00.000Z",
      artifacts: [
        artifact("r1", "2026-10-02T12:00:00.000Z", false, OTHER_DEVICE),
        artifact("r2", "2026-10-02T15:00:00.000Z", false, "third-device"),
        ours,
      ],
      ourDeviceId: OUR_DEVICE,
      uploadedArtifactId: ours.id,
    });
    assert.equal(found?.id, "r2");
  });

  it("ignores foreign backups the device already synced to", () => {
    const found = findSupersededRemoteBackup({
      lastSyncedBackupAt: "2026-10-02T12:00:00.000Z",
      artifacts: [
        artifact("r1", "2026-10-02T12:00:00.000Z", false, OTHER_DEVICE),
        ours,
      ],
      ourDeviceId: OUR_DEVICE,
      uploadedArtifactId: ours.id,
    });
    assert.equal(found, null);
  });

  it("ignores our own and legacy backups", () => {
    const found = findSupersededRemoteBackup({
      lastSyncedBackupAt: "2026-10-02T10:00:00.000Z",
      artifacts: [
        artifact("own", "2026-10-02T15:00:00.000Z", false, OUR_DEVICE),
        artifact("legacy", "2026-10-02T16:00:00.000Z", false, ""),
        ours,
      ],
      ourDeviceId: OUR_DEVICE,
      uploadedArtifactId: ours.id,
    });
    assert.equal(found, null);
  });

  it("treats an unset marker as never synced", () => {
    const found = findSupersededRemoteBackup({
      lastSyncedBackupAt: undefined,
      artifacts: [
        artifact("r1", "2026-10-01T12:00:00.000Z", false, OTHER_DEVICE),
        ours,
      ],
      ourDeviceId: OUR_DEVICE,
      uploadedArtifactId: ours.id,
    });
    assert.equal(found?.id, "r1");
  });
});

describe("previewHasLocalSaves (fail-safe local-save detection)", () => {
  const empty = { overall: { totalGames: 0 }, games: {} };

  it("reads an absent game in a successful empty preview as zero saves for Wine games", () => {
    assert.equal(previewHasLocalSaves(empty, "123", true), false);
  });

  it("keeps an absent game inconclusive for non-Wine games", () => {
    assert.equal(previewHasLocalSaves(empty, "123", false), true);
  });

  it("keeps an absent game inconclusive when ludusavi counted other games", () => {
    const preview = { overall: { totalGames: 1 }, games: {} };
    assert.equal(previewHasLocalSaves(preview, "123", true), true);
  });

  it("treats a missing preview or missing totals as inconclusive", () => {
    assert.equal(previewHasLocalSaves(null, "123", true), true);
    assert.equal(previewHasLocalSaves({ games: {} }, "123", true), true);
  });

  it("counts the files ludusavi found", () => {
    const withFiles = {
      overall: { totalGames: 1 },
      games: { "123": { files: { "/save.dat": {} } } },
    };
    const noFiles = {
      overall: { totalGames: 1 },
      games: { "123": { files: {} } },
    };
    assert.equal(previewHasLocalSaves(withFiles, "123", false), true);
    assert.equal(previewHasLocalSaves(noFiles, "123", true), false);
    assert.equal(
      previewHasLocalSaves(
        { overall: { totalGames: 1 }, games: { "123": {} } },
        "123",
        true
      ),
      true
    );
  });
});
