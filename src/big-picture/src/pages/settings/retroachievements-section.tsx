import "./retroachievements-section.scss";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircleIcon,
  PlugsConnectedIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { EyeClosedIcon, EyeIcon } from "@phosphor-icons/react/dist/ssr";

import {
  Button,
  Checkbox,
  HorizontalFocusGroup,
  Input,
  Modal,
  VerticalFocusGroup,
} from "../../components";
import { useBigPictureToast, useUserPreferences } from "../../hooks";
import { useNavigation } from "../../hooks";
import type { FocusOverrideTarget, FocusOverrides } from "../../services";
import {
  RETROACHIEVEMENTS_CONNECT_BUTTON_ID,
  RETROACHIEVEMENTS_DISCONNECT_BUTTON_ID,
  RETROACHIEVEMENTS_SECTION_REGION_ID,
  RETROACHIEVEMENTS_UPDATE_BUTTON_ID,
  RETROACHIEVEMENTS_USERNAME_INPUT_ID,
  RETROACHIEVEMENTS_WEB_API_KEY_INPUT_ID,
} from "./settings-navigation";
import { SettingsSection } from "./settings-section";

const RETROACHIEVEMENTS_DISCONNECT_REGION_ID =
  "integrations-retroachievements-disconnect-region";
const RETROACHIEVEMENTS_DISCONNECT_ACTIONS_REGION_ID =
  "integrations-retroachievements-disconnect-actions";
const RETROACHIEVEMENTS_DISCONNECT_CONFIRM_ID =
  "integrations-retroachievements-disconnect-confirm";

const SETTINGS_TOAST_OPTIONS = {
  fallbackVisual: "settings" as const,
};

type Integration =
  | { connected: false }
  | { connected: true; username: string; status: "active" | "invalid" };

interface RetroAchievementsSectionProps {
  upTarget: FocusOverrideTarget;
}

