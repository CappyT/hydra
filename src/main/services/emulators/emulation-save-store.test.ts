import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  EmulationSaveStore,
  type UploadEmulationSaveInput,
} from "./emulation-save-store.ts";

const silentLogger = { error: () => {} };

const makeInput = (
  overrides: Partial<UploadEmulationSaveInput> = {}
): UploadEmulationSaveInput => ({
  platform: "ps2",
  emulator: "pcsx2",
  shop: "launchbox",
  objectId: "12345",
  saveIdentity: "BESLES-50009",
  fileName: "My Game.psu",
  label: "My Game",
  localLastModifiedAt: new Date("2024-01-02T03:04:05.000Z").toISOString(),
  buffer: Buffer.from("psu payload"),
  ...overrides,
});

describe("EmulationSaveStore (local emulation saves)", () => {
  let root: string;
  let store: EmulationSaveStore;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "emu-saves-"));
  });

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    store = new EmulationSaveStore(root, silentLogger);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips upload -> list -> download", async () => {
    const input = makeInput();
    const saved = await store.upload(input);

    // Sidecar carries the full record shape.
    assert.equal(saved.platform, "ps2");
    assert.equal(saved.emulator, "pcsx2");
    assert.equal(saved.saveKind, "game_save");
    assert.equal(saved.objectId, "12345");
    assert.equal(saved.shop, "launchbox");
    assert.equal(saved.artifactLengthInBytes, input.buffer.length);

    // Files land under <root>/emulation-saves/ps2/.
    const dir = path.join(root, "emulation-saves", "ps2");
    assert.ok(fs.existsSync(path.join(dir, `${saved.id}.psu`)));
    assert.ok(fs.existsSync(path.join(dir, `${saved.id}.json`)));

    const listed = await store.list("ps2", "pcsx2", "12345");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);

    const bytes = await store.downloadBytes(saved.id);
    assert.equal(bytes.toString(), "psu payload");
  });

  it("filters list by emulator and objectId, sorted newest first", async () => {
    const first = await store.upload(makeInput({ objectId: "111" }));
    // Ensure a distinct createdAt for deterministic ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.upload(makeInput({ objectId: "222" }));

    const all = await store.list("ps2", "pcsx2");
    assert.deepEqual(
      all.map((s) => s.id),
      [second.id, first.id]
    );

    const scoped = await store.list("ps2", "pcsx2", "111");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].id, first.id);

    // A different emulator sees nothing on this platform.
    assert.equal((await store.list("ps2", "duckstation")).length, 0);
  });

  it("renames a save and bumps updatedAt", async () => {
    const saved = await store.upload(makeInput());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const renamed = await store.update(saved.id, { label: "Renamed" });
    assert.equal(renamed.label, "Renamed");
    assert.notEqual(renamed.updatedAt, saved.updatedAt);

    const listed = await store.list("ps2", "pcsx2");
    assert.equal(listed[0].label, "Renamed");
  });

  it("deletes the artifact and sidecar", async () => {
    const saved = await store.upload(makeInput());
    await store.delete(saved.id);

    assert.equal((await store.list("ps2", "pcsx2")).length, 0);
    await assert.rejects(() => store.downloadBytes(saved.id));

    // Deleting an unknown id is a no-op.
    await store.delete("does-not-exist");
  });

  it("stores PS1 saves as .mcs and skips shop when unmatched", async () => {
    const saved = await store.upload(
      makeInput({
        platform: "ps1",
        emulator: "duckstation",
        fileName: "Save.mcs",
        shop: null,
        objectId: null,
        buffer: Buffer.from("mcs payload"),
      })
    );

    assert.equal(saved.shop, null);
    assert.equal(saved.objectId, null);
    assert.ok(
      fs.existsSync(
        path.join(root, "emulation-saves", "ps1", `${saved.id}.mcs`)
      )
    );
    assert.equal(
      (await store.downloadBytes(saved.id)).toString(),
      "mcs payload"
    );
  });
});
