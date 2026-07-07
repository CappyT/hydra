import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ArtifactUploadMeta,
  BackupBackendTestResult,
  GameShop,
  LocalArtifact,
} from "@types";
import { backupsPath } from "@main/constants";
import { logger } from "../logger";
import type { ArtifactStorageBackend } from "./artifact-storage-backend";
import { isBackupStorageDir } from "./restore-scratch";

/**
 * Stores save-game backups on the local filesystem under a user-configured root
 * (defaults to `<userData>/Backups`). Layout:
 *
 *   <root>/<shop>-<objectId>/<uuid>.tar
 *   <root>/<shop>-<objectId>/<uuid>.json  (sidecar metadata)
 */
export class LocalDirectoryBackend implements ArtifactStorageBackend {
  private readonly root: string;

  constructor(root?: string | null) {
    this.root = root && root.trim().length > 0 ? root : backupsPath;
  }

  private gameDir(shop: GameShop, objectId: string) {
    return path.join(this.root, `${shop}-${objectId}`);
  }

  /** Finds the sidecar path for an artifact id by scanning game folders. */
  private resolveSidecar(artifactId: string): string | null {
    if (!fs.existsSync(this.root)) return null;

    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip reserved scratch/cache dot-directories (`.restore-tmp`,
      // `.rclone-tmp`, `.rclone-cache`, …) that share the backups root but are
      // never game storage folders.
      if (!isBackupStorageDir(entry.name)) continue;

      const sidecar = path.join(this.root, entry.name, `${artifactId}.json`);
      if (fs.existsSync(sidecar)) return sidecar;
    }

    return null;
  }

  private readSidecar(sidecarPath: string): LocalArtifact {
    return JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as LocalArtifact;
  }

  async list(shop: GameShop, objectId: string): Promise<LocalArtifact[]> {
    const dir = this.gameDir(shop, objectId);
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return this.readSidecar(path.join(dir, file));
        } catch (error) {
          logger.error("Failed to read backup sidecar", { file, error });
          return null;
        }
      })
      .filter((artifact): artifact is LocalArtifact => artifact !== null);
  }

  async upload(
    tarPath: string,
    meta: ArtifactUploadMeta
  ): Promise<LocalArtifact> {
    const dir = this.gameDir(meta.shop, meta.objectId);
    await fs.promises.mkdir(dir, { recursive: true });

    const id = crypto.randomUUID();
    const stat = await fs.promises.stat(tarPath);

    const artifact: LocalArtifact = {
      id,
      shop: meta.shop,
      objectId: meta.objectId,
      label: meta.label,
      hostname: meta.hostname,
      platform: meta.platform,
      homeDir: meta.homeDir,
      winePrefixPath: meta.winePrefixPath,
      downloadOptionTitle: meta.downloadOptionTitle,
      sizeBytes: stat.size,
      isFrozen: false,
      createdAt: new Date().toISOString(),
    };

    await fs.promises.copyFile(tarPath, path.join(dir, `${id}.tar`));
    await fs.promises.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(artifact, null, 2)
    );

    return artifact;
  }

  async download(artifactId: string): Promise<string> {
    const sidecar = this.resolveSidecar(artifactId);
    if (!sidecar) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const tarPath = path.join(path.dirname(sidecar), `${artifactId}.tar`);
    if (!fs.existsSync(tarPath)) {
      throw new Error(`Artifact tar not found: ${artifactId}`);
    }

    return tarPath;
  }

  async delete(artifactId: string): Promise<void> {
    const sidecar = this.resolveSidecar(artifactId);
    if (!sidecar) return;

    const tarPath = path.join(path.dirname(sidecar), `${artifactId}.tar`);

    await fs.promises.rm(tarPath, { force: true });
    await fs.promises.rm(sidecar, { force: true });
  }

  async rename(artifactId: string, label: string): Promise<void> {
    await this.updateSidecar(artifactId, (artifact) => {
      artifact.label = label;
    });
  }

  async setFrozen(artifactId: string, frozen: boolean): Promise<void> {
    await this.updateSidecar(artifactId, (artifact) => {
      artifact.isFrozen = frozen;
    });
  }

  private async updateSidecar(
    artifactId: string,
    mutate: (artifact: LocalArtifact) => void
  ): Promise<void> {
    const sidecar = this.resolveSidecar(artifactId);
    if (!sidecar) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const artifact = this.readSidecar(sidecar);
    mutate(artifact);

    await fs.promises.writeFile(sidecar, JSON.stringify(artifact, null, 2));
  }

  async test(): Promise<BackupBackendTestResult> {
    try {
      await fs.promises.mkdir(this.root, { recursive: true });

      const probe = path.join(this.root, `.write-test-${crypto.randomUUID()}`);
      await fs.promises.writeFile(probe, "ok");
      await fs.promises.rm(probe, { force: true });

      return { ok: true, detail: this.root };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
