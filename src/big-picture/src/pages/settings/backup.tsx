import "./backup.scss";

import { DEFAULT_BACKUPS_TO_KEEP } from "@shared";
import type { BackupBackend } from "@types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FloppyDiskIcon,
  FolderOpenIcon,
  PlugIcon,
} from "@phosphor-icons/react";

import {
  Button,
  Checkbox,
  DropdownSelect,
  FileExplorerModal,
  Input,
  VerticalFocusGroup,
} from "../../components";
import { useBigPictureToast, useUserPreferences } from "../../hooks";
import type { FocusOverrides } from "../../services";
import {
  BACKUP_AUTO_BACKUP_CHECKBOX_ID,
  BACKUP_BACKEND_SELECT_ID,
  BACKUP_BACKUPS_TO_KEEP_INPUT_ID,
  BACKUP_LOCAL_PATH_BUTTON_ID,
  BACKUP_RCLONE_REMOTE_INPUT_ID,
  BACKUP_SAVE_BUTTON_ID,
  BACKUP_SECTION_REGION_ID,
  BACKUP_TEST_BUTTON_ID,
  SETTINGS_HEADER_RETURN_TARGET,
} from "./settings-navigation";
import { SettingsSection } from "./settings-section";

interface SettingsSectionProps {
  className?: string;
}

interface BackupForm {
  backupBackend: BackupBackend;
  backupLocalPath: string;
  rcloneRemote: string;
  autoBackupNewGames: boolean;
  defaultBackupsToKeep: string;
}

const DEFAULT_FORM: BackupForm = {
  backupBackend: "local",
  backupLocalPath: "",
  rcloneRemote: "",
  autoBackupNewGames: false,
  defaultBackupsToKeep: "",
};

