import updater, { UpdateInfo } from "electron-updater";
import { getSteamLocation, logger, WindowManager } from "@main/services";
import { AppUpdaterEvent, UserPreferences } from "@types";
import { app } from "electron";
import { publishNotificationUpdateReadyToInstall } from "@main/services/notifications";
import { db, levelKeys } from "@main/level";
import { rewriteSteamShortcutTargetsSync } from "@main/helpers/steam-shortcut-target";

const { autoUpdater } = updater;
const sendEventsForDebug = false;

export class UpdateManager {
  private static hasNotified = false;
  private static newVersion = "";
  // Resolved before the install starts: the rename handler must run
  // synchronously (see onAppImageRenamed), so it cannot await the lookup.
  private static steamLocation: string | null = null;

  private static mockValuesForDebug() {
    this.sendEvent({ type: "update-available", info: { version: "3.3.1" } });
    this.sendEvent({ type: "update-downloaded" });
  }

  private static sendEvent(event: AppUpdaterEvent) {
    WindowManager.mainWindow?.webContents.send("autoUpdaterEvent", event);
  }

  private static async isAutoInstallEnabled() {
    if (process.platform === "darwin") return false;
    if (process.platform === "win32") {
      return process.env.PORTABLE_EXECUTABLE_FILE == null;
    }

    if (process.platform === "linux") {
      const userPreferences = await db.get<string, UserPreferences | null>(
        levelKeys.userPreferences,
        {
          valueEncoding: "json",
        }
      );

      return userPreferences?.enableAutoInstall === true;
    }

    return false;
  }

  // Fork: electron-updater renames the AppImage to hydralauncher-<version>
  // (artifactName) and deletes the old file. Steam shortcuts store the old
  // $APPIMAGE path, so retarget them before the app quits.
  private static onAppImageRenamed(newPath: string) {
    const oldPath = process.env.APPIMAGE;

    if (!oldPath || !this.steamLocation) return;

    try {
      const changed = rewriteSteamShortcutTargetsSync(
        this.steamLocation,
        oldPath,
        newPath
      );
      logger.log(`Retargeted ${changed} Steam shortcut(s) to ${newPath}`);
    } catch (error) {
      logger.error("Failed to retarget Steam shortcuts", error);
    }
  }

  public static async checkForUpdates() {
    autoUpdater
      .removeAllListeners()
      .on("update-available", (info: UpdateInfo) => {
        this.sendEvent({ type: "update-available", info });
        this.newVersion = info.version;
      })
      .on("update-downloaded", () => {
        this.sendEvent({ type: "update-downloaded" });

        if (process.platform === "linux") {
          getSteamLocation()
            .then((location) => {
              this.steamLocation = location;
            })
            .catch(() => {});
        }

        if (!this.hasNotified) {
          this.hasNotified = true;
          publishNotificationUpdateReadyToInstall(this.newVersion);
        }
      });

    // Emitted by AppImageUpdater only; not part of the typed AppUpdater events.
    (autoUpdater as unknown as NodeJS.EventEmitter).on(
      "appimage-filename-updated",
      (newPath: string) => this.onAppImageRenamed(newPath)
    );

    const isAutoInstallAvailable = await this.isAutoInstallEnabled();

    if (app.isPackaged) {
      autoUpdater.autoDownload = isAutoInstallAvailable;
      autoUpdater.checkForUpdates().then((result) => {
        logger.log(`Check for updates result: ${result}`);
      });
    } else if (sendEventsForDebug) {
      this.mockValuesForDebug();
    }

    return isAutoInstallAvailable;
  }
}
