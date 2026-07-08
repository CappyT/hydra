import { useTranslation } from "react-i18next";

import {
  Button,
  CheckboxField,
  Link,
  ProtonPathPicker,
  SelectField,
  TextField,
} from "@renderer/components";
import type { Game, LibraryGame, ProtonVersion } from "@types";
import { FileDirectoryIcon, LinkExternalIcon } from "@primer/octicons-react";
import { Tooltip } from "react-tooltip";

interface CompatibilitySettingsSectionProps {
  game: LibraryGame;
  displayedWinePrefixPath: string | null;
  protonVersions: ProtonVersion[];
  selectedProtonPath: string;
  autoRunGamemode: boolean;
  autoRunMangohud: boolean;
  useGamescope: boolean;
  globalAutoRunGamemode: boolean;
  globalAutoRunMangohud: boolean;
  gamemodeAvailable: boolean;
  mangohudAvailable: boolean;
  gamescopeAvailable: boolean;
  winetricksAvailable: boolean;
  sandboxAvailable: boolean;
  sandboxEnabled: boolean;
  sandboxShareIpc: boolean;
  networkIsolationAvailable: boolean;
  networkIsolationEnabled: boolean;
  seccompLevel: Game["seccompLevel"];
  seccompAudit: boolean;
  sandboxExtraPaths: string[];
  mangohudSiteUrl: string;
  gamemodeSiteUrl: string;
  onChangeWinePrefixPath: () => Promise<void>;
  onClearWinePrefixPath: () => Promise<void>;
  onOpenWinetricks: () => Promise<void>;
  onChangeGamemodeState: (value: boolean) => Promise<void>;
  onChangeMangohudState: (value: boolean) => Promise<void>;
  onChangeGamescopeState: (value: boolean) => Promise<void>;
  onChangeSandboxState: (value: boolean) => Promise<void>;
  onChangeSandboxShareIpc: (value: boolean) => Promise<void>;
  onChangeNetworkIsolation: (value: boolean) => Promise<void>;
  onChangeSeccompLevel: (
    value: "off" | "low" | "medium" | "high" | null
  ) => Promise<void>;
  onChangeSeccompAudit: (value: boolean) => Promise<void>;
  onAddSandboxPath: () => Promise<void>;
  onRemoveSandboxPath: (path: string) => Promise<void>;
  onChangeProtonVersion: (value: string) => void;
}

