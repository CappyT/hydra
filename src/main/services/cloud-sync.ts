import { levelKeys, gamesSublevel, db } from "@main/level";
import path from "node:path";
import * as tar from "tar";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import { Notification } from "electron";
import type {
  Game,
  GameShop,
  LocalArtifact,
  LudusaviBackupMapping,
  UserPreferences,
} from "@types";
import {
  backupsPath,
  publicProfilePath,
  sandboxHomesPath,
} from "@main/constants";
import { addTrailingSlash, getDeviceId, normalizePath } from "@main/helpers";
import { restoreLinuxBackup } from "./backup/linux-restore";
import { assertSafeSandboxPath } from "@main/helpers/sandbox-paths";
import { sanitizeSandboxGameKey } from "@main/helpers/sandbox-launch";
import { logger } from "./logger";
import { WindowManager } from "./window-manager";
import { Ludusavi } from "./ludusavi";
import { ACCOUNTLESS, formatDate } from "@shared";
import { assertLegacyCloudSaveWriteAllowed } from "./cloud-save/legacy-cloud-save-policy";
import i18next, { t } from "i18next";
import { SystemPath } from "./system-path";
import { Wine } from "./wine";
import { Sandbox } from "./sandbox";
import { updateGameRecord } from "./game-record-updater";
import { assertBackupSourcesInsideRoot } from "./backup/backup-source-paths";
import {
  BACKUP_TMP_DIRNAME,
  getArtifactBackend,
  getBackupScratchDir,
  restoreFromArtifactTar,
  decideLaunchSync,
  findSupersededRemoteBackup,
  laterTimestamp,
  previewHasLocalSaves,
  resolveBackupsToKeep,
  selectArtifactsToPrune,
} from "./backup";

/** ludusavi found no save files for the game, so there is nothing to back up. */
export class NoLocalSavesError extends Error {
  constructor(objectId: string) {
    super(`No save files found for ${objectId}`);
    this.name = "NoLocalSavesError";
  }
}

/**
 * Where ludusavi scans for a game's saves and where a restore writes them:
 * - `wine`: the game's Wine prefix (Linux, Windows executable).
 * - `native`: the per-game sandbox home (Linux native game). ludusavi gets it
 *   as HOME because the sandbox binds it over $HOME.
 * - `legacy`: host paths (LaunchBox on Linux, and non-Linux platforms).
 */
interface SaveTarget {
  mode: "wine" | "native" | "legacy";
  winePrefix: string | null;
  home: string | null;
}

export class CloudSync {
  private static isWineGame(game: Game | null | undefined) {
    return !game?.executablePath || /\.exe$/i.test(game.executablePath);
  }

  private static getSandboxHome(shop: GameShop, objectId: string) {
    return path.join(
      sandboxHomesPath,
      sanitizeSandboxGameKey(levelKeys.game(shop, objectId))
    );
  }

  private static async resolveSaveTarget(
    game: Game | null | undefined,
    shop: GameShop,
    objectId: string
  ): Promise<SaveTarget> {
    const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
      game?.winePrefixPath,
      objectId
    );

    if (process.platform !== "linux") {
      return {
        mode: "legacy",
        winePrefix: effectiveWinePrefixPath,
        home: null,
      };
    }

    if (shop === "launchbox") {
      return { mode: "legacy", winePrefix: null, home: null };
    }

    if (CloudSync.isWineGame(game)) {
      return { mode: "wine", winePrefix: effectiveWinePrefixPath, home: null };
    }

    const preferences = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    // Restore writes native saves only into the sandbox home; an unsandboxed
    // game saves under the real home, which a restore must never target.
    if (!Sandbox.isEnabled(preferences, game)) {
      throw new Error(
        "Save backups of native Linux games require the game sandbox"
      );
    }

