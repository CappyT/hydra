import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cp from "node:child_process";
import type {
  ArtifactUploadMeta,
  BackupBackendTestResult,
  GameShop,
  LocalArtifact,
} from "@types";
import { backupsPath } from "@main/constants";
import { resolveSystemBinary } from "@main/helpers/resolve-system-binary";
import { logger } from "../logger";
import type { ArtifactStorageBackend } from "./artifact-storage-backend";

const COPY_TIMEOUT_MS = 10 * 60 * 1000;
const META_TIMEOUT_MS = 60 * 1000;

interface RcloneLsjsonEntry {
  Path: string;
  Name: string;
  Size: number;
  IsDir: boolean;
}

/**
 * Legacy sidecars predate the device id; default it to "" so old remote
 * backups never crash and simply compare unequal to any real device id.
 */
const normalizeArtifact = (artifact: LocalArtifact): LocalArtifact => ({
  ...artifact,
  deviceId: artifact.deviceId ?? "",
});

/**
 * Stores save-game backups on any rclone remote (S3, Drive, Dropbox, WebDAV,
 * SFTP, …) by shelling out to the system `rclone` binary. The remote and its
 * credentials live entirely in the user's `rclone.conf`; we only ever pass a
 * remote path (e.g. `myremote:games-saves`), never secrets.
 *
 * A local sidecar cache under `<backupsPath>/.rclone-cache` mirrors the remote
 * `.json` metadata so that id-based operations (download/delete/rename/freeze)
 * can resolve an artifact's game folder without scanning the whole remote. The
 * cache is (re)populated on every {@link list}.
 */
export class RcloneBackend implements ArtifactStorageBackend {
  private readonly remote: string;
  private readonly binaryPath: string | null;
  private readonly cacheRoot = path.join(backupsPath, ".rclone-cache");
  private readonly tmpRoot = path.join(backupsPath, ".rclone-tmp");

  constructor(remote?: string | null) {
    this.remote = (remote ?? "").trim();
    this.binaryPath = resolveSystemBinary(["rclone"]);
  }

  private remotePath(shop: GameShop, objectId: string, file?: string) {
    const base = `${this.remote}/${shop}-${objectId}`;
    return file ? `${base}/${file}` : base;
  }

  private cacheDir(shop: GameShop, objectId: string) {
    return path.join(this.cacheRoot, `${shop}-${objectId}`);
  }

  private runRclone(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (!this.binaryPath) {
        reject(new Error("rclone binary not found on PATH"));
        return;
      }

      cp.execFile(
        this.binaryPath,
        args,
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(stderr?.trim() || error.message || "rclone failed")
            );
            return;
          }

