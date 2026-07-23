import {
  app,
  BrowserWindow,
  dialog,
  net,
  powerMonitor,
  protocol,
} from "electron";
import updater from "electron-updater";
import i18n from "i18next";
import path from "node:path";
import url from "node:url";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import {
  logger,
  clearGamesPlaytime,
  WindowManager,
  Lock,
  PowerSaveBlockerManager,
  DownloadOrchestrator,
  SSEClient,
  SandboxUnavailableError,
} from "@main/services";
import resources from "@locales";
import { PythonRPC } from "./services/python-rpc";
import { db, gamesSublevel, levelKeys } from "./level";
import { GameShop, UserPreferences } from "@types";
import { launchGame } from "./helpers";
import { logMissingHostToolsOnce } from "./helpers/host-dependencies";
import { loadState } from "./main";

const { autoUpdater } = updater;

autoUpdater.setFeedURL({
  provider: "github",
  owner: "CappyT",
  repo: "hydra",
});

autoUpdater.logger = logger;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

if (process.platform !== "linux") {
  app.commandLine.appendSwitch("--no-sandbox");
} else {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");

  // Under Steam's gamescope session (Steam Deck gaming mode), disable Chromium's
  // Vulkan usage so the GPU process never creates a VkSwapchain. Gamescope's WSI
  // layer only expects to hook swapchains created through its own path; a
  // launcher swapchain created outside it triggers the modal "CreateSwapchainKHR:
  // Creating swapchain for non-Gamescope swapchain. Hooking has failed somewhere!"
  // dialog, and dismissing it can crash the session. Disabling Vulkan (the GPU
  // process falls back to GL, fine for a launcher UI) means no swapchain is ever
  // created, so the dialog can't appear. This is a process-local Chromium switch
  // — unlike ENABLE_GAMESCOPE_WSI=0 in the environment, it does NOT propagate to
  // games the launcher spawns, which must keep gamescope's WSI. Gated on the
  // gamescope session (gaming mode sets XDG_CURRENT_DESKTOP=gamescope; Deck
  // desktop mode sets KDE), so desktop launches keep their current GPU behavior.
  if (process.env.XDG_CURRENT_DESKTOP === "gamescope") {
    app.commandLine.appendSwitch(
      "disable-features",
      "Vulkan,VulkanFromANGLE,DefaultANGLEVulkan"
    );
  }
}

i18n.init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

const PROTOCOL = "hydralauncher";

// CLI switch to boot straight into the Big Picture window (fullscreen, gamepad
// UI), e.g. as a Steam launch option on a Steam Deck / HTPC. It forces
// big-picture mode for this launch only and never touches the persisted
// `launchInBigPicture` preference. `--bigpicture` is accepted as an alias.
// We scan `process.argv` (rather than `app.commandLine.hasSwitch`) to match the
// existing `--hidden` handling and because the flag lands in argv regardless of
// whether we run from source or a packaged AppImage.
const BIG_PICTURE_FLAGS = ["--big-picture", "--bigpicture"];

const hasBigPictureFlag = (argv: string[]) =>
  argv.some((arg) => BIG_PICTURE_FLAGS.includes(arg));

// CLI switch to disable the system tray for this launch: no tray is created and
// closing the last window becomes a real quit instead of hiding to tray. Meant
// for Steam Deck gaming mode (added to Steam as `--big-picture --no-tray`),
// which has no tray area — without it the closed app lingers headless and Steam
// keeps showing it as running. Per-launch only; it never touches any persisted
// preference. `--notray` is accepted as an alias. Scanned in `process.argv`
// like the flags above so it works identically from source and a packaged
// AppImage.
const NO_TRAY_FLAGS = ["--no-tray", "--notray"];

const hasNoTrayFlag = (argv: string[]) =>
  argv.some((arg) => NO_TRAY_FLAGS.includes(arg));

