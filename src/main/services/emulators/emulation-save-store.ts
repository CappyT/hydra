import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  EmulationCloudSave,
  EmulationSaveEmulator,
  EmulationSavePlatform,
  EmulatorBinary,
} from "@types";

/*
 * Local emulation-saves store. Persists PS1/PS2 memory-card saves ("emulation
 * saves") on the user's own filesystem, replacing the paid Hydra Cloud
 * `/profile/emulation-saves` API. Layout mirrors the save-game
 * `LocalDirectoryBackend`:
 *
 *   <root>/emulation-saves/<platform>/<uuid>.<psu|mcs>   (raw artifact bytes)
 *   <root>/emulation-saves/<platform>/<uuid>.json        (sidecar metadata)
 *
 * The sidecar keeps the existing {@link EmulationCloudSave} shape so the
 * renderer needs no type changes. This module is intentionally free of any
 * electron / HydraApi dependency so it can be unit-tested directly.
 */

const PLATFORMS: EmulationSavePlatform[] = ["ps1", "ps2"];
const SAVE_KIND = "game_save" as const;
const EMULATION_SAVES_DIRNAME = "emulation-saves";

/** Raw artifact extension per platform (.psu for PS2, .mcs for PS1). */
const artifactExt = (platform: EmulationSavePlatform): "psu" | "mcs" =>
  platform === "ps2" ? "psu" : "mcs";

export const toEmulationSaveEmulator = (
  binary: EmulatorBinary
): EmulationSaveEmulator => {
  if (binary !== "duckstation" && binary !== "pcsx2") {
    throw new Error(`Emulator "${binary}" has no emulation saves`);
  }
  return binary;
};

export interface UploadEmulationSaveInput {
  platform: EmulationSavePlatform;
  emulator: EmulationSaveEmulator;
  /** "launchbox" when the save matched a game; null (with objectId) otherwise. */
  shop: "launchbox" | null;
  objectId: string | null;
  /** Stable per-game slot id — the on-card folder name / save identifier. */
  saveIdentity: string;
  fileName: string; // must end in .psu (PS2) or .mcs (PS1)
  label: string;
  localLastModifiedAt: string; // ISO 8601
  buffer: Buffer;
}

/** Minimal logger surface so the store stays electron-free (defaults to console). */
export interface EmulationSaveStoreLogger {
  error: (message: string, ...args: unknown[]) => void;
}

export class EmulationSaveStore {
  private readonly root: string;
  private readonly logger: EmulationSaveStoreLogger;

  constructor(root: string, logger: EmulationSaveStoreLogger = console) {
    this.root = root;
    this.logger = logger;
  }

  private platformDir(platform: EmulationSavePlatform): string {
    return path.join(this.root, EMULATION_SAVES_DIRNAME, platform);
  }

  private readSidecar(sidecarPath: string): EmulationCloudSave {
    return JSON.parse(
      fs.readFileSync(sidecarPath, "utf8")
    ) as EmulationCloudSave;
  }

  /** Write the raw bytes plus a sidecar record, returning the stored save. */
  async upload(input: UploadEmulationSaveInput): Promise<EmulationCloudSave> {
    const dir = this.platformDir(input.platform);
    await fs.promises.mkdir(dir, { recursive: true });

    const id = crypto.randomUUID();
    const ext = artifactExt(input.platform);
    const now = new Date().toISOString();
    const hasShop = Boolean(input.shop && input.objectId);

    const record: EmulationCloudSave = {
      id,
      platform: input.platform,
      emulator: input.emulator,
      saveKind: SAVE_KIND,
      saveIdentity: input.saveIdentity,
      artifactLengthInBytes: input.buffer.length,
      fileName: input.fileName,
      hostname: os.hostname(),
      localLastModifiedAt: input.localLastModifiedAt,
      label: input.label,
      metadata: null,
      shop: hasShop ? input.shop : null,
      objectId: hasShop ? input.objectId : null,
      lastUploadedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await fs.promises.writeFile(path.join(dir, `${id}.${ext}`), input.buffer);
    await fs.promises.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(record, null, 2)
    );

    return record;
  }

  /** Lists a platform's saves for an emulator, newest first. */
  async list(
    platform: EmulationSavePlatform,
    emulator: EmulationSaveEmulator,
    objectId?: string | null
  ): Promise<EmulationCloudSave[]> {
    const dir = this.platformDir(platform);
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return this.readSidecar(path.join(dir, file));
        } catch (error) {
          this.logger.error("Failed to read emulation save sidecar", {
            file,
            error,
          });
          return null;
        }
      })
      .filter((save): save is EmulationCloudSave => save !== null)
      .filter((save) => save.emulator === emulator)
      .filter((save) => (objectId ? save.objectId === objectId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Reads the raw artifact bytes for a save id, scanning both platforms. */
  async downloadBytes(id: string): Promise<Buffer> {
    for (const platform of PLATFORMS) {
      const artifactPath = path.join(
        this.platformDir(platform),
        `${id}.${artifactExt(platform)}`
      );
      if (fs.existsSync(artifactPath)) {
        return fs.promises.readFile(artifactPath);
      }
    }
    throw new Error(`Emulation save not found: ${id}`);
  }

  /** Removes the artifact and its sidecar (no-op if already gone). */
  async delete(id: string): Promise<void> {
    for (const platform of PLATFORMS) {
      const dir = this.platformDir(platform);
      const sidecar = path.join(dir, `${id}.json`);
      if (!fs.existsSync(sidecar)) continue;

      await fs.promises.rm(path.join(dir, `${id}.${artifactExt(platform)}`), {
        force: true,
      });
      await fs.promises.rm(sidecar, { force: true });
      return;
    }
  }

  /** Mutates the sidecar label/metadata, bumps updatedAt, returns the record. */
  async update(
    id: string,
    body: { label?: string | null; metadata?: Record<string, unknown> | null }
  ): Promise<EmulationCloudSave> {
    for (const platform of PLATFORMS) {
      const sidecar = path.join(this.platformDir(platform), `${id}.json`);
      if (!fs.existsSync(sidecar)) continue;

      const record = this.readSidecar(sidecar);
      if (body.label !== undefined) record.label = body.label;
      if (body.metadata !== undefined) record.metadata = body.metadata;
      record.updatedAt = new Date().toISOString();

      await fs.promises.writeFile(sidecar, JSON.stringify(record, null, 2));
      return record;
    }
    throw new Error(`Emulation save not found: ${id}`);
  }
}
