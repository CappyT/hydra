import { levelKeys, gamesSublevel, db } from "@main/level";
import path from "node:path";
import * as tar from "tar";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import type {
  GameShop,
  LocalArtifact,
  LudusaviBackupMapping,
  UserPreferences,
} from "@types";
import { backupsPath, publicProfilePath } from "@main/constants";
import { addTrailingSlash, normalizePath, parseRegFile } from "@main/helpers";
import { logger } from "./logger";
import { WindowManager } from "./window-manager";
import { Ludusavi } from "./ludusavi";
import { formatDate } from "@shared";
import i18next, { t } from "i18next";
import { SystemPath } from "./system-path";
import { Wine } from "./wine";
import {
  getArtifactBackend,
  restoreFromArtifactTar,
  decideLaunchSync,
  resolveBackupsToKeep,
  selectArtifactsToPrune,
} from "./backup";

export class CloudSync {
  public static getWindowsLikeUserProfilePath(winePrefixPath?: string | null) {
    if (process.platform === "linux") {
      if (!winePrefixPath) {
        throw new Error("Wine prefix path is required");
      }

      const userReg = fs.readFileSync(
        path.join(winePrefixPath, "user.reg"),
        "utf8"
      );

      const entries = parseRegFile(userReg);
      const volatileEnvironment = entries.find(
        (entry) => entry.path === "Volatile Environment"
      );

      if (!volatileEnvironment) {
        throw new Error("Volatile environment not found in user.reg");
      }

      const { values } = volatileEnvironment;
      const userProfile = String(values["USERPROFILE"]);

      if (userProfile) {
        return normalizePath(userProfile);
      } else {
        throw new Error("User profile not found in user.reg");
      }
    }

    return normalizePath(SystemPath.getPath("home"));
  }

  public static getBackupLabel(automatic: boolean) {
    const language = i18next.language;

    const date = formatDate(new Date(), language);

    if (automatic) {
      return t("automatic_backup_from", {
        ns: "game_details",
        date,
      });
    }

    return t("backup_from", {
      ns: "game_details",
      date,
    });
  }

  private static async bundleBackup(
    shop: GameShop,
    objectId: string,
    winePrefix: string | null
  ) {
    const backupPath = path.join(backupsPath, `${shop}-${objectId}`);

    // Remove existing backup
    if (fs.existsSync(backupPath)) {
      try {
        await fs.promises.rm(backupPath, { recursive: true });
      } catch (error) {
        logger.error("Failed to remove backup path", { backupPath, error });
      }
    }

    await Ludusavi.backupGame(shop, objectId, backupPath, winePrefix);

    const tarLocation = path.join(backupsPath, `${crypto.randomUUID()}.tar`);

    await tar.create(
      {
        gzip: false,
        file: tarLocation,
        cwd: backupPath,
      },
      ["."]
    );

    return tarLocation;
  }

  public static async uploadSaveGame(
    objectId: string,
    shop: GameShop,
    downloadOptionTitle: string | null,
    label?: string
  ): Promise<LocalArtifact> {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
      game?.winePrefixPath,
      objectId
    );

    const bundleLocation = await this.bundleBackup(
      shop,
      objectId,
      effectiveWinePrefixPath
    );

    let resolvedWinePrefixPath: string | null = null;

    if (effectiveWinePrefixPath) {
      resolvedWinePrefixPath = fs.existsSync(effectiveWinePrefixPath)
        ? fs.realpathSync(effectiveWinePrefixPath)
        : effectiveWinePrefixPath;
    }

    const backend = await getArtifactBackend();

    const artifact = await backend.upload(bundleLocation, {
      shop,
      objectId,
      hostname: os.hostname(),
      winePrefixPath: resolvedWinePrefixPath,
      homeDir: this.getWindowsLikeUserProfilePath(effectiveWinePrefixPath),
      downloadOptionTitle,
      platform: process.platform,
      label,
    });

