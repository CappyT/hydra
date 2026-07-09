import type { LibraryGame } from "@types";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SidebarModal, type SidebarModalTab } from "../../../common";
import { resolvePreferredGameAssets } from "../../../../helpers";

import "./styles.scss";
import {
  GameCustomizationSettingsTab,
  type GameCustomizationSettingsProps,
  GAME_CUSTOMIZATION_SETTINGS_PRIMARY_CONTROL_ID,
} from "./customization-tab";
import {
  GameLaunchSettingsTab,
  type GameLaunchSettingsProps,
  GAME_LAUNCH_SETTINGS_PRIMARY_CONTROL_ID,
} from "./launch-tab";
import {
  GameCloudSettingsTab,
  type GameCloudSettingsProps,
  GAME_CLOUD_SETTINGS_PRIMARY_CONTROL_ID,
} from "./cloud-tab";
import {
  GameDownloadsSettingsTab,
  GAME_DOWNLOADS_SETTINGS_PRIMARY_CONTROL_ID,
} from "./downloads-tab";
import {
  GameDangerZoneSettingsTab,
  GAME_DANGER_ZONE_PRIMARY_CONTROL_ID,
} from "./danger-zone-tab";
import {
  GameCompatibilitySettingsTab,
  GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID,
} from "./compatibility-tab";
import {
  GameCollectionsSettingsTab,
  GAME_COLLECTIONS_SETTINGS_PRIMARY_CONTROL_ID,
} from "./collections-tab";

type GameSettingsTabId =
  | "launch"
  | "customization"
  | "hydra_cloud"
  | "compatibility"
  | "collections"
  | "downloads"
  | "danger_zone";

const GAME_SETTINGS_TAB_FOCUS_IDS: Record<GameSettingsTabId, string> = {
  launch: GAME_LAUNCH_SETTINGS_PRIMARY_CONTROL_ID,
  customization: GAME_CUSTOMIZATION_SETTINGS_PRIMARY_CONTROL_ID,
  hydra_cloud: GAME_CLOUD_SETTINGS_PRIMARY_CONTROL_ID,
  downloads: GAME_DOWNLOADS_SETTINGS_PRIMARY_CONTROL_ID,
  danger_zone: GAME_DANGER_ZONE_PRIMARY_CONTROL_ID,
  compatibility: GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID,
  collections: GAME_COLLECTIONS_SETTINGS_PRIMARY_CONTROL_ID,
};

interface GameSettingsModalProps {
  visible: boolean;
  game: LibraryGame;
  launchSettings: GameLaunchSettingsProps;
  customizationSettings: GameCustomizationSettingsProps;
  cloudSettings: GameCloudSettingsProps;
  onClose: () => void;
}

export function GameSettingsModal({
  visible,
  game,
  launchSettings,
  customizationSettings,
  cloudSettings,
  onClose,
}: Readonly<GameSettingsModalProps>) {
  const { t } = useTranslation(["game_details", "header"]);
  const [activeTabId, setActiveTabId] = useState<GameSettingsTabId>("launch");
  const preferredAssets = useMemo(
    () => resolvePreferredGameAssets(game, null),
    [game]
  );
  const isDev = import.meta.env.DEV;
  const shouldShowCompatibilityTab =
    globalThis.window.electron.platform === "linux" || isDev;
  const settingsLabel = t("settings", { ns: "header" });

  useEffect(() => {
    if (visible) {
      setActiveTabId("launch");
    }
  }, []);

  const launchContent = useMemo(
    () => <GameLaunchSettingsTab {...launchSettings} />,
    [launchSettings]
  );
  const customizationContent = useMemo(
    () => <GameCustomizationSettingsTab {...customizationSettings} />,
    [customizationSettings]
  );
  const cloudContent = useMemo(
    () => <GameCloudSettingsTab {...cloudSettings} />,
    [cloudSettings]
  );
  const downloadContent = useMemo(
    () => <GameDownloadsSettingsTab game={game} />,
    [game]
  );
  const dangerContent = useMemo(
    () => <GameDangerZoneSettingsTab game={game} onClose={onClose} />,
    [game, onClose]
  );
  const compatibilityContent = useMemo(
    () => <GameCompatibilitySettingsTab game={game} />,
    [game]
  );
  const collectionsContent = useMemo(
    () => <GameCollectionsSettingsTab game={game} />,
    [game]
  );

  const shouldShowCloudTab = game.shop !== "custom";
  const shouldShowCollectionsTab = game.shop !== "custom";

  useEffect(() => {
    if (!shouldShowCollectionsTab && activeTabId === "collections") {
      setActiveTabId("launch");
    }
  }, [shouldShowCollectionsTab, activeTabId]);

  useEffect(() => {
    if (!shouldShowCloudTab && activeTabId === "hydra_cloud") {
      setActiveTabId("launch");
    }
  }, [shouldShowCloudTab, activeTabId]);

  const tabs = useMemo<SidebarModalTab<GameSettingsTabId>[]>(
    () => [
      {
        id: "launch",
        label: t("settings_category_launch"),
        content: launchContent,
      },
      {
        id: "customization",
        label: t("settings_category_customization"),
        content: customizationContent,
      },
      ...(shouldShowCloudTab
        ? [
            {
              id: "hydra_cloud",
              label: t("settings_category_hydra_cloud"),
              content: cloudContent,
            } satisfies SidebarModalTab<GameSettingsTabId>,
          ]
        : []),
      ...(shouldShowCompatibilityTab
        ? [
            {
              id: "compatibility",
              label: t("settings_category_compatibility"),
              content: compatibilityContent,
            } satisfies SidebarModalTab<GameSettingsTabId>,
          ]
        : []),
      ...(shouldShowCollectionsTab
        ? [
            {
              id: "collections",
              label: t("collections", { ns: "sidebar" }),
              content: collectionsContent,
            } satisfies SidebarModalTab<GameSettingsTabId>,
          ]
        : []),
      {
        id: "downloads",
        label: t("settings_category_downloads"),
        content: downloadContent,
      },
      {
        id: "danger_zone",
        label: t("settings_category_danger_zone"),
        content: dangerContent,
      },
    ],
    [
      cloudContent,
      collectionsContent,
      compatibilityContent,
      customizationContent,
      dangerContent,
      downloadContent,
      launchContent,
      shouldShowCloudTab,
      shouldShowCollectionsTab,
      shouldShowCompatibilityTab,
      t,
    ]
  );

  return (
    <SidebarModal
      visible={visible}
      onClose={onClose}
      title={settingsLabel}
      coverImage={preferredAssets.heroSrc || undefined}
      className="game-settings-modal"
      ariaLabel={settingsLabel}
      contentEntryFocusId={GAME_SETTINGS_TAB_FOCUS_IDS[activeTabId]}
      tabs={tabs}
      activeTabId={activeTabId}
      onActiveTabChange={setActiveTabId}
    />
  );
}