export function BackupSettingsSection({
  className,
}: Readonly<SettingsSectionProps>) {
  const userPreferences = useUserPreferences();
  const { t } = useTranslation("settings");
  const { showSuccessToast, showErrorToast } = useBigPictureToast();

  const [form, setForm] = useState<BackupForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);

  const formRef = useRef(form);
  formRef.current = form;
  const lastLoadedRef = useRef<BackupForm>(DEFAULT_FORM);

  useEffect(() => {
    if (!userPreferences) return;

    const loaded: BackupForm = {
      backupBackend: userPreferences.backupBackend ?? "local",
      backupLocalPath: userPreferences.backupLocalPath ?? "",
      rcloneRemote: userPreferences.rcloneRemote ?? "",
      autoBackupNewGames: userPreferences.autoBackupNewGames ?? false,
      defaultBackupsToKeep:
        userPreferences.defaultBackupsToKeep?.toString() ?? "",
    };

    // Any preference update re-runs this effect: keep unsaved edits and only
    // re-sync while the form still matches what was last loaded.
    const isPristine = (
      Object.keys(lastLoadedRef.current) as (keyof BackupForm)[]
    ).every((key) => formRef.current[key] === lastLoadedRef.current[key]);

    lastLoadedRef.current = loaded;

    if (isPristine) setForm(loaded);
  }, [userPreferences]);

  const isLocalBackend = form.backupBackend === "local";
  const secondFocusId = isLocalBackend
    ? BACKUP_LOCAL_PATH_BUTTON_ID
    : BACKUP_RCLONE_REMOTE_INPUT_ID;

  const backendOverrides = useMemo<FocusOverrides>(
    () => ({
      up: SETTINGS_HEADER_RETURN_TARGET,
      down: { type: "item", itemId: secondFocusId },
    }),
    [secondFocusId]
  );

  const secondOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: BACKUP_BACKEND_SELECT_ID },
      down: { type: "item", itemId: BACKUP_AUTO_BACKUP_CHECKBOX_ID },
    }),
    []
  );

  const autoBackupOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: secondFocusId },
      down: { type: "item", itemId: BACKUP_BACKUPS_TO_KEEP_INPUT_ID },
    }),
    [secondFocusId]
  );

  const backupsToKeepOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: BACKUP_AUTO_BACKUP_CHECKBOX_ID },
      down: { type: "item", itemId: BACKUP_SAVE_BUTTON_ID },
    }),
    []
  );

  const saveOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: BACKUP_BACKUPS_TO_KEEP_INPUT_ID },
      right: { type: "item", itemId: BACKUP_TEST_BUTTON_ID },
      down: { type: "block" },
    }),
    []
  );

  const testOverrides = useMemo<FocusOverrides>(
    () => ({
      up: { type: "item", itemId: BACKUP_BACKUPS_TO_KEEP_INPUT_ID },
      left: { type: "item", itemId: BACKUP_SAVE_BUTTON_ID },
      down: { type: "block" },
    }),
    []
  );

  const handleSelectLocalPath = useCallback((path: string) => {
    setPathPickerOpen(false);
    setForm((currentForm) => ({ ...currentForm, backupLocalPath: path }));
  }, []);

  const handleSave = useCallback(async () => {
    const rawBackupsToKeep = form.defaultBackupsToKeep.trim();
    const backupsToKeep =
      rawBackupsToKeep === "" ? undefined : Number(rawBackupsToKeep);

    if (
      backupsToKeep !== undefined &&
      (!Number.isInteger(backupsToKeep) || backupsToKeep < 1)
    ) {
      showErrorToast(t("default_backups_to_keep_invalid"));
      return;
    }

    setSaving(true);

    try {
      await globalThis.window.electron.updateUserPreferences({
        backupBackend: form.backupBackend,
        backupLocalPath: form.backupLocalPath || null,
        rcloneRemote: form.rcloneRemote || null,
        autoBackupNewGames: form.autoBackupNewGames,
        defaultBackupsToKeep: backupsToKeep,
      });
      showSuccessToast(t("changes_saved"));
    } catch {
      showErrorToast(t("backup_save_failed"));
    } finally {
      setSaving(false);
    }
  }, [form, showErrorToast, showSuccessToast, t]);

  const handleTestConnection = useCallback(async () => {
    setTesting(true);

    try {
      const result = await globalThis.window.electron.testBackupBackend(
        form.backupBackend,
        {
          localPath: form.backupLocalPath || null,
          rcloneRemote: form.rcloneRemote || null,
        }
      );

      if (result.ok) {
        showSuccessToast(t("backup_test_ok"), {
          message: result.detail,
          fallbackVisual: "settings",
        });
      } else {
        showErrorToast(t("backup_test_failed"), {
          message: result.detail,
          fallbackVisual: "settings",
        });
      }
    } catch {
      showErrorToast(t("backup_test_failed"), { fallbackVisual: "settings" });
    } finally {
      setTesting(false);
    }
  }, [
    form.backupBackend,
    form.backupLocalPath,
    form.rcloneRemote,
    showErrorToast,
    showSuccessToast,
    t,
  ]);

  return (
    <div
      className={
        className
          ? `backup-settings-section ${className}`
          : "backup-settings-section"
      }
    >
      <SettingsSection
        title={t("backup_backend")}
        description={t("backup_backend_description")}
      >
        <VerticalFocusGroup regionId={BACKUP_SECTION_REGION_ID} asChild>
          <div className="backup-settings-section__content">
            <DropdownSelect<BackupBackend>
              label={t("backup_backend")}
              ariaLabel={t("backup_backend")}
              value={form.backupBackend}
              focusId={BACKUP_BACKEND_SELECT_ID}
              focusNavigationOverrides={backendOverrides}
              options={[
                { value: "local", label: t("backup_backend_local") },
                { value: "rclone", label: t("backup_backend_rclone") },
              ]}
              onValueChange={(value) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  backupBackend: value,
                }))
              }
            />

            {isLocalBackend ? (
              <div className="backup-settings-section__field">
                <Input
                  className="backup-settings-section__path-input"
                  label={t("backup_local_path")}
                  placeholder={t("backup_local_path_placeholder")}
                  value={form.backupLocalPath}
                  readOnly
                  focusNavigationState="disabled"
                />
                <Button
                  focusId={BACKUP_LOCAL_PATH_BUTTON_ID}
                  focusNavigationOverrides={secondOverrides}
                  variant="secondary"
                  icon={<FolderOpenIcon size={18} />}
                  onClick={() => setPathPickerOpen(true)}
                >
                  {t("change")}
                </Button>
                <p className="backup-settings-section__hint">
                  {t("backup_local_path_hint")}
                </p>
              </div>
            ) : (
              <div className="backup-settings-section__field">
                <Input
                  label={t("backup_rclone_remote")}
                  placeholder="myremote:games-saves"
                  value={form.rcloneRemote}
                  focusId={BACKUP_RCLONE_REMOTE_INPUT_ID}
                  focusNavigationOverrides={secondOverrides}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setForm((currentForm) => ({
                      ...currentForm,
                      rcloneRemote: event.target.value,
                    }))
                  }
                />
                <p className="backup-settings-section__hint">
                  {t("backup_rclone_remote_hint")}
                </p>
              </div>
            )}

            <Checkbox
              id="backup-auto-backup-new-games"
              label={t("auto_backup_new_games")}
              secondaryText={t("auto_backup_new_games_description")}
              checked={form.autoBackupNewGames}
              focusId={BACKUP_AUTO_BACKUP_CHECKBOX_ID}
              navigationOverrides={autoBackupOverrides}
              block
              onChange={(checked) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  autoBackupNewGames: checked,
                }))
              }
            />

            <div className="backup-settings-section__field">
              <Input
                type="number"
                min={1}
                step={1}
                label={t("default_backups_to_keep")}
                placeholder={String(DEFAULT_BACKUPS_TO_KEEP)}
                value={form.defaultBackupsToKeep}
                focusId={BACKUP_BACKUPS_TO_KEEP_INPUT_ID}
                focusNavigationOverrides={backupsToKeepOverrides}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    defaultBackupsToKeep: event.target.value,
                  }))
                }
              />
              <p className="backup-settings-section__hint">
                {t("default_backups_to_keep_description", {
                  count: DEFAULT_BACKUPS_TO_KEEP,
                })}
              </p>
            </div>

            <div className="backup-settings-section__actions">
              <Button
                focusId={BACKUP_SAVE_BUTTON_ID}
                focusNavigationOverrides={saveOverrides}
                variant="primary"
                icon={<FloppyDiskIcon size={18} />}
                loading={saving}
                disabled={saving}
                onClick={() => {
                  void handleSave();
                }}
              >
                {t("save_changes")}
              </Button>
              <Button
                focusId={BACKUP_TEST_BUTTON_ID}
                focusNavigationOverrides={testOverrides}
                variant="secondary"
                icon={<PlugIcon size={18} />}
                loading={testing}
                disabled={testing}
                onClick={() => {
                  void handleTestConnection();
                }}
              >
                {t("backup_test_connection")}
              </Button>
            </div>
          </div>
        </VerticalFocusGroup>
      </SettingsSection>

      <FileExplorerModal
        visible={pathPickerOpen}
        onClose={() => setPathPickerOpen(false)}
        onSelect={handleSelectLocalPath}
        title={t("backup_local_path")}
        initialPath={form.backupLocalPath || undefined}
        selectDirectory
      />
    </div>
  );
}
