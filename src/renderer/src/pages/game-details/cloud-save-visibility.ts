import type { GameShop } from "@types";
// Relative import with extension: this module is exercised by the node test
// runner, which resolves neither the @shared alias nor extensionless ESM.
// @ts-ignore The Node ESM test runner requires the source extension.
import { ACCOUNTLESS } from "../../../../shared/accountless.ts";

export type CloudSaveUiMode = "legacy" | "v2";
export type LegacyCloudSavePurpose = "active" | "archive";

export interface CloudSaveSettingsVisibility {
  showV2: boolean;
  showLegacy: boolean;
  legacyPurpose: LegacyCloudSavePurpose;
}

export interface CloudSaveVisibility {
  hero: CloudSaveUiMode | null;
  settings: CloudSaveSettingsVisibility;
}

export const isLegacyCloudSaveSettingsAvailable = (
  settings: CloudSaveSettingsVisibility,
  hasActiveSubscription: boolean,
  artifactCount: number
): boolean =>
  settings.showLegacy &&
  (settings.legacyPurpose === "active" ||
    (hasActiveSubscription && artifactCount > 0));

export const getCloudSaveVisibility = (shop: GameShop): CloudSaveVisibility => {
  // Accountless fork: the v2 native cloud save needs an account plus
  // subscription, while the legacy pipeline IS the local backup system —
  // it stays the active save UI for every shop.
  if (ACCOUNTLESS) {
    return {
      hero: shop === "custom" ? null : "legacy",
      settings: {
        showV2: false,
        showLegacy: true,
        legacyPurpose: "active",
      },
    };
  }

  if (shop === "steam") {
    return {
      hero: "v2",
      settings: {
        showV2: true,
        showLegacy: true,
        legacyPurpose: "archive",
      },
    };
  }

  if (shop === "launchbox") {
    return {
      hero: "legacy",
      settings: {
        showV2: false,
        showLegacy: true,
        legacyPurpose: "active",
      },
    };
  }

  return {
    hero: null,
    settings: {
      showV2: false,
      showLegacy: true,
      legacyPurpose: "active",
    },
  };
};