          resolve({ stdout, stderr });
        }
      );
    });
  }

  private writeCacheSidecar(artifact: LocalArtifact) {
    const dir = this.cacheDir(artifact.shop, artifact.objectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${artifact.id}.json`),
      JSON.stringify(artifact, null, 2)
    );
  }

  /** Resolves an artifact from the local sidecar cache. */
  private resolveFromCache(artifactId: string): LocalArtifact | null {
    if (!fs.existsSync(this.cacheRoot)) return null;

    for (const entry of fs.readdirSync(this.cacheRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;

      const sidecar = path.join(
        this.cacheRoot,
        entry.name,
        `${artifactId}.json`
      );
      if (!fs.existsSync(sidecar)) continue;

      try {
        return normalizeArtifact(
          JSON.parse(fs.readFileSync(sidecar, "utf8")) as LocalArtifact
        );
      } catch (error) {
        logger.error("Failed to read rclone cache sidecar", { sidecar, error });
      }
    }

    return null;
  }

  private requireResolved(artifactId: string): LocalArtifact {
    const artifact = this.resolveFromCache(artifactId);
    if (!artifact) {
      throw new Error(
        `Artifact ${artifactId} not found in local cache; list its game first`
      );
    }
    return artifact;
  }

  async list(shop: GameShop, objectId: string): Promise<LocalArtifact[]> {
    if (!this.remote) return [];

    let entries: RcloneLsjsonEntry[];
    try {
      const { stdout } = await this.runRclone(
        ["lsjson", this.remotePath(shop, objectId)],
        META_TIMEOUT_MS
      );
      entries = JSON.parse(stdout) as RcloneLsjsonEntry[];
    } catch (error) {
      // A missing game folder is expected for games without backups yet.
      logger.debug("rclone lsjson returned no listing", { shop, objectId });
      logger.debug(String(error));
      return [];
    }

    const artifacts: LocalArtifact[] = [];

    for (const entry of entries) {
      if (entry.IsDir || !entry.Name.endsWith(".json")) continue;

      try {
        const { stdout } = await this.runRclone(
          ["cat", this.remotePath(shop, objectId, entry.Name)],
          META_TIMEOUT_MS
        );
        const artifact = normalizeArtifact(JSON.parse(stdout) as LocalArtifact);
        this.writeCacheSidecar(artifact);
        artifacts.push(artifact);
      } catch (error) {
        logger.error("Failed to read remote backup sidecar", {
          entry: entry.Name,
          error,
        });
      }
    }

    return artifacts;
  }

  async upload(
    tarPath: string,
    meta: ArtifactUploadMeta
  ): Promise<LocalArtifact> {
    if (!this.remote) {
      throw new Error("No rclone remote configured");
    }

    const id = crypto.randomUUID();
    const stat = await fs.promises.stat(tarPath);

    const artifact: LocalArtifact = {
      id,
      shop: meta.shop,
      objectId: meta.objectId,
      label: meta.label,
      hostname: meta.hostname,
      deviceId: meta.deviceId,
      platform: meta.platform,
      homeDir: meta.homeDir,
      winePrefixPath: meta.winePrefixPath,
      downloadOptionTitle: meta.downloadOptionTitle,
      sizeBytes: stat.size,
      isFrozen: false,
      createdAt: new Date().toISOString(),
    };

    this.writeCacheSidecar(artifact);
    const sidecarPath = path.join(
      this.cacheDir(meta.shop, meta.objectId),
      `${id}.json`
    );

    await this.runRclone(
      [
        "copyto",
        tarPath,
        this.remotePath(meta.shop, meta.objectId, `${id}.tar`),
      ],
      COPY_TIMEOUT_MS
    );
    await this.runRclone(
      [
        "copyto",
        sidecarPath,
        this.remotePath(meta.shop, meta.objectId, `${id}.json`),
      ],
      META_TIMEOUT_MS
    );

    return artifact;
  }

  async download(artifactId: string): Promise<string> {
    const artifact = this.requireResolved(artifactId);

    await fs.promises.mkdir(this.tmpRoot, { recursive: true });
    const localTar = path.join(this.tmpRoot, `${artifactId}.tar`);

    await this.runRclone(
      [
        "copyto",
        this.remotePath(artifact.shop, artifact.objectId, `${artifactId}.tar`),
        localTar,
      ],
      COPY_TIMEOUT_MS
    );

    return localTar;
  }

  async delete(artifactId: string): Promise<void> {
    const artifact = this.requireResolved(artifactId);

    for (const ext of ["tar", "json"]) {
      try {
        await this.runRclone(
          [
            "deletefile",
            this.remotePath(
              artifact.shop,
              artifact.objectId,
              `${artifactId}.${ext}`
            ),
          ],
          META_TIMEOUT_MS
        );
      } catch (error) {
        logger.error("Failed to delete remote artifact file", { ext, error });
      }
    }

    await fs.promises.rm(
      path.join(
        this.cacheDir(artifact.shop, artifact.objectId),
        `${artifactId}.json`
      ),
      { force: true }
    );
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
    const artifact = this.requireResolved(artifactId);
    mutate(artifact);

    this.writeCacheSidecar(artifact);
    const sidecarPath = path.join(
      this.cacheDir(artifact.shop, artifact.objectId),
      `${artifactId}.json`
    );

    await this.runRclone(
      [
        "copyto",
        sidecarPath,
        this.remotePath(artifact.shop, artifact.objectId, `${artifactId}.json`),
      ],
      META_TIMEOUT_MS
    );
  }

  async test(): Promise<BackupBackendTestResult> {
    if (!this.binaryPath) {
      return {
        ok: false,
        detail:
          "rclone was not found on your system. Install it (e.g. `sudo dnf install rclone`) and configure a remote with `rclone config`.",
      };
    }

    if (!this.remote) {
      return {
        ok: false,
        detail:
          "No rclone remote configured. Enter one like `myremote:games-saves`.",
      };
    }

    try {
      await this.runRclone(["lsd", this.remote], META_TIMEOUT_MS);
      return { ok: true, detail: this.remote };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
