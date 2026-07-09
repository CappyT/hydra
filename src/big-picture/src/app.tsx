import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
import {
  BIG_PICTURE_APP_LAYER_ID,
  BIG_PICTURE_CONTENT_REGION_ID,
  BIG_PICTURE_SHELL_REGION_ID,
  getBigPictureContentEntryRegionIdFromPathname,
  BIG_PICTURE_SIDEBAR_ITEM_IDS,
  getBigPictureGameRouteMatch,
  getBigPictureSidebarLibraryGameFocusId,
  getBigPictureSidebarItemIdFromPathname,
  Header,
  Sidebar,
} from "./layout";
import { IS_DESKTOP } from "./constants";
import { useBigPictureToast, useNavigation, useUserPreferences } from "./hooks";
import {
  HorizontalFocusGroup,
  InputModeProvider,
  NavigationHistoryBridge,
  NavigationLayer,
  NavigationAutoScrollBridge,
  NavigationInputProvider,
  NavigationStateBridge,
  NavigationDiagnostics,
  VerticalFocusGroup,
  BigPictureToastHost,
  VirtualKeyboardProvider,
} from "./components";
import { getItemFocusTarget } from "./helpers";
import {
  initializeBigPictureRunningGamesStore,
  useInputModeStore,
} from "./stores";
import { NavigationAudioService, type FocusOverrides } from "./services";
import { BigPictureI18nBridge, ensureBigPictureI18nResources } from "./i18n";

import "./styles/globals.scss";

export default function App() {
  ensureBigPictureI18nResources();

  const { pathname } = useLocation();
  const { t } = useTranslation("app");
  const { nodes, regions, setFocusRegion } = useNavigation();
  const { showWarningToast } = useBigPictureToast();
  const userPreferences = useUserPreferences();
  const inputMode = useInputModeStore((state) => state.mode);
  const [pendingRouteFocusPathname, setPendingRouteFocusPathname] = useState<
    string | null
  >(pathname);
  const activeSidebarItemId = getBigPictureSidebarItemIdFromPathname(pathname);
  const activeGameRoute = getBigPictureGameRouteMatch(pathname);
  const leftSidebarTargetId = activeGameRoute
    ? getBigPictureSidebarLibraryGameFocusId(activeGameRoute)
    : (activeSidebarItemId ?? BIG_PICTURE_SIDEBAR_ITEM_IDS.library);
  const contentNavigationOverrides: FocusOverrides = {
    left: getItemFocusTarget(leftSidebarTargetId),
  };

  useEffect(() => {
    if (!IS_DESKTOP) {
      document.documentElement.style.colorScheme = "dark";
      return;
    }

    initializeBigPictureRunningGamesStore();
  }, []);

  useEffect(() => {
    setPendingRouteFocusPathname(pathname);
  }, [pathname]);

  useEffect(() => {
    if (pendingRouteFocusPathname !== pathname) return;

    const entryRegionId =
      getBigPictureContentEntryRegionIdFromPathname(pathname);
    if (!entryRegionId) return;

    const hasRegion = regions.some((region) => region.id === entryRegionId);
    if (!hasRegion) return;

    const focusedId = setFocusRegion(entryRegionId, "right", {
      preferRememberedFocus: false,
    });

    if (focusedId) {
      setPendingRouteFocusPathname(null);
    }
  }, [
    leftSidebarTargetId,
    nodes,
    pathname,
    pendingRouteFocusPathname,
    regions,
    setFocusRegion,
  ]);

  useEffect(() => {
    NavigationAudioService.getInstance().setEnabled(
      (userPreferences?.bigPictureSoundsEnabled ?? true) &&
        inputMode === "gamepad"
    );
  }, [userPreferences?.bigPictureSoundsEnabled, inputMode]);

  // Startup dependency check: warn once about any missing optional host tools
  // (bwrap / pasta / gamescope) so a BP-only device (Steam Deck) is informed.
  useEffect(() => {
    if (!IS_DESKTOP) return;
    if (globalThis.window.electron.platform !== "linux") return;

    globalThis.window.electron
      .getMissingHostTools()
      .then((missing) => {
        if (!missing.length) return;

        const message = missing
          .map((tool) => t(`host_tool_missing_${tool}`))
          .join(" ");

        showWarningToast(t("host_tools_missing_title"), {
          message,
          duration: 10000,
          fallbackVisual: "settings",
        });
      })
      .catch(() => {
        // Best-effort only: a failed probe must never disrupt startup.
      });
  }, [t, showWarningToast]);

  // Non-blocking cloud-save conflict notice. "kept-both": local was backed up
  // and the newer remote loaded. "kept-local": the local backup failed, so the
  // remote was NOT loaded and local saves were kept intact.
  useEffect(() => {
    if (!IS_DESKTOP) return;

    const unsubscribe = globalThis.window.electron.onCloudSyncConflict(
      (payload) => {
        const messageKey =
          payload.resolution === "kept-local"
            ? "cloud_sync_conflict_kept_local_message"
            : "cloud_sync_conflict_message";

        showWarningToast(t("cloud_sync_conflict_title"), {
          message: t(messageKey, { hostname: payload.hostname }),
          duration: 10000,
          fallbackVisual: "settings",
        });
      }
    );

    return () => unsubscribe();
  }, [t, showWarningToast]);

  return (
    <Fragment>
      <NavigationStateBridge />
      <NavigationAutoScrollBridge />
      <NavigationHistoryBridge />

      <NavigationInputProvider>
        <div id="big-picture">
          <BigPictureI18nBridge />

          <NavigationLayer
            layerId={BIG_PICTURE_APP_LAYER_ID}
            rootRegionId={BIG_PICTURE_SHELL_REGION_ID}
            initialFocusRegionId={BIG_PICTURE_CONTENT_REGION_ID}
          >
            <HorizontalFocusGroup
              regionId={BIG_PICTURE_SHELL_REGION_ID}
              autoScrollMode="auto"
              asChild
            >
              <div className="big-picture__app">
                <Sidebar />

                <VerticalFocusGroup
                  regionId={BIG_PICTURE_CONTENT_REGION_ID}
                  navigationOverrides={contentNavigationOverrides}
                  autoScrollMode="auto"
                  asChild
                >
                  <div className="big-picture__layout">
                    <Header />

                    <article className="big-picture__content">
                      <Outlet />
                    </article>

                    <VirtualKeyboardProvider />
                  </div>
                </VerticalFocusGroup>
              </div>
            </HorizontalFocusGroup>
          </NavigationLayer>

          <InputModeProvider />
          <NavigationDiagnostics />
          <BigPictureToastHost />
        </div>
      </NavigationInputProvider>
    </Fragment>
  );
}