export function RetroAchievementsSection({
  upTarget,
}: Readonly<RetroAchievementsSectionProps>) {
  const { t } = useTranslation("settings");
  const { showSuccessToast, showErrorToast } = useBigPictureToast();
  const { setFocus } = useNavigation();
  const userPreferences = useUserPreferences();

  const [integration, setIntegration] = useState<Integration>({
    connected: false,
  });
  const [form, setForm] = useState({ username: "", webApiKey: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [deleteAchievements, setDeleteAchievements] = useState(true);

  useEffect(() => {
    const storedKey = userPreferences?.retroAchievementsWebApiKey;
    const storedUsername = userPreferences?.retroAchievementsUsername;

    if (storedKey && storedUsername) {
      setIntegration((current) =>
        current.connected && current.username === storedUsername
          ? current
          : { connected: true, username: storedUsername, status: "active" }
      );
      setForm((current) => ({
        username: current.username || storedUsername,
        webApiKey: current.webApiKey || storedKey,
      }));
    } else {
      setIntegration({ connected: false });
    }
  }, [
    userPreferences?.retroAchievementsWebApiKey,
    userPreferences?.retroAchievementsUsername,
  ]);

  const handleConnect = useCallback(async () => {
    const username = form.username.trim();
    const webApiKey = form.webApiKey.trim();

    if (!username || !webApiKey) return;

    setIsSubmitting(true);

    try {
      const result =
        await globalThis.window.electron.validateRetroAchievementsWebApiKey(
          username,
          webApiKey
        );

      if (!result.valid) {
        showErrorToast(t("retroachievements_invalid_web_api_key"), {
          ...SETTINGS_TOAST_OPTIONS,
        });
        return;
      }

      await globalThis.window.electron
        .updateUserPreferences({
          retroAchievementsWebApiKey: webApiKey,
          retroAchievementsUsername: username,
        })
        .catch(() => {});

      setIntegration({ connected: true, username, status: "active" });
      showSuccessToast(t("retroachievements_account_linked"), {
        ...SETTINGS_TOAST_OPTIONS,
        celebration: "confetti",
      });
    } catch {
      showErrorToast(t("retroachievements_connect_error"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [form.username, form.webApiKey, showErrorToast, showSuccessToast, t]);

  const handleRefresh = useCallback(async () => {
    const username = userPreferences?.retroAchievementsUsername;
    const webApiKey = userPreferences?.retroAchievementsWebApiKey;

    if (!username || !webApiKey) return;

    setIsRefreshing(true);

    try {
      const result =
        await globalThis.window.electron.validateRetroAchievementsWebApiKey(
          username,
          webApiKey
        );

      setIntegration({
        connected: true,
        username,
        status: result.valid ? "active" : "invalid",
      });
      showSuccessToast(t("retroachievements_status_updated"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } catch {
      showErrorToast(t("retroachievements_connect_error"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [
    userPreferences?.retroAchievementsUsername,
    userPreferences?.retroAchievementsWebApiKey,
    showErrorToast,
    showSuccessToast,
    t,
  ]);

  const handleConfirmDisconnect = useCallback(async () => {
    setShowDisconnectModal(false);
    setIsSubmitting(true);

    try {
      if (deleteAchievements) {
        await globalThis.window.electron
          .resetRetroAchievementsAchievements()
          .catch(() => {});
      }

      await globalThis.window.electron
        .updateUserPreferences({
          retroAchievementsWebApiKey: null,
          retroAchievementsUsername: null,
        })
        .catch(() => {});

      setIntegration({ connected: false });
      setForm({ username: "", webApiKey: "" });
      showSuccessToast(t("retroachievements_account_unlinked"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } catch {
      showErrorToast(t("retroachievements_connect_error"), {
        ...SETTINGS_TOAST_OPTIONS,
      });
    } finally {
      setIsSubmitting(false);
      setDeleteAchievements(true);
    }
  }, [deleteAchievements, showErrorToast, showSuccessToast, t]);

  useEffect(() => {
    if (!showDisconnectModal) return;

    const frameId = globalThis.window.requestAnimationFrame(() => {
      setFocus(RETROACHIEVEMENTS_DISCONNECT_CONFIRM_ID);
    });

    return () => globalThis.window.cancelAnimationFrame(frameId);
  }, [setFocus, showDisconnectModal]);

  const usernameOverrides = useMemo<FocusOverrides>(
    () => ({
      up: upTarget,
      down: { type: "item", itemId: RETROACHIEVEMENTS_WEB_API_KEY_INPUT_ID },
    }),
    [upTarget]
  );

  const webApiKeyOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: RETROACHIEVEMENTS_USERNAME_INPUT_ID },
      down: { type: "item", itemId: RETROACHIEVEMENTS_CONNECT_BUTTON_ID },
    }),
    []
  );

  const connectOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: RETROACHIEVEMENTS_WEB_API_KEY_INPUT_ID },
      down: { type: "block" },
    }),
    []
  );

  const isConnected = integration.connected;
  const isInvalid = integration.connected && integration.status === "invalid";

  const updateOverrides = useMemo<FocusOverrides>(
    () => ({
      up: upTarget,
      right: { type: "item", itemId: RETROACHIEVEMENTS_DISCONNECT_BUTTON_ID },
      down: { type: "block" },
    }),
    [upTarget]
  );

  const disconnectOverrides = useMemo<FocusOverrides>(
    () => ({
      up: upTarget,
      left: isInvalid
        ? undefined
        : { type: "item", itemId: RETROACHIEVEMENTS_UPDATE_BUTTON_ID },
      down: { type: "block" },
    }),
    [isInvalid, upTarget]
  );

  const isConnectDisabled =
    !form.username.trim() || !form.webApiKey.trim() || isSubmitting;

  return (
    <SettingsSection
      title={t("retroachievements")}
      description={t("retroachievements_description")}
      className="retroachievements-section"
    >
      <VerticalFocusGroup
        regionId={RETROACHIEVEMENTS_SECTION_REGION_ID}
        asChild
      >
        <div className="retroachievements-section__content">
          {isConnected ? (
            <>
              <div className="retroachievements-section__profile">
                <span className="retroachievements-section__username">
                  {integration.username}
                </span>
                <span
                  className={`retroachievements-section__status${
                    isInvalid
                      ? " retroachievements-section__status--warning"
                      : ""
                  }`}
                >
                  {isInvalid ? (
                    <WarningIcon size={16} />
                  ) : (
                    <CheckCircleIcon size={16} weight="fill" />
                  )}
                  {isInvalid
                    ? t("retroachievements_status_invalid_credentials")
                    : t("retroachievements_status_active")}
                </span>
              </div>

              <HorizontalFocusGroup
                className="retroachievements-section__actions"
                asChild
              >
                <div>
                  {!isInvalid ? (
                    <Button
                      focusId={RETROACHIEVEMENTS_UPDATE_BUTTON_ID}
                      focusNavigationOverrides={updateOverrides}
                      variant="secondary"
                      loading={isRefreshing}
                      disabled={isRefreshing || isSubmitting}
                      onClick={() => {
                        void handleRefresh();
                      }}
                    >
                      {t("retroachievements_update")}
                    </Button>
                  ) : null}

                  <Button
                    focusId={RETROACHIEVEMENTS_DISCONNECT_BUTTON_ID}
                    focusNavigationOverrides={disconnectOverrides}
                    variant="danger"
                    disabled={isSubmitting || isRefreshing}
                    onClick={() => {
                      setDeleteAchievements(true);
                      setShowDisconnectModal(true);
                    }}
                  >
                    {t("retroachievements_disconnect")}
                  </Button>
                </div>
              </HorizontalFocusGroup>
            </>
          ) : (
            <>
              <Input
                label={t("retroachievements_username")}
                placeholder={t("retroachievements_username")}
                value={form.username}
                focusId={RETROACHIEVEMENTS_USERNAME_INPUT_ID}
                focusNavigationOverrides={usernameOverrides}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
              />

              <Input
                label={t("retroachievements_web_api_key")}
                placeholder={t("retroachievements_web_api_key")}
                type={isKeyVisible ? "text" : "password"}
                value={form.webApiKey}
                focusId={RETROACHIEVEMENTS_WEB_API_KEY_INPUT_ID}
                focusNavigationOverrides={webApiKeyOverrides}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    webApiKey: event.target.value,
                  }))
                }
                iconRight={
                  <button
                    type="button"
                    className="retroachievements-section__visibility-toggle"
                    aria-label={
                      isKeyVisible ? "Hide Web API Key" : "Show Web API Key"
                    }
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

              <Button
                focusId={RETROACHIEVEMENTS_CONNECT_BUTTON_ID}
                focusNavigationOverrides={connectOverrides}
                variant="primary"
                icon={<PlugsConnectedIcon size={18} />}
                loading={isSubmitting}
                disabled={isConnectDisabled}
                onClick={() => {
                  void handleConnect();
                }}
              >
                {t("retroachievements_connect")}
              </Button>
            </>
          )}
        </div>
      </VerticalFocusGroup>

      <Modal
        visible={showDisconnectModal}
        onClose={() => {
          setShowDisconnectModal(false);
          setDeleteAchievements(true);
        }}
        title={t("retroachievements_disconnect_title")}
        description={t("retroachievements_disconnect_description")}
        className="retroachievements-section__modal"
      >
        <VerticalFocusGroup regionId={RETROACHIEVEMENTS_DISCONNECT_REGION_ID}>
          <Checkbox
            id="retroachievements-delete-on-disconnect"
            label={t("retroachievements_delete_on_disconnect")}
            checked={deleteAchievements}
            block
            onChange={setDeleteAchievements}
          />

          <HorizontalFocusGroup
            regionId={RETROACHIEVEMENTS_DISCONNECT_ACTIONS_REGION_ID}
            className="retroachievements-section__modal-actions"
          >
            <Button
              variant="secondary"
              disabled={isSubmitting}
              onClick={() => {
                setShowDisconnectModal(false);
                setDeleteAchievements(true);
              }}
            >
              {t("cancel")}
            </Button>

            <Button
              focusId={RETROACHIEVEMENTS_DISCONNECT_CONFIRM_ID}
              variant="danger"
              disabled={isSubmitting}
              onClick={() => {
                void handleConfirmDisconnect();
              }}
            >
              {t("retroachievements_disconnect")}
            </Button>
          </HorizontalFocusGroup>
        </VerticalFocusGroup>
      </Modal>
    </SettingsSection>
  );
}