// Register the custom schemes as privileged so the renderer can fetch them
// (supportFetchAPI) and use the results on a canvas without tainting it
// (corsEnabled). Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local",
    privileges: { supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  {
    scheme: "gradient",
    privileges: { supportFetchAPI: true, corsEnabled: true },
  },
]);

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const initializeApp = async () => {
  electronApp.setAppUserModelId("gg.hydralauncher.hydra");

  protocol.handle("local", (request) => {
    const filePath = request.url.slice("local:".length);
    return net.fetch(url.pathToFileURL(decodeURI(filePath)).toString());
  });

  protocol.handle("gradient", (request) => {
    const gradientCss = decodeURIComponent(
      request.url.slice("gradient:".length)
    );

    // Parse gradient CSS safely without regex to prevent ReDoS
    let direction = "45deg";
    let color1 = "#4a90e2";
    let color2 = "#7b68ee";

    // Simple string parsing approach - more secure than regex
    if (
      gradientCss.startsWith("linear-gradient(") &&
      gradientCss.endsWith(")")
    ) {
      const content = gradientCss.slice(16, -1); // Remove "linear-gradient(" and ")"
      const parts = content.split(",").map((part) => part.trim());

      if (parts.length >= 3) {
        direction = parts[0];
        color1 = parts[1];
        color2 = parts[2];
      }
    }

    let x1 = "0%",
      y1 = "0%",
      x2 = "100%",
      y2 = "100%";

    if (direction === "to right") {
      y2 = "0%";
    } else if (direction === "to bottom") {
      x2 = "0%";
    } else if (direction === "45deg") {
      y1 = "100%";
      y2 = "0%";
    } else if (direction === "225deg") {
      x1 = "100%";
      x2 = "0%";
    } else if (direction === "315deg") {
      x1 = "100%";
      y1 = "100%";
      x2 = "0%";
      y2 = "0%";
    }
    // Note: "135deg" case removed as it uses all default values

    const svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
        <defs>
          <linearGradient id="grad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
            <stop offset="0%" style="stop-color:${color1};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${color2};stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
      </svg>
    `;

    return new Response(svgContent, {
      headers: { "Content-Type": "image/svg+xml" },
    });
  });

  await loadState();

  // One-time startup probe: warn (in the launch log) about any missing optional
  // host tools (bwrap / pasta / gamescope). The user-facing toast is shown by
  // the renderer, which pulls the list via `getMissingHostTools` on mount.
  logMissingHostToolsOnce();

  // Suspend can outlive the 60s stall watchdog; reconnect right away instead
  powerMonitor.on("resume", () => {
    SSEClient.reconnectNow();
    DownloadOrchestrator.onNetworkStatusChanged({
      online: true,
      switched: true,
    });
  });

  const language = await db
    .get<string, string>(levelKeys.language, {
      valueEncoding: "utf8",
    })
    .catch(() => "en");

  if (language) i18n.changeLanguage(language);

  // Check if starting from a "run" deep link - don't show main window in that case
  const deepLinkArg = process.argv.find((arg) =>
    arg.startsWith("hydralauncher://")
  );
  // hasBigPictureFlag also accepts the --bigpicture alias.
  const forceBigPicture = hasBigPictureFlag(process.argv);
  const isRunDeepLink = deepLinkArg?.startsWith("hydralauncher://run");

  // --big-picture wins over --hidden autostart: always open a window and force
  // the fullscreen big-picture layout on top of it.
  if (
    forceBigPicture ||
    (!process.argv.includes("--hidden") && !isRunDeepLink)
  ) {
    WindowManager.createMainWindow({ forceBigPicture });
  }

  // --no-tray: never create the tray, and make closing the last window quit the
  // whole app (the flag is stored on WindowManager so its window-close and
  // Big-Picture-close handlers can take the real-quit path). Used on Steam Deck
  // gaming mode, where a trayless headless process would otherwise linger.
  WindowManager.noTray = hasNoTrayFlag(process.argv);
  if (!WindowManager.noTray) {
    WindowManager.createSystemTray(language || "en");
  }

  if (deepLinkArg) {
    handleDeepLinkPath(deepLinkArg);
  }
};

app.on("browser-window-created", (_, window) => {
  optimizer.watchWindowShortcuts(window);
});

const handleRunGame = async (shop: GameShop, objectId: string) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game?.executablePath) {
    logger.error("Game not found or no executable path", { shop, objectId });
    return;
  }

  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    { valueEncoding: "json" }
  );

  // Only open main window if setting is disabled
  if (!userPreferences?.hideToTrayOnGameStart) {
    WindowManager.createMainWindow();
  }

  try {
    await launchGame({
      shop,
      objectId,
      executablePath: game.executablePath,
      launchOptions: game.launchOptions,
    });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      dialog.showErrorBox("Hydra", error.message);
      return;
    }

    throw error;
  }
};

const handleDeepLinkPath = (uri?: string) => {
  if (!uri) return;

  try {
    const url = new URL(uri);

    if (url.host === "run") {
      const shop = url.searchParams.get("shop") as GameShop | null;
      const objectId = url.searchParams.get("objectId");

      if (shop && objectId) {
        handleRunGame(shop, objectId);
      }

      return;
    }

    if (url.host === "install-source") {
      WindowManager.redirect(`settings${url.search}`);
      return;
    }

    if (url.host === "profile") {
      const userId = url.searchParams.get("userId");

      if (userId) {
        WindowManager.redirect(`profile/${userId}`);
      }

      return;
    }

    if (url.host === "install-theme") {
      const themeName = url.searchParams.get("theme");
      const authorId = url.searchParams.get("authorId");
      const authorName = url.searchParams.get("authorName");

      if (themeName && authorId && authorName) {
        WindowManager.redirect(
          `settings?theme=${themeName}&authorId=${authorId}&authorName=${authorName}`
        );
      }
    }
  } catch (error) {
    logger.error("Error handling deep link", uri, error);
  }
};

app.on("second-instance", (_event, commandLine) => {
  const deepLink = commandLine.find((arg) =>
    arg.startsWith("hydralauncher://")
  );
  // hasBigPictureFlag also accepts the --bigpicture alias.
  const forceBigPicture = hasBigPictureFlag(commandLine);

  // Check if this is a "run" deep link - don't show main window in that case
  const isRunDeepLink = deepLink?.startsWith("hydralauncher://run");

  if (!isRunDeepLink) {
    if (WindowManager.mainWindow) {
      if (WindowManager.mainWindow.isMinimized())
        WindowManager.mainWindow.restore();

      WindowManager.mainWindow.focus();
      if (forceBigPicture) {
        void WindowManager.openBigPictureWindow();
      }
    } else {
      WindowManager.createMainWindow({ forceBigPicture });
    }
  }

  handleDeepLinkPath(deepLink);
});

app.on("open-url", (_event, url) => {
  handleDeepLinkPath(url);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  WindowManager.clearMainWindow();
});

let canAppBeClosed = false;

app.on("before-quit", async (e) => {
  await Lock.releaseLock();

  if (!canAppBeClosed) {
    e.preventDefault();
    PowerSaveBlockerManager.reset();
    /* Disconnects Python RPC */
    PythonRPC.kill();
    await clearGamesPlaytime();
    canAppBeClosed = true;
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    WindowManager.createMainWindow();
  }
});

// Some Electron APIs can only be used after initialization finishes.
// Top-level await blocks Electron startup when running through electron-vite.
app.once("ready", initializeApp);

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
