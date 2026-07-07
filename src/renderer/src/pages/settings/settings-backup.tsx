import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  CheckboxField,
  SelectField,
  TextField,
} from "@renderer/components";
import { useAppSelector, useToast } from "@renderer/hooks";
import { settingsContext } from "@renderer/context";
import type { BackupBackend } from "@types";

export function SettingsBackup() {
  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const { updateUserPreferences } = useContext(settingsContext);

  const { showSuccessToast, showErrorToast } = useToast();
  const { t } = useTranslation("settings");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    backupBackend: "local" as BackupBackend,
    backupLocalPath: "" as string,
    rcloneRemote: "" as string,
    autoBackupNewGames: false,
  });

  useEffect(() => {
    if (userPreferences) {
      setForm({
        backupBackend: userPreferences.backupBackend ?? "local",
        backupLocalPath: userPreferences.backupLocalPath ?? "",
        rcloneRemote: userPreferences.rcloneRemote ?? "",
        autoBackupNewGames: userPreferences.autoBackupNewGames ?? false,
      });
    }
  }, [userPreferences]);

  const handleChooseLocalPath = async () => {
    const { filePaths } = await window.electron.showOpenDialog({
      defaultPath: form.backupLocalPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });

    const selectedPath = filePaths?.[0];
    if (!selectedPath) return;

    setForm((prev) => ({ ...prev, backupLocalPath: selectedPath }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateUserPreferences({
        backupBackend: form.backupBackend,
        backupLocalPath: form.backupLocalPath || null,
        rcloneRemote: form.rcloneRemote || null,
        autoBackupNewGames: form.autoBackupNewGames,
      });
      showSuccessToast(t("changes_saved"));
    } catch (_err) {
      showErrorToast(t("backup_save_failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const result = await window.electron.testBackupBackend(
        form.backupBackend,
        {
          localPath: form.backupLocalPath || null,
          rcloneRemote: form.rcloneRemote || null,
        }
      );

      if (result.ok) {
        showSuccessToast(t("backup_test_ok"), result.detail);
      } else {
        showErrorToast(t("backup_test_failed"), result.detail);
      }
    } catch (_err) {
      showErrorToast(t("backup_test_failed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-context-panel">
      <div className="settings-context-panel__group">
        <h3>{t("backup_backend")}</h3>
        <p>{t("backup_backend_description")}</p>

        <SelectField
          label={t("backup_backend")}
          value={form.backupBackend}
          onChange={(event) =>
            setForm((prev) => ({
              ...prev,
              backupBackend: event.target.value as BackupBackend,
            }))
          }
          options={[
            { key: "local", value: "local", label: t("backup_backend_local") },
            {
              key: "rclone",
              value: "rclone",
              label: t("backup_backend_rclone"),
            },
          ]}
        />

        {form.backupBackend === "local" && (
          <TextField
            label={t("backup_local_path")}
            value={form.backupLocalPath}
            placeholder={t("backup_local_path_placeholder")}
            readOnly
            rightContent={
              <Button theme="outline" onClick={handleChooseLocalPath}>
                {t("change")}
              </Button>
            }
            hint={t("backup_local_path_hint")}
          />
        )}

        {form.backupBackend === "rclone" && (
          <TextField
            label={t("backup_rclone_remote")}
            value={form.rcloneRemote}
            placeholder="myremote:games-saves"
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                rcloneRemote: event.target.value,
              }))
            }
            hint={t("backup_rclone_remote_hint")}
          />
        )}

        <CheckboxField
          label={t("auto_backup_new_games")}
          checked={form.autoBackupNewGames}
          onChange={() =>
            setForm((prev) => ({
              ...prev,
              autoBackupNewGames: !prev.autoBackupNewGames,
            }))
          }
        />
        <p>{t("auto_backup_new_games_description")}</p>

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Button onClick={handleSave} disabled={saving}>
            {t("save_changes")}
          </Button>
          <Button
            theme="outline"
            onClick={handleTestConnection}
            disabled={testing}
          >
            {t("backup_test_connection")}
          </Button>
        </div>
      </div>
    </div>
  );
}