export function CompatibilitySettingsSection({
  game,
  displayedWinePrefixPath,
  protonVersions,
  selectedProtonPath,
  autoRunGamemode,
  autoRunMangohud,
  useGamescope,
  globalAutoRunGamemode,
  globalAutoRunMangohud,
  gamemodeAvailable,
  mangohudAvailable,
  gamescopeAvailable,
  winetricksAvailable,
  sandboxAvailable,
  sandboxEnabled,
  sandboxShareIpc,
  networkIsolationAvailable,
  networkIsolationEnabled,
  seccompLevel,
  seccompAudit,
  sandboxExtraPaths,
  mangohudSiteUrl,
  gamemodeSiteUrl,
  onChangeWinePrefixPath,
  onClearWinePrefixPath,
  onOpenWinetricks,
  onChangeGamemodeState,
  onChangeMangohudState,
  onChangeGamescopeState,
  onChangeSandboxState,
  onChangeSandboxShareIpc,
  onChangeNetworkIsolation,
  onChangeSeccompLevel,
  onChangeSeccompAudit,
  onAddSandboxPath,
  onRemoveSandboxPath,
  onChangeProtonVersion,
}: Readonly<CompatibilitySettingsSectionProps>) {
  const { t } = useTranslation("game_details");

  const showWinetricksUnavailableTooltip = !winetricksAvailable;
  const gamemodeToggleDisabled = !gamemodeAvailable || globalAutoRunGamemode;
  const mangohudToggleDisabled = !mangohudAvailable || globalAutoRunMangohud;

  const gamemodeTooltipId = !gamemodeAvailable
    ? "gamemode-unavailable-tooltip"
    : globalAutoRunGamemode
      ? "gamemode-global-enabled-tooltip"
      : undefined;

  const mangohudTooltipId = !mangohudAvailable
    ? "mangohud-unavailable-tooltip"
    : globalAutoRunMangohud
      ? "mangohud-global-enabled-tooltip"
      : undefined;

  const protonVersionAutoLabel = t("proton_version_auto", {
    ns: ["game_details", "settings"],
    defaultValue: "Auto (global default or umu default)",
  });

  const protonSourceUmuDefault = t("proton_source_umu_default", {
    ns: ["game_details", "settings"],
    defaultValue: "umu default selection",
  });

  const protonSourceSteam = t("proton_source_steam", {
    ns: ["game_details", "settings"],
    defaultValue: "Installed by Steam",
  });

  const protonSourceCompatibilityTools = t(
    "proton_source_compatibility_tools",
    {
      ns: ["game_details", "settings"],
      defaultValue: "Installed in Steam compatibilitytools.d",
    }
  );

  return (
    <>
      <div className="game-options-modal__wine-prefix">
        <div className="game-options-modal__header">
          <h2>{t("wine_prefix")}</h2>
          <h4 className="game-options-modal__header-description">
            {t("wine_prefix_description")}
          </h4>
        </div>

        <TextField
          value={displayedWinePrefixPath || ""}
          readOnly
          theme="dark"
          disabled
          placeholder={t("no_directory_selected")}
          rightContent={
            <>
              <Button
                type="button"
                theme="outline"
                onClick={onChangeWinePrefixPath}
              >
                <FileDirectoryIcon />
                {t("select_executable")}
              </Button>
              {game.winePrefixPath && (
                <Button onClick={onClearWinePrefixPath} theme="outline">
                  {t("clear")}
                </Button>
              )}
            </>
          }
        />

        <div className="game-options-modal__row">
          <span
            className="game-options-modal__tool-button-wrapper"
            data-tooltip-id="winetricks-unavailable-tooltip"
            data-tooltip-content={
              showWinetricksUnavailableTooltip
                ? t("winetricks_not_available_tooltip")
                : undefined
            }
          >
            <Button
              type="button"
              theme="outline"
              onClick={onOpenWinetricks}
              disabled={!winetricksAvailable}
            >
              {t("open_winetricks")}
            </Button>
          </span>

          {showWinetricksUnavailableTooltip && (
            <Tooltip id="winetricks-unavailable-tooltip" />
          )}
        </div>
      </div>

      <div className="game-options-modal__section">
        <div className="game-options-modal__header">
          <h2>{t("additional_options")}</h2>
        </div>

        <div className="game-options-modal__gamemode-toggle">
          <CheckboxField
            label={
              <span
                className={`game-options-modal__gamemode-label ${
                  gamemodeToggleDisabled
                    ? "game-options-modal__gamemode-label--disabled"
                    : ""
                }`}
                data-tooltip-id={gamemodeTooltipId}
                data-tooltip-content={
                  !gamemodeAvailable
                    ? t("gamemode_not_available_tooltip", {
                        defaultValue: "GameMode is not available in your PATH",
                      })
                    : globalAutoRunGamemode
                      ? t("gamemode_disabled_due_to_global_setting_tooltip", {
                          defaultValue:
                            "This option is disabled because GameMode is enabled globally",
                        })
                      : undefined
                }
              >
                <span>
                  {t("run_with_gamemode_prefix", {
                    defaultValue: "Automatically run with",
                  })}
                </span>
                <Link
                  to={gamemodeSiteUrl}
                  className="game-options-modal__gamemode-link"
                >
                  GameMode
                  <LinkExternalIcon />
                </Link>
              </span>
            }
            checked={autoRunGamemode || globalAutoRunGamemode}
            disabled={gamemodeToggleDisabled}
            onChange={(event) => onChangeGamemodeState(event.target.checked)}
          />

          {gamemodeToggleDisabled && gamemodeTooltipId && (
            <Tooltip id={gamemodeTooltipId} />
          )}
        </div>

        <div className="game-options-modal__mangohud-toggle">
          <CheckboxField
            label={
              <span
                className={`game-options-modal__mangohud-label ${
                  mangohudToggleDisabled
                    ? "game-options-modal__mangohud-label--disabled"
                    : ""
                }`}
                data-tooltip-id={mangohudTooltipId}
                data-tooltip-content={
                  !mangohudAvailable
                    ? t("mangohud_not_available_tooltip", {
                        defaultValue: "MangoHud is not available in your PATH",
                      })
                    : globalAutoRunMangohud
                      ? t("mangohud_disabled_due_to_global_setting_tooltip", {
                          defaultValue:
                            "This option is disabled because MangoHud is enabled globally",
                        })
                      : undefined
                }
              >
                <span>
                  {t("run_with_mangohud_prefix", {
                    defaultValue: "Automatically run with",
                  })}
                </span>
                <Link
                  to={mangohudSiteUrl}
                  className="game-options-modal__mangohud-link"
                >
                  MangoHud
                  <LinkExternalIcon />
                </Link>
              </span>
            }
            checked={autoRunMangohud || globalAutoRunMangohud}
            disabled={mangohudToggleDisabled}
            onChange={(event) => onChangeMangohudState(event.target.checked)}
          />

          {mangohudToggleDisabled && mangohudTooltipId && (
            <Tooltip id={mangohudTooltipId} />
          )}
        </div>

        <div className="game-options-modal__gamescope-toggle">
          <CheckboxField
            label={
              <span
                className={`game-options-modal__gamescope-label ${
                  !gamescopeAvailable
                    ? "game-options-modal__gamescope-label--disabled"
                    : ""
                }`}
                data-tooltip-id={
                  !gamescopeAvailable
                    ? "gamescope-unavailable-tooltip"
                    : undefined
                }
                data-tooltip-content={
                  !gamescopeAvailable
                    ? t("gamescope_not_available_tooltip")
                    : undefined
                }
              >
                {t("run_with_gamescope")}
              </span>
            }
            checked={useGamescope && gamescopeAvailable}
            disabled={!gamescopeAvailable}
            onChange={(event) => onChangeGamescopeState(event.target.checked)}
          />

          {!gamescopeAvailable && (
            <Tooltip id="gamescope-unavailable-tooltip" />
          )}

          <h4 className="game-options-modal__header-description">
            {gamescopeAvailable
              ? t("gamescope_description")
              : t("gamescope_unavailable_description")}
          </h4>
        </div>

        <div className="game-options-modal__sandbox-toggle">
          <CheckboxField
            label={
              <span
                className={`game-options-modal__sandbox-label ${
                  !sandboxAvailable
                    ? "game-options-modal__sandbox-label--disabled"
                    : ""
                }`}
                data-tooltip-id={
                  !sandboxAvailable ? "sandbox-unavailable-tooltip" : undefined
                }
                data-tooltip-content={
                  !sandboxAvailable
                    ? t("sandbox_unavailable_tooltip")
                    : undefined
                }
              >
                {t("enable_sandbox")}
              </span>
            }
            checked={sandboxEnabled && sandboxAvailable}
            disabled={!sandboxAvailable}
            onChange={(event) => onChangeSandboxState(event.target.checked)}
          />

          {!sandboxAvailable && <Tooltip id="sandbox-unavailable-tooltip" />}

          <h4 className="game-options-modal__header-description">
            {t("sandbox_description")}
          </h4>
        </div>

        {sandboxEnabled && sandboxAvailable && (
          <>
            <div className="game-options-modal__sandbox-ipc-toggle">
              <CheckboxField
                label={t("sandbox_share_ipc")}
                checked={sandboxShareIpc}
                onChange={(event) =>
                  onChangeSandboxShareIpc(event.target.checked)
                }
              />
              <h4 className="game-options-modal__header-description">
                {t("sandbox_share_ipc_description")}
              </h4>
            </div>

            <div className="game-options-modal__sandbox-ipc-toggle">
              <CheckboxField
                label={
                  <span
                    className={`game-options-modal__sandbox-label ${
                      !networkIsolationAvailable
                        ? "game-options-modal__sandbox-label--disabled"
                        : ""
                    }`}
                    data-tooltip-id={
                      !networkIsolationAvailable
                        ? "network-isolation-unavailable-tooltip"
                        : undefined
                    }
                    data-tooltip-content={
                      !networkIsolationAvailable
                        ? t("network_isolation_unavailable_tooltip")
                        : undefined
                    }
                  >
                    {t("enable_network_isolation")}
                  </span>
                }
                checked={networkIsolationEnabled && networkIsolationAvailable}
                disabled={!networkIsolationAvailable}
                onChange={(event) =>
                  onChangeNetworkIsolation(event.target.checked)
                }
              />

              {!networkIsolationAvailable && (
                <Tooltip id="network-isolation-unavailable-tooltip" />
              )}

              <h4 className="game-options-modal__header-description">
                {t("network_isolation_description")}
              </h4>
            </div>

            <div className="game-options-modal__sandbox-ipc-toggle">
              <SelectField
                label={t("seccomp_level")}
                value={seccompLevel ?? ""}
                options={[
                  {
                    key: "follow-global",
                    value: "",
                    label: t("seccomp_level_follow_global"),
                  },
                  { key: "off", value: "off", label: t("seccomp_level_off") },
                  { key: "low", value: "low", label: t("seccomp_level_low") },
                  {
                    key: "medium",
                    value: "medium",
                    label: t("seccomp_level_medium"),
                  },
                  {
                    key: "high",
                    value: "high",
                    label: t("seccomp_level_high"),
                  },
                ]}
                onChange={(event) => {
                  const raw = event.target.value;
                  onChangeSeccompLevel(
                    raw === ""
                      ? null
                      : (raw as "off" | "low" | "medium" | "high")
                  );
                }}
              />

              <h4 className="game-options-modal__header-description">
                {t("seccomp_level_description")}
              </h4>

              <CheckboxField
                label={t("seccomp_audit")}
                checked={seccompAudit}
                disabled={seccompLevel === "off"}
                onChange={(event) => onChangeSeccompAudit(event.target.checked)}
              />
              <h4 className="game-options-modal__header-description">
                {t("seccomp_audit_description")}
              </h4>
            </div>

            <div className="game-options-modal__sandbox-paths">
              <div className="game-options-modal__header">
                <h2>{t("sandbox_extra_paths")}</h2>
                <h4 className="game-options-modal__header-description">
                  {t("sandbox_extra_paths_description")}
                </h4>
              </div>

              {sandboxExtraPaths.map((extraPath) => (
                <TextField
                  key={extraPath}
                  value={extraPath}
                  readOnly
                  theme="dark"
                  disabled
                  rightContent={
                    <Button
                      type="button"
                      theme="outline"
                      onClick={() => onRemoveSandboxPath(extraPath)}
                    >
                      {t("clear")}
                    </Button>
                  }
                />
              ))}

              <div className="game-options-modal__row">
                <Button
                  type="button"
                  theme="outline"
                  onClick={onAddSandboxPath}
                >
                  <FileDirectoryIcon />
                  {t("sandbox_add_path")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="game-options-modal__section">
        <div className="game-options-modal__header">
          <h2>{t("proton_version")}</h2>
          <h4 className="game-options-modal__header-description">
            {t("proton_version_description")}
          </h4>
        </div>

        <ProtonPathPicker
          versions={protonVersions}
          selectedPath={selectedProtonPath}
          onChange={onChangeProtonVersion}
          radioName={`proton-version-${game.objectId}`}
          autoLabel={protonVersionAutoLabel}
          autoSourceDescription={protonSourceUmuDefault}
          steamSourceDescription={protonSourceSteam}
          compatibilityToolsSourceDescription={protonSourceCompatibilityTools}
        />
      </div>
    </>
  );
}
