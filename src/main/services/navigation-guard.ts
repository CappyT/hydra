import { app, shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isAppUrl,
  shouldBlockNavigation,
  type TrustedAppPages,
} from "@main/helpers/app-navigation";
import { parseExternalUrl } from "@main/helpers/external-url";
import { logger } from "./logger";

const trustedPages = (): TrustedAppPages => {
  const candidates = [
    app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    import.meta.env.MAIN_VITE_LAUNCHER_SUBDOMAIN
      ? `https://release-v${app.getVersion().replaceAll(".", "-")}.${import.meta.env.MAIN_VITE_LAUNCHER_SUBDOMAIN}`
      : undefined,
  ];
  return {
    // Every window with the preload loads this document (loadWindowURL).
    documents: [
      pathToFileURL(path.join(__dirname, "../renderer/index.html")).href,
    ],
    origins: candidates.flatMap((candidate) => {
      try {
        return candidate ? [new URL(candidate).origin] : [];
      } catch {
        return [];
      }
    }),
  };
};

/**
 * Keeps every window that shows an app page on that page. A blocked web link
 * opens in the browser instead, which is what a click on it means.
 */
export const installNavigationGuard = (): void => {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, target) => {
      if (!shouldBlockNavigation(contents.getURL(), target, trustedPages()))
        return;

      event.preventDefault();
      logger.warn("Blocked navigation of an app window", { target });
      const external = parseExternalUrl(target);
      if (external) void shell.openExternal(external);
    });

    // A child window inherits the preload. An app page never needs one; a
    // window that sets its own handler afterwards replaces this default.
    contents.setWindowOpenHandler(({ url }) => {
      if (!isAppUrl(contents.getURL(), trustedPages())) {
        return { action: "allow" };
      }
      const external = parseExternalUrl(url);
      if (external) void shell.openExternal(external);
      return { action: "deny" };
    });
  });
};

/** IPC calls are served only to the top frame of an app page. */
export const assertAppSender = (event: IpcMainInvokeEvent): void => {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isAppUrl(frame.url, trustedPages())) {
    throw new Error("Unauthorized IPC sender");
  }
};