    WindowManager.sendToAppWindows(
      `on-upload-complete-${objectId}-${shop}`,
      true
    );

    try {
      await fs.promises.unlink(bundleLocation);
    } catch (error) {
      logger.error("Failed to remove tar file", { bundleLocation, error });
    }

    return artifact;
  }

  /**
   * Shared save-restore core used by BOTH the per-artifact restore IPC event
   * (`downloadGameArtifact`) and the launch-time auto-sync ({@link syncOnLaunch}).
   * Lists the game's artifacts, materialises the requested one, extracts it into
   * a scratch dir and moves the files back into place via ludusavi's mapping.
   * Returns the restored artifact's `createdAt` so callers can update the sync
   * marker. Throws if the artifact is missing or restore fails.
   */
  public static async restoreArtifact(
    shop: GameShop,
    objectId: string,
    artifactId: string
  ): Promise<{ createdAt: string }> {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
      game?.winePrefixPath,
      objectId
    );

    const backend = await getArtifactBackend();
    const artifacts = await backend.list(shop, objectId);
    const artifact = artifacts.find((item) => item.id === artifactId);

    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const tarLocation = await backend.download(artifactId);

    await restoreFromArtifactTar({
      backupsRoot: backupsPath,
      shop,
      objectId,
      tarLocation,
      restore: (scratchDir) =>
        CloudSync.restoreLudusaviBackup(
          scratchDir,
          objectId,
          normalizePath(artifact.homeDir),
          effectiveWinePrefixPath,
          artifact.winePrefixPath
        ),
    });

    return { createdAt: artifact.createdAt };
  }

  /**
   * Steam-Cloud-like restore-BEFORE-launch. Awaited at the start of the launch
   * flow when `automaticCloudSync` is enabled. Restores the latest backup only
   * when it is strictly newer than this machine's sync marker (see
   * {@link decideLaunchSync}), then advances the marker. NEVER throws: a sync
   * failure must never make a game unlaunchable, so errors are logged and
   * surfaced as a non-blocking toast while the launch proceeds.
   */
  public static async syncOnLaunch(
    shop: GameShop,
    objectId: string
  ): Promise<void> {
    const gameKey = levelKeys.game(shop, objectId);

    try {
      const game = await gamesSublevel.get(gameKey);
      if (!game) return;

      const backend = await getArtifactBackend();
      const artifacts = await backend.list(shop, objectId);

      const plan = decideLaunchSync({
        lastSyncedBackupAt: game.lastSyncedBackupAt,
        artifacts,
      });

      if (plan.action === "none") return;

      if (plan.action === "adopt-baseline") {
        await gamesSublevel.put(gameKey, {
          ...game,
          lastSyncedBackupAt: plan.createdAt,
        });
        return;
      }

      // action === "restore"
      await CloudSync.restoreArtifact(shop, objectId, plan.artifactId!);

      // Re-read before persisting: the restore is async and other writers (e.g.
      // the process watcher) may have touched the record meanwhile.
      const latestGame = (await gamesSublevel.get(gameKey)) ?? game;
      await gamesSublevel.put(gameKey, {
        ...latestGame,
        lastSyncedBackupAt: plan.createdAt,
      });

      logger.info("Restored newer cloud backup before launch", {
        shop,
        objectId,
        artifactId: plan.artifactId,
      });
    } catch (error) {
      logger.error("Cloud sync on launch failed", { shop, objectId, error });

      // Best-effort non-blocking warning: surfaced by the cloud-sync panel if
      // the game-details page is open. The launch is never blocked.
      WindowManager.sendToAppWindows(
        `on-cloud-sync-error-${objectId}-${shop}`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Post-backup bookkeeping shared by the automatic (close) and manual backup
   * paths: advances this machine's sync marker to the just-created artifact and
   * prunes old backups under the retention policy. Never throws.
   */
  public static async finalizeBackup(
    shop: GameShop,
    objectId: string,
    artifact: LocalArtifact | null | undefined
  ): Promise<void> {
    if (!artifact) return;

    const gameKey = levelKeys.game(shop, objectId);

    try {
      const game = await gamesSublevel.get(gameKey);
      if (game) {
        await gamesSublevel.put(gameKey, {
          ...game,
          lastSyncedBackupAt: artifact.createdAt,
        });
      }

      await CloudSync.pruneBackups(shop, objectId);
    } catch (error) {
      logger.error("Failed to finalize backup", { shop, objectId, error });
    }
  }

  /**
   * Enforces the backup retention policy for a game: keeps every frozen backup
   * plus the newest N non-frozen ones (N = per-game override, else the global
   * default, else 10) and deletes the rest.
   */
  public static async pruneBackups(
    shop: GameShop,
    objectId: string
  ): Promise<void> {
    const preferences = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));

    const keep = resolveBackupsToKeep(
      game?.backupsToKeep,
      preferences?.defaultBackupsToKeep
    );

    const backend = await getArtifactBackend();
    const artifacts = await backend.list(shop, objectId);
    const idsToDelete = selectArtifactsToPrune(artifacts, keep);

    for (const id of idsToDelete) {
      try {
        await backend.delete(id);
        logger.info("Pruned old backup artifact", { shop, objectId, id });
      } catch (error) {
        logger.error("Failed to prune backup artifact", {
          shop,
          objectId,
          id,
          error,
        });
      }
    }
  }

  private static transformLudusaviBackupPathIntoWindowsPath(
    backupPath: string,
    winePrefixPath?: string | null
  ) {
    return backupPath
      .replace(winePrefixPath ? addTrailingSlash(winePrefixPath) : "", "")
      .replace("drive_c", "C:");
  }

  private static addWinePrefixToWindowsPath(
    windowsPath: string,
    winePrefixPath?: string | null
  ) {
    if (!winePrefixPath) {
      return windowsPath;
    }

    return path.join(winePrefixPath, windowsPath.replace("C:", "drive_c"));
  }

  private static restoreLudusaviBackup(
    backupPath: string,
    title: string,
    homeDir: string,
    winePrefixPath?: string | null,
    artifactWinePrefixPath?: string | null
  ) {
    const gameBackupPath = path.join(backupPath, title);
    const mappingYamlPath = path.join(gameBackupPath, "mapping.yaml");

    const data = fs.readFileSync(mappingYamlPath, "utf8");
    const manifest = YAML.parse(data) as {
      backups: LudusaviBackupMapping[];
      drives: Record<string, string>;
    };

    const userProfilePath =
      CloudSync.getWindowsLikeUserProfilePath(winePrefixPath);

    manifest.backups.forEach((backup) => {
      Object.keys(backup.files).forEach((key) => {
        const sourcePathWithDrives = Object.entries(manifest.drives).reduce(
          (prev, [driveKey, driveValue]) => {
            return prev.replace(driveValue, driveKey);
          },
          key
        );

        const sourcePath = path.join(gameBackupPath, sourcePathWithDrives);

        logger.info(`Source path: ${sourcePath}`);

        const destinationPath =
          CloudSync.transformLudusaviBackupPathIntoWindowsPath(
            key,
            artifactWinePrefixPath
          )
            .replace(
              homeDir,
              CloudSync.addWinePrefixToWindowsPath(
                userProfilePath,
                winePrefixPath
              )
            )
            .replace(
              publicProfilePath,
              CloudSync.addWinePrefixToWindowsPath(
                publicProfilePath,
                winePrefixPath
              )
            );

        logger.info(`Moving ${sourcePath} to ${destinationPath}`);

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

        if (fs.existsSync(destinationPath)) {
          fs.unlinkSync(destinationPath);
        }

        fs.renameSync(sourcePath, destinationPath);
      });
    });
  }
}