    const home = CloudSync.getSandboxHome(shop, objectId);
    return {
      mode: "native",
      winePrefix: null,
      home: fs.existsSync(home) ? fs.realpathSync(home) : home,
    };
  }

  /** Home path recorded in the artifact; restore maps it to this device's. */
  private static getArtifactHomeDir(target: SaveTarget) {
    if (target.mode === "native") return target.home!;
    if (target.mode === "legacy" && !target.winePrefix)
      return normalizePath(SystemPath.getPath("home"));
    return CloudSync.getWindowsLikeUserProfilePath(target.winePrefix);
  }

  /** Device name for conflict notices; legacy backups may lack a hostname. */
  private static describeDevice(artifact: LocalArtifact | null | undefined) {
    return artifact?.hostname || artifact?.deviceId || "unknown device";
  }

  /** ludusavi preview of the saves a backup of this game would capture. */
  public static async getBackupPreview(shop: GameShop, objectId: string) {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    const target = await CloudSync.resolveSaveTarget(game, shop, objectId);
    return Ludusavi.getBackupPreview(
      shop,
      objectId,
      target.winePrefix,
      target.home
    );
  }

  public static getWindowsLikeUserProfilePath(winePrefixPath?: string | null) {
    if (process.platform === "linux") {
      if (!winePrefixPath) {
        throw new Error("Wine prefix path is required");
      }

      const userProfile = Wine.getWindowsUserProfilePath(winePrefixPath);
      if (!userProfile) throw new Error("User profile not found in user.reg");
      return userProfile;
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

  /**
   * Label for the safety backup taken of THIS device's interrupted local state
   * before a keep-both conflict resolution, so it is easy to spot in history.
   */
  public static getConflictBackupLabel() {
    const language = i18next.language;
    const date = formatDate(new Date(), language);

    return t("conflict_backup_from", {
      ns: "game_details",
      device: os.hostname(),
      date,
    });
  }

  private static async bundleBackup(
    shop: GameShop,
    objectId: string,
    target: SaveTarget
  ) {
    // Scratch dirs left by a crashed run are never reused, so purge them. Every
    // backup runs under runWithHydraSaveGuard, so no other bundle is active.
    await fs.promises.rm(path.join(backupsPath, BACKUP_TMP_DIRNAME), {
      recursive: true,
      force: true,
    });
    const scratchPrefix = getBackupScratchDir(backupsPath, shop, objectId);
    await fs.promises.mkdir(path.dirname(scratchPrefix), { recursive: true });
    const backupPath = await fs.promises.mkdtemp(scratchPrefix + "-");

    try {
      const result = await Ludusavi.backupGame(
        shop,
        objectId,
        backupPath,
        target.winePrefix,
        false,
        target.home
      );

      // An empty backup has no mapping.yaml: every restore of it fails, and it
      // still takes a retention slot.
      if (!result?.overall?.totalGames || !result.games?.[objectId]) {
        throw new NoLocalSavesError(objectId);
      }

      if (process.platform === "linux") {
        const saveRoot =
          target.mode === "wine"
            ? target.winePrefix
            : target.mode === "native"
              ? target.home
              : SystemPath.getPath("home");
        if (!saveRoot) throw new Error("No save root for the backup check");
        assertBackupSourcesInsideRoot(
          Object.keys(result.games[objectId].files ?? {}),
          saveRoot
        );
      }

      const tarLocation = path.join(backupsPath, `${crypto.randomUUID()}.tar`);

      try {
        await tar.create(
          {
            gzip: false,
            file: tarLocation,
            cwd: backupPath,
          },
          ["."]
        );
      } catch (error) {
        await fs.promises.rm(tarLocation, { force: true });
        throw error;
      }

      return tarLocation;
    } finally {
      await fs.promises
        .rm(backupPath, { recursive: true, force: true })
        .catch((error) =>
          logger.error("Failed to remove backup scratch", { backupPath, error })
        );
    }
  }

  public static async uploadSaveGame(
    objectId: string,
    shop: GameShop,
    downloadOptionTitle: string | null,
    label?: string,
    conflictSafety?: boolean
  ): Promise<LocalArtifact> {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    if (!ACCOUNTLESS) assertLegacyCloudSaveWriteAllowed(game);
    const target = await this.resolveSaveTarget(game, shop, objectId);
    // Resolved before bundling: a missing prefix profile must fail early.
    const homeDir = this.getArtifactHomeDir(target);

    let resolvedWinePrefixPath: string | null = null;

    if (target.winePrefix) {
      resolvedWinePrefixPath = fs.existsSync(target.winePrefix)
        ? fs.realpathSync(target.winePrefix)
        : target.winePrefix;
    }

    const bundleLocation = await this.bundleBackup(shop, objectId, target);

    let artifact: LocalArtifact;
    try {
      const backend = await getArtifactBackend();

      artifact = await backend.upload(bundleLocation, {
        shop,
        objectId,
        hostname: os.hostname(),
        deviceId: getDeviceId(),
        winePrefixPath: resolvedWinePrefixPath,
        homeDir,
        downloadOptionTitle,
        platform: process.platform,
        label,
        conflictSafety,
      });
    } finally {
      try {
        await fs.promises.unlink(bundleLocation);
      } catch (error) {
        logger.error("Failed to remove tar file", { bundleLocation, error });
      }
    }

    WindowManager.sendToAppWindows(
      `on-upload-complete-${objectId}-${shop}`,
      true
    );

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

    try {
      await restoreFromArtifactTar({
        backupsRoot: backupsPath,
        shop,
        objectId,
        tarLocation,
        restore: (scratchDir) => {
          if (process.platform === "linux" && shop !== "launchbox") {
            const wine = CloudSync.isWineGame(game);
            const destinationRoot = wine
              ? effectiveWinePrefixPath
              : CloudSync.getSandboxHome(shop, objectId);
            if (!destinationRoot)
              throw new Error("No approved save destination");
            assertSafeSandboxPath(
              destinationRoot,
              SystemPath.getPath("home"),
              SystemPath.getPath("userData")
            );
            fs.mkdirSync(destinationRoot, { recursive: true });
            return restoreLinuxBackup({
              // Both roots canonical: the worker refuses symlinked ancestors.
              sourceRoot: fs.realpathSync(path.join(scratchDir, objectId)),
              destinationRoot: fs.realpathSync(destinationRoot),
              artifactHome: artifact.homeDir,
              artifactWinePrefix: artifact.winePrefixPath,
              wineUserHome: wine
                ? CloudSync.getWindowsLikeUserProfilePath(
                    effectiveWinePrefixPath
                  )
                : undefined,
              wine,
            });
          }
          // LaunchBox saves live on host paths, never in a Wine prefix.
          return CloudSync.restoreLudusaviBackup(
            scratchDir,
            objectId,
            normalizePath(artifact.homeDir),
            process.platform === "linux" ? null : effectiveWinePrefixPath,
            artifact.winePrefixPath
          );
        },
      });
    } finally {
      await backend.release?.(tarLocation).catch((error: unknown) =>
        logger.error("Failed to release downloaded backup", {
          artifactId,
          error,
        })
      );
    }

    return { createdAt: artifact.createdAt };
  }

  /**
   * FAIL-SAFE detection of whether this device currently has local save files
   * for the game. Used ONLY on a fresh device (sync marker unset) to choose
   * between a first-run restore and adopt-baseline. Runs a ludusavi backup
   * *preview* — the same read-only scan the real backup uses to enumerate save
   * files — and returns `false` ONLY on a POSITIVE determination that ludusavi
   * found zero save files. ANY error/timeout/missing/ambiguous result → `true`
   * ("assume saves exist"), so a restore can never clobber saves we failed to
   * detect. Logs the determination one line either way.
   */
  private static async detectHasLocalSaves(
    shop: GameShop,
    objectId: string,
    game: Game
  ): Promise<boolean> {
    try {
      const target = await CloudSync.resolveSaveTarget(game, shop, objectId);

      const preview = await Ludusavi.getBackupPreview(
        shop,
        objectId,
        target.winePrefix,
        target.home
      );

      const hasLocalSaves = previewHasLocalSaves(
        preview,
        objectId,
        target.mode === "wine"
      );

      logger.info("Local-save detection on fresh device", {
        shop,
        objectId,
        mode: target.mode,
        totalGames: preview?.overall?.totalGames ?? null,
        gameFound: !!preview?.games?.[objectId],
        hasLocalSaves,
      });

      return hasLocalSaves;
    } catch (error) {
      logger.error(
        "Local-save detection failed on fresh device; assuming saves exist",
        { shop, objectId, error }
      );
      return true;
    }
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

      // Only pay for local-save detection on a fresh device (marker unset) that
      // actually has backups to restore — never on every launch. `undefined`
      // keeps the planner on the safe adopt-baseline path.
      let hasLocalSaves: boolean | undefined;
      if (!game.lastSyncedBackupAt && artifacts.length > 0) {
        hasLocalSaves = await CloudSync.detectHasLocalSaves(
          shop,
          objectId,
          game
        );
      }

      const plan = decideLaunchSync({
        lastSyncedBackupAt: game.lastSyncedBackupAt,
        artifacts,
        ourDeviceId: getDeviceId(),
        unsyncedSince: game.unsyncedSince,
        hasLocalSaves,
      });

      if (plan.action === "none") return;

      if (plan.action === "adopt-baseline") {
        await updateGameRecord(gameKey, {
          lastSyncedBackupAt: plan.createdAt,
        });
        return;
      }

      if (plan.action === "conflict") {
        // Keep-both, zero data loss: FIRST snapshot this device's interrupted
        // local state into history (never lost), THEN activate the newer remote.
        // Deliberately NO finalizeBackup/prune here: pruning mid-operation could
        // race the restore or delete artifacts we still need.
        let conflictArtifact: LocalArtifact | null = null;
        // The safety backup captures what ludusavi sees; when it sees no save
        // files there is nothing local to preserve before the restore.
        let nothingToPreserve = false;
        try {
          conflictArtifact = await CloudSync.uploadSaveGame(
            objectId,
            shop,
            null,
            CloudSync.getConflictBackupLabel(),
            true
          );
        } catch (error) {
          nothingToPreserve = error instanceof NoLocalSavesError;
          logger.error(
            "Failed to back up local state before conflict restore",
            {
              shop,
              objectId,
              nothingToPreserve,
              error,
            }
          );
        }

        const remoteArtifact = artifacts.find(
          (item) => item.id === plan.artifactId
        );

        // DATA-SAFETY GUARD: if we could NOT preserve this device's local saves
        // (the conflict backup failed), do NOT overwrite them with the remote.
        // Keep local intact and leave the marker + unsyncedSince flag unchanged
        // so the conflict is re-detected and retried on the next launch. Warn the
        // user; never trade an un-backed-up local save for the remote.
        if (!conflictArtifact && !nothingToPreserve) {
          logger.error(
            "Conflict backup failed; keeping local saves, not restoring remote",
            { shop, objectId }
          );

          WindowManager.sendToAppWindows("on-cloud-sync-conflict", {
            shop,
            objectId,
            hostname: CloudSync.describeDevice(remoteArtifact),
            resolution: "kept-local",
          });
          return;
        }

        // Freeze the conflict safety-backup so normal retention NEVER auto-
        // deletes this device's interrupted local saves on a future close-backup
        // (selectArtifactsToPrune always keeps frozen artifacts). Only the user
        // can remove it later from the backup list. Best-effort: a freeze
        // failure must not stop the restore of the newer remote state.
        if (conflictArtifact) {
          try {
            await backend.setFrozen(conflictArtifact.id, true);
          } catch (error) {
            logger.error("Failed to freeze conflict safety backup", {
              shop,
              objectId,
              artifactId: conflictArtifact.id,
              error,
            });
          }
        }

        await CloudSync.restoreArtifact(shop, objectId, plan.artifactId!);

        await updateGameRecord(gameKey, {
          // The safety backup is newer than the remote and carries this device
          // id; a remote-dated marker would restore it on the next launch.
          lastSyncedBackupAt: conflictArtifact
            ? laterTimestamp(plan.createdAt!, conflictArtifact.createdAt)
            : plan.createdAt,
          // The divergence is resolved (kept as a backup); clear the flag.
          unsyncedSince: null,
        });

        logger.info("Resolved cloud save conflict (kept both) before launch", {
          shop,
          objectId,
          artifactId: plan.artifactId,
        });

        // Non-blocking warning so the user knows what happened and how to undo.
        WindowManager.sendToAppWindows("on-cloud-sync-conflict", {
          shop,
          objectId,
          hostname: CloudSync.describeDevice(remoteArtifact),
          resolution: "kept-both",
        });
        return;
      }

      // action === "restore"
      await CloudSync.restoreArtifact(shop, objectId, plan.artifactId!);

      await updateGameRecord(gameKey, {
        lastSyncedBackupAt: plan.createdAt,
      });

      logger.info("Restored newer cloud backup before launch", {
        shop,
        objectId,
        artifactId: plan.artifactId,
      });
    } catch (error) {
      logger.error("Cloud sync on launch failed", { shop, objectId, error });

      WindowManager.sendToAppWindows(
        `on-cloud-sync-error-${objectId}-${shop}`,
        error instanceof Error ? error.message : String(error)
      );

      await CloudSync.handleSyncOnLaunchFailure(gameKey);
    }
  }

  /**
   * A failed sync-in leaves the remote state unknown. The launch goes on, so
   * warn the user and mark the session as diverged: the next launch then
   * treats a newer remote as a conflict, and the close-backup's supersede
   * check freezes it. Never throws.
   */
  private static async handleSyncOnLaunchFailure(gameKey: string) {
    try {
      const game = await updateGameRecord(gameKey, (current) =>
        current.unsyncedSince ? {} : { unsyncedSince: new Date().toISOString() }
      );
      if (!game) return;

      // A desktop notification stays visible while the game takes the screen.
      if (Notification.isSupported()) {
        new Notification({
          title: t("cloud_save_v2_auto_sync_failed_title", {
            ns: "game_details",
          }),
          body: `${game.title}: ${t("cloud_save_v2_auto_sync_failed_description", { ns: "game_details" })}`,
        }).show();
      }
    } catch (error) {
      logger.error("Failed to report cloud sync on launch failure", {
        gameKey,
        error,
      });
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
      const markerBeforeUpload = (await gamesSublevel.get(gameKey))
        ?.lastSyncedBackupAt;

      const { freezeFailed } = await CloudSync.preserveSupersededRemoteBackup(
        shop,
        objectId,
        artifact,
        markerBeforeUpload
      );

      await updateGameRecord(gameKey, {
        lastSyncedBackupAt: artifact.createdAt,
        // A clean close-backup captured this device's changes; no divergence.
        unsyncedSince: null,
      });

      // An unfrozen superseded backup is among the oldest after this upload,
      // so retention could delete it.
      if (freezeFailed) {
        logger.error("Skipping backup pruning: superseded backup not frozen", {
          shop,
          objectId,
        });
        return;
      }

      await CloudSync.pruneBackups(shop, objectId);
    } catch (error) {
      logger.error("Failed to finalize backup", { shop, objectId, error });
    }
  }

  /**
   * Another device may have uploaded while this session ran (e.g. a suspended
   * Deck resumes after the desktop played). This device's new backup is now
   * the latest and would silently win, so freeze the other device's backup and
   * warn, like the launch-side keep-both conflict. A listing failure skips only
   * this check. Never throws.
   */
  private static async preserveSupersededRemoteBackup(
    shop: GameShop,
    objectId: string,
    artifact: LocalArtifact,
    markerBeforeUpload: string | undefined
  ): Promise<{ freezeFailed: boolean }> {
    let superseded: LocalArtifact | null;
    let backend: Awaited<ReturnType<typeof getArtifactBackend>>;
    try {
      backend = await getArtifactBackend();
      superseded = findSupersededRemoteBackup({
        lastSyncedBackupAt: markerBeforeUpload,
        artifacts: await backend.list(shop, objectId),
        ourDeviceId: getDeviceId(),
        uploadedArtifactId: artifact.id,
      });
    } catch (error) {
      logger.error("Failed to check for a superseded remote backup", {
        shop,
        objectId,
        error,
      });
      return { freezeFailed: false };
    }

    if (!superseded) return { freezeFailed: false };

    let freezeFailed = false;
    if (!superseded.isFrozen) {
      try {
        await backend.setFrozen(superseded.id, true);
      } catch (error) {
        freezeFailed = true;
        logger.error("Failed to freeze superseded remote backup", {
          shop,
          objectId,
          artifactId: superseded.id,
          error,
        });
      }
    }

    logger.warn("Backup superseded another device's newer backup; kept both", {
      shop,
      objectId,
      artifactId: artifact.id,
      supersededId: superseded.id,
    });

    WindowManager.sendToAppWindows("on-cloud-sync-conflict", {
      shop,
      objectId,
      hostname: CloudSync.describeDevice(superseded),
      resolution: "kept-both",
    });

    return { freezeFailed };
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

    const userProfilePath = winePrefixPath
      ? CloudSync.getWindowsLikeUserProfilePath(winePrefixPath)
      : normalizePath(SystemPath.getPath("home"));

    const moves: { sourcePath: string; destinationPath: string }[] = [];

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

        moves.push({ sourcePath, destinationPath });
      });
    });

    // Verify every source before touching any destination: a file missing
    // from the archive must not cost the existing save.
    for (const { sourcePath } of moves) {
      if (!fs.lstatSync(sourcePath).isFile()) {
        throw new Error(`Backup entry is not a regular file: ${sourcePath}`);
      }
    }

    // Stage a copy next to each destination, then rename over it: the copy
    // works across filesystems (EXDEV) and the rename replaces atomically.
    const staged: { tempPath: string; destinationPath: string }[] = [];
    try {
      for (const { sourcePath, destinationPath } of moves) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const tempPath = `${destinationPath}.hydra-restore-${crypto.randomUUID()}`;
        staged.push({ tempPath, destinationPath });
        fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
      }

      for (const { tempPath, destinationPath } of staged) {
        logger.info(`Restoring ${destinationPath}`);
        fs.renameSync(tempPath, destinationPath);
      }
    } finally {
      for (const { tempPath } of staged) {
        fs.rmSync(tempPath, { force: true });
      }
    }
  }
}
