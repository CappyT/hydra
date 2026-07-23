import "./steamgriddb-section.scss";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { EyeClosedIcon, EyeIcon } from "@phosphor-icons/react/dist/ssr";

import {
  Button,
  HorizontalFocusGroup,
  Input,
  VerticalFocusGroup,
} from "../../components";
import { useBigPictureToast, useUserPreferences } from "../../hooks";
import type { FocusOverrideTarget, FocusOverrides } from "../../services";
import {
  STEAMGRIDDB_API_KEY_INPUT_ID,
  STEAMGRIDDB_REMOVE_BUTTON_ID,
  STEAMGRIDDB_SAVE_BUTTON_ID,
  STEAMGRIDDB_SECTION_REGION_ID,
} from "./settings-navigation";
import { SettingsSection } from "./settings-section";

const SETTINGS_TOAST_OPTIONS = {
  fallbackVisual: "settings" as const,
};

interface SteamGridDbSectionProps {
  upTarget: FocusOverrideTarget;
}

/**
 * Accountless fork: Big Picture counterpart of the desktop SteamGridDB settings
 * section. Lets the user store a SteamGridDB API key (validated against the
 * SteamGridDB Web API) so the artwork picker can browse it directly.
 */
export function SteamGridDbSection({
  upTarget,
}: Readonly<SteamGridDbSectionProps>) {
  const { t } = useTranslation("settings");
  const { showSuccessToast, showErrorToast } = useBigPictureToast();
  const userPreferences = useUserPreferences();

  const [apiKey, setApiKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isKeyVisible, setIsKeyVisible] = useState(false);

  const hasStoredKey = Boolean(userPreferences?.steamGridDbApiKey);

  useEffect(() => {
    const storedKey = userPreferences?.steamGridDbApiKey;
    if (storedKey) setApiKey((current) => current || storedKey);
  }, [userPreferences?.steamGridDbApiKey]);

  const handleSave = useCallback(async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    setIsSubmitting(true);

    try {
      const result =
        await globalThis.window.electron.validateSteamGridDbApiKey(trimmedKey);

      if (!result.valid) {
        showErrorToast(t("steamgriddb_invalid_api_key"), {
          ...SETTINGS_TOAST_OPTIONS,
        });
        return;
      }

      await globalThis.window.electron
        .updateUserPreferences({ steamGridDbApiKey: trimmedKey })
        .catch(() => {});

      showSuccessToast(t("steamgriddb_key_saved"), {
        ...SETTINGS_TOAST_OPTIONS,
        celebration: "confetti",
      });
    } catch {
      showErrorToast(t("steamgriddb_invalid_api_key"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [apiKey, showErrorToast, showSuccessToast, t]);

  const handleRemove = useCallback(async () => {
    setIsSubmitting(true);

    try {
      await globalThis.window.electron
        .updateUserPreferences({ steamGridDbApiKey: null })
        .catch(() => {});

      setApiKey("");
      showSuccessToast(t("steamgriddb_key_removed"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [showSuccessToast, t]);

  const apiKeyOverrides = useMemo<FocusOverrides>(
    () => ({
      up: upTarget,
      down: { type: "item", itemId: STEAMGRIDDB_SAVE_BUTTON_ID },
    }),
    [upTarget]
  );

  const saveOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: STEAMGRIDDB_API_KEY_INPUT_ID },
      right: hasStoredKey
        ? { type: "item", itemId: STEAMGRIDDB_REMOVE_BUTTON_ID }
        : undefined,
      down: { type: "block" },
    }),
    [hasStoredKey]
  );

  const removeOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: STEAMGRIDDB_API_KEY_INPUT_ID },
      left: { type: "item", itemId: STEAMGRIDDB_SAVE_BUTTON_ID },
      down: { type: "block" },
    }),
    []
  );

  const isSaveDisabled = !apiKey.trim() || isSubmitting;

  return (
    <SettingsSection
      title={t("steamgriddb")}
      description={t("steamgriddb_description")}
      className="steamgriddb-section"
    >
      <VerticalFocusGroup regionId={STEAMGRIDDB_SECTION_REGION_ID} asChild>
        <div className="steamgriddb-section__content">
          {hasStoredKey ? (
            <span className="steamgriddb-section__status">
              <CheckCircleIcon size={16} weight="fill" />
              {t("steamgriddb_status_active")}
            </span>
          ) : null}

          <Input
            label={t("steamgriddb_api_key")}
            placeholder={t("steamgriddb_api_key")}
            type={isKeyVisible ? "text" : "password"}
            value={apiKey}
            focusId={STEAMGRIDDB_API_KEY_INPUT_ID}
            focusNavigationOverrides={apiKeyOverrides}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
            iconRight={
              <button
                type="button"
                className="steamgriddb-section__visibility-toggle"
                aria-label={isKeyVisible ? "Hide API Key" : "Show API Key"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setIsKeyVisible((current) => !current)}
              >
                {isKeyVisible ? (
                  <EyeClosedIcon size={20} />
                ) : (
                  <EyeIcon size={20} />
                )}
              </button>
            }
          />

          <HorizontalFocusGroup
            className="steamgriddb-section__actions"
            asChild
          >
            <div>
              <Button
                focusId={STEAMGRIDDB_SAVE_BUTTON_ID}
                focusNavigationOverrides={saveOverrides}
                variant="primary"
                loading={isSubmitting}
                disabled={isSaveDisabled}
                onClick={() => {
                  void handleSave();
                }}
              >
                {t("steamgriddb_save")}
              </Button>

              {hasStoredKey ? (
                <Button
                  focusId={STEAMGRIDDB_REMOVE_BUTTON_ID}
                  focusNavigationOverrides={removeOverrides}
                  variant="danger"
                  disabled={isSubmitting}
                  onClick={() => {
                    void handleRemove();
                  }}
                >
                  {t("steamgriddb_remove")}
                </Button>
              ) : null}
            </div>
          </HorizontalFocusGroup>
        </div>
      </VerticalFocusGroup>
    </SettingsSection>
  );
}
