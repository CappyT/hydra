import { useContext, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button, Link, TextField } from "@renderer/components";
import { useAppSelector, useToast } from "@renderer/hooks";
import { settingsContext } from "@renderer/context";
import { CheckCircleFillIcon, ChevronRightIcon } from "@primer/octicons-react";

import "./settings-debrid.scss";
import "./settings-steamgriddb.scss";

const STEAMGRIDDB_API_KEY_URL =
  "https://www.steamgriddb.com/profile/preferences/api";

const CHEVRON_ICON_SIZE = 16;

/**
 * Accountless fork: lets the user provide a SteamGridDB API key so the game
 * artwork picker can browse SteamGridDB directly (the Hydra artwork proxy needs
 * a logged-in account). Mirrors the RetroAchievements section but simpler: a
 * single key field that is validated against the SteamGridDB Web API before
 * being persisted to global preferences.
 */
export function SettingsSteamGridDb() {
  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const { updateUserPreferences } = useContext(settingsContext);

  const { showSuccessToast, showErrorToast } = useToast();
  const { t } = useTranslation("settings");

  const storedKey = userPreferences?.steamGridDbApiKey ?? "";
  const hasStoredKey = Boolean(storedKey);

  const [apiKey, setApiKey] = useState(storedKey);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => !storedKey);

  useEffect(() => {
    if (storedKey) setApiKey((prev) => prev || storedKey);
  }, [storedKey]);

  const handleSave: React.FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    setIsSubmitting(true);

    try {
      const result =
        await globalThis.window.electron.validateSteamGridDbApiKey(trimmedKey);

      if (!result.valid) {
        showErrorToast(t("steamgriddb_invalid_api_key"));
        return;
      }

      await updateUserPreferences({ steamGridDbApiKey: trimmedKey }).catch(
        () => {}
      );
      showSuccessToast(t("steamgriddb_key_saved"));
    } catch {
      showErrorToast(t("steamgriddb_invalid_api_key"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async () => {
    setIsSubmitting(true);

    try {
      await updateUserPreferences({ steamGridDbApiKey: null }).catch(() => {});
      setApiKey("");
      showSuccessToast(t("steamgriddb_key_removed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={`settings-debrid__section ${
        isCollapsed ? "" : "settings-debrid__section--expanded"
      }`}
    >
      <div className="settings-debrid__section-header">
        <button
          type="button"
          className="settings-debrid__collapse-button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          aria-label={
            isCollapsed
              ? t("expand_debrid_section", { provider: t("steamgriddb") })
              : t("collapse_debrid_section", { provider: t("steamgriddb") })
          }
        >
          <span
            className={`settings-debrid__collapse-icon ${
              isCollapsed ? "" : "settings-debrid__collapse-icon--expanded"
            }`}
          >
            <ChevronRightIcon size={CHEVRON_ICON_SIZE} />
          </span>
        </button>
        <h3 className="settings-debrid__section-title">{t("steamgriddb")}</h3>
        {hasStoredKey && (
          <CheckCircleFillIcon
            size={CHEVRON_ICON_SIZE}
            className="settings-debrid__check-icon"
          />
        )}
      </div>

      {!isCollapsed && (
        <form className="settings-steamgriddb__form" onSubmit={handleSave}>
          <p className="settings-steamgriddb__description">
            {t("steamgriddb_description")}
          </p>

          <TextField
            label={t("steamgriddb_api_key")}
            value={apiKey}
            type="password"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("steamgriddb_api_key")}
            hint={
              <Trans i18nKey="steamgriddb_api_key_hint" ns="settings">
                <Link to={STEAMGRIDDB_API_KEY_URL} />
              </Trans>
            }
          />

          <div className="settings-steamgriddb__actions">
            {hasStoredKey && (
              <Button
                type="button"
                theme="outline"
                onClick={handleRemove}
                disabled={isSubmitting}
              >
                {t("steamgriddb_remove")}
              </Button>
            )}
            <Button type="submit" disabled={!apiKey.trim() || isSubmitting}>
              {t("steamgriddb_save")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
