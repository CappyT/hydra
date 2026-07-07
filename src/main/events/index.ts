import fs from "node:fs";

import { appVersion, defaultDownloadsPath, isStaging } from "@main/constants";
import { ipcMain } from "electron";

import "./auth";
import "./autoupdater";
import "./big-picture";
import "./catalogue";
import "./cloud-save";
import "./connectivity";
import "./download-sources";
import "./friends";
import "./hardware";
import "./library";
import "./leveldb";
import "./main-window-controls";
import "./misc";
import "./notifications";
import "./profile";
import "./themes";
import "./torrenting";
import "./user";
import "./user-preferences";
import "./library/transfer-game-files";
import "./emulators";

import { isPortableVersion } from "@main/helpers";

ipcMain.handle("ping", () => "pong");
ipcMain.handle("getVersion", () => appVersion);
ipcMain.handle("isStaging", () => isStaging);
ipcMain.handle("isPortableVersion", () => isPortableVersion());
ipcMain.handle("getDefaultDownloadsPath", () => {
  // The launcher-owned default may not exist yet (unlike the system
  // Downloads folder) — ensure it does before handing it to the renderer.
  fs.mkdirSync(defaultDownloadsPath, { recursive: true });
  return defaultDownloadsPath;
});
ipcMain.handle("getCloudIframeUrl", () => {
  const checkoutUrl = import.meta.env.MAIN_VITE_CHECKOUT_URL;
  if (!checkoutUrl) return "";
  return new URL("/cloud", checkoutUrl).toString();
});
