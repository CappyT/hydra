import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpenIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { LibraryGame, ProtonVersion } from "@types";
import {
  Button,
  Checkbox,
  DropdownSelect,
  FileExplorerModal,
  HorizontalFocusGroup,
  Input,
  Radio,
  VerticalFocusGroup,
} from "../../../common";
import { useUserPreferences } from "../../../../hooks/use-user-preferences.hook";
import { SettingsSection } from "../../../../pages/settings/settings-section";

import "./compatibility-tab.scss";

type PerGameSeccompLevel = "off" | "low" | "medium" | "high";
type SeccompSelectValue = "" | PerGameSeccompLevel;

const GAME_COMPATIBILITY_SETTINGS_GAMESCOPE_ID =
  "game-compatibility-settings-gamescope";

const GAME_COMPATIBILITY_SETTINGS_SANDBOX_ID =
  "game-compatibility-settings-sandbox";

const GAME_COMPATIBILITY_SETTINGS_SANDBOX_IPC_ID =
  "game-compatibility-settings-sandbox-ipc";

const GAME_COMPATIBILITY_SETTINGS_NETWORK_ISOLATION_ID =
  "game-compatibility-settings-network-isolation";

const GAME_COMPATIBILITY_SETTINGS_SECCOMP_LEVEL_ID =
  "game-compatibility-settings-seccomp-level";

const GAME_COMPATIBILITY_SETTINGS_SECCOMP_AUDIT_ID =
  "game-compatibility-settings-seccomp-audit";

const GAME_COMPATIBILITY_SETTINGS_SANDBOX_ADD_PATH_ID =
  "game-compatibility-settings-sandbox-add-path";

function getSandboxPathRemoveFocusId(path: string) {
  return `game-compatibility-settings-sandbox-path-${path.replaceAll(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
}

export const GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID =
  "game-compatibility-settings-primary-control";

const GAME_COMPATIBILITY_SETTINGS_WINE_SELECT_ID =
  "game-compatibility-settings-wine-select";

const GAME_COMPATIBILITY_SETTINGS_WINE_CLEAR_ID =
  "game-compatibility-settings-wine-clear";

const GAME_COMPATIBILITY_SETTINGS_PROTON_AUTO_ID =
  "game-compatibility-settings-proton-auto";

function getProtonOptionFocusId(path: string) {
  return `game-compatibility-settings-proton-${path.replaceAll(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
}

const GAME_COMPATIBILITY_SETTINGS_GAMEMODE_ID =
  "game-compatibility-settings-gamemode";

const GAME_COMPATIBILITY_SETTINGS_MANGOHUD_ID =
  "game-compatibility-settings-mangohud";

interface GameCompatibilitySettingsProps {
  game: LibraryGame;
}

interface ProtonOption {
  focusId: string;
  value: string;
  title: string;
  description: string;
}

type ElectronCompatibilityBridge = Pick<
  Electron,
  | "getInstalledProtonVersions"
  | "isGamemodeAvailable"
  | "isMangohudAvailable"
  | "isGamescopeAvailable"
  | "isSandboxAvailable"
  | "isNetworkIsolationAvailable"
  | "getDefaultWinePrefixSelectionPath"
  | "selectGameWinePrefix"
  | "selectGameProtonPath"
  | "toggleGameGamemode"
  | "toggleGameMangohud"
  | "toggleGameGamescope"
  | "toggleGameSandbox"
  | "toggleGameSandboxIpc"
  | "toggleGameNetworkIsolation"
  | "updateGameSeccompLevel"
  | "toggleGameSeccompAudit"
  | "updateGameSandboxPaths"
>;

export function GameCompatibilitySettingsTab({
  game,
}: Readonly<GameCompatibilitySettingsProps>) {
  const { t } = useTranslation("game_details");
  const userPreferences = useUserPreferences();
  const electron = globalThis.window
    .electron as unknown as ElectronCompatibilityBridge;

  const [protonVersions, setProtonVersions] = useState<ProtonVersion[]>([]);
  const [gamemodeAvailable, setGamemodeAvailable] = useState(false);
  const [mangohudAvailable, setMangohudAvailable] = useState(false);
  const [gamescopeAvailable, setGamescopeAvailable] = useState(false);
  const [sandboxAvailable, setSandboxAvailable] = useState(false);
  const [networkIsolationAvailable, setNetworkIsolationAvailable] =
    useState(false);
  const [selectedProtonPath, setSelectedProtonPath] = useState(
    game.protonPath ?? ""
  );
  const [winePrefixPath, setWinePrefixPath] = useState<string | null>(
    game.winePrefixPath ?? null
  );
  const [autoRunGamemode, setAutoRunGamemode] = useState(
    game.autoRunGamemode ?? false
  );
  const [autoRunMangohud, setAutoRunMangohud] = useState(
    game.autoRunMangohud ?? false
  );
  const [useGamescope, setUseGamescope] = useState<boolean | null | undefined>(
    game.useGamescope
  );
  const [sandboxDisabled, setSandboxDisabled] = useState<
    boolean | null | undefined
  >(game.sandboxDisabled);
  const [sandboxShareIpc, setSandboxShareIpc] = useState(
    game.sandboxShareIpc ?? false
  );
  const [networkIsolationDisabled, setNetworkIsolationDisabled] = useState<
    boolean | null | undefined
  >(game.networkIsolationDisabled);
  const [seccompLevel, setSeccompLevel] = useState<
    PerGameSeccompLevel | null | undefined
  >(game.seccompLevel);
  const [seccompAudit, setSeccompAudit] = useState(game.seccompAudit ?? false);
  const [sandboxExtraPaths, setSandboxExtraPaths] = useState<string[]>(
    game.sandboxExtraPaths ?? []
  );
  const [winePickerOpen, setWinePickerOpen] = useState(false);
  const [winePickerInitialPath, setWinePickerInitialPath] = useState<
    string | undefined
  >();
  const [sandboxPathPickerOpen, setSandboxPathPickerOpen] = useState(false);

  const isLinux = globalThis.window.electron.platform === "linux";

  useEffect(() => {
    setSelectedProtonPath(game.protonPath ?? "");
    setWinePrefixPath(game.winePrefixPath ?? null);
    setAutoRunGamemode(game.autoRunGamemode ?? false);
    setAutoRunMangohud(game.autoRunMangohud ?? false);
    setUseGamescope(game.useGamescope);
    setSandboxDisabled(game.sandboxDisabled);
    setSandboxShareIpc(game.sandboxShareIpc ?? false);
    setNetworkIsolationDisabled(game.networkIsolationDisabled);
    setSeccompLevel(game.seccompLevel);
    setSeccompAudit(game.seccompAudit ?? false);
    setSandboxExtraPaths(game.sandboxExtraPaths ?? []);
  }, [game]);

  useEffect(() => {
    const loadAvailability = async () => {
      const [
        protonVersionsResult,
        gamemodeResult,
        mangohudResult,
        gamescopeResult,
        sandboxResult,
        networkIsolationResult,
      ] = await Promise.all([
        electron.getInstalledProtonVersions(),
        electron.isGamemodeAvailable(),
        electron.isMangohudAvailable(),
        electron.isGamescopeAvailable(),
        electron.isSandboxAvailable(),
        electron.isNetworkIsolationAvailable(),
      ]);

      setProtonVersions(protonVersionsResult);
      setGamemodeAvailable(gamemodeResult);
      setMangohudAvailable(mangohudResult);
      setGamescopeAvailable(gamescopeResult);
      setSandboxAvailable(sandboxResult);
      setNetworkIsolationAvailable(networkIsolationResult);
    };

    void loadAvailability();
  }, [electron]);

  const getProtonSourceDescription = useCallback(
    (version: ProtonVersion | null) => {
      if (!version?.source) {
        return t("proton_source_umu_default");
      }

      if (version.source === "steam") {
        return t("proton_source_steam");
      }

      if (version.source === "compatibility_tools") {
        return t("proton_source_compatibility_tools");
      }

      return version.source;
    },
    [t]
  );

  const protonOptions = useMemo<ProtonOption[]>(() => {
    const options: ProtonOption[] = [
      {
        focusId: GAME_COMPATIBILITY_SETTINGS_PROTON_AUTO_ID,
        value: "",
        title: t("proton_version_auto"),
        description: getProtonSourceDescription(null),
      },
    ];

    for (const version of protonVersions) {
      options.push({
        focusId: getProtonOptionFocusId(version.path),
        value: version.path,
        title: version.name,
        description: getProtonSourceDescription(version),
      });
    }

    return options;
  }, [protonVersions, t, getProtonSourceDescription]);

  const handleSelectWinePrefix = useCallback(async () => {
    const defaultPath = await electron.getDefaultWinePrefixSelectionPath();
    setWinePickerInitialPath(winePrefixPath ?? defaultPath ?? undefined);
    setWinePickerOpen(true);
  }, [electron, winePrefixPath]);

  const handleWinePrefixPicked = useCallback(
    async (path: string) => {
      setWinePickerOpen(false);
      await electron.selectGameWinePrefix(game.shop, game.objectId, path);
      setWinePrefixPath(path);
    },
    [electron, game.shop, game.objectId]
  );

  const handleClearWinePrefix = useCallback(async () => {
    await electron.selectGameWinePrefix(game.shop, game.objectId, null);
    setWinePrefixPath(null);
  }, [electron, game.shop, game.objectId]);

  const handleChangeProtonVersion = useCallback(
    async (value: string) => {
      setSelectedProtonPath(value);
      await electron.selectGameProtonPath(
        game.shop,
        game.objectId,
        value || null
      );
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleGamemode = useCallback(
    async (checked: boolean) => {
      setAutoRunGamemode(checked);
      await electron.toggleGameGamemode(game.shop, game.objectId, checked);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleMangohud = useCallback(
    async (checked: boolean) => {
      setAutoRunMangohud(checked);
      await electron.toggleGameMangohud(game.shop, game.objectId, checked);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleGamescope = useCallback(
    async (checked: boolean) => {
      setUseGamescope(checked);
      await electron.toggleGameGamescope(game.shop, game.objectId, checked);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleSandbox = useCallback(
    async (checked: boolean) => {
      setSandboxDisabled(!checked);
      await electron.toggleGameSandbox(game.shop, game.objectId, !checked);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleSandboxShareIpc = useCallback(
    async (checked: boolean) => {
      setSandboxShareIpc(checked);
      await electron.toggleGameSandboxIpc(game.shop, game.objectId, checked);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleNetworkIsolation = useCallback(
    async (checked: boolean) => {
      setNetworkIsolationDisabled(!checked);
      await electron.toggleGameNetworkIsolation(
        game.shop,
        game.objectId,
        !checked
      );
    },
    [electron, game.shop, game.objectId]
  );

  const handleChangeSeccompLevel = useCallback(
    async (value: PerGameSeccompLevel | null) => {
      setSeccompLevel(value);
      await electron.updateGameSeccompLevel(game.shop, game.objectId, value);
    },
    [electron, game.shop, game.objectId]
  );

  const handleToggleSeccompAudit = useCallback(
    async (checked: boolean) => {
      setSeccompAudit(checked);
      await electron.toggleGameSeccompAudit(game.shop, game.objectId, checked);
    },
    [electron, game.shop, game.objectId]
  );

  const persistSandboxPaths = useCallback(
    async (nextPaths: string[]) => {
      setSandboxExtraPaths(nextPaths);
      await electron.updateGameSandboxPaths(
        game.shop,
        game.objectId,
        nextPaths
      );
    },
    [electron, game.shop, game.objectId]
  );

  const handleSandboxPathPicked = useCallback(
    async (path: string) => {
      setSandboxPathPickerOpen(false);
      const nextPaths = Array.from(new Set([...sandboxExtraPaths, path]));
      await persistSandboxPaths(nextPaths);
    },
    [persistSandboxPaths, sandboxExtraPaths]
  );

  const handleRemoveSandboxPath = useCallback(
    async (path: string) => {
      const nextPaths = sandboxExtraPaths.filter((value) => value !== path);
      await persistSandboxPaths(nextPaths);
    },
    [persistSandboxPaths, sandboxExtraPaths]
  );

  const globalAutoRunGamemode = userPreferences?.autoRunGamemode ?? false;
  const globalAutoRunMangohud = userPreferences?.autoRunMangohud ?? false;

  // Tri-state: explicit per-game choice wins; AUTO (null/undefined) reflects
  // whether gamescope is detected on the host.
  const gamescopeEffective = useGamescope ?? gamescopeAvailable;
  // Tri-state: explicit per-game choice wins; AUTO follows the global default.
  const sandboxEnabled =
    sandboxDisabled === true
      ? false
      : sandboxDisabled === false
        ? true
        : userPreferences?.disableSandbox !== true;
  const networkIsolationEnabled =
    networkIsolationDisabled === true
      ? false
      : networkIsolationDisabled === false
        ? true
        : userPreferences?.disableNetworkIsolation !== true;
  const showSandboxOptions = isLinux && sandboxEnabled && sandboxAvailable;
  const seccompSelectValue: SeccompSelectValue = seccompLevel ?? "";

  const gamemodeDisabled = !gamemodeAvailable || globalAutoRunGamemode;
  const mangohudDisabled = !mangohudAvailable || globalAutoRunMangohud;

  let gamemodeSecondaryText: string | undefined;

  if (!gamemodeAvailable) {
    gamemodeSecondaryText = t("gamemode_not_available_tooltip");
  } else if (globalAutoRunGamemode) {
    gamemodeSecondaryText = t(
      "gamemode_disabled_due_to_global_setting_tooltip"
    );
  }

  let mangohudSecondaryText: string | undefined;

  if (!mangohudAvailable) {
    mangohudSecondaryText = t("mangohud_not_available_tooltip");
  } else if (globalAutoRunMangohud) {
    mangohudSecondaryText = t(
      "mangohud_disabled_due_to_global_setting_tooltip"
    );
  }

  return (
    <VerticalFocusGroup className="game-compatibility-settings-tab">
      <SettingsSection
        className="game-compatibility-settings-tab__section"
        title={t("wine_prefix")}
        description={t("wine_prefix_description")}
      >
        <HorizontalFocusGroup
          className="game-compatibility-settings-tab__wine-prefix-row"
          asChild
        >
          <div>
            <Input
              focusId={GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID}
              className="game-compatibility-settings-tab__wine-prefix-input"
              value={winePrefixPath ?? ""}
              placeholder={t("no_directory_selected")}
              readOnly
            />

            <Button
              focusId={GAME_COMPATIBILITY_SETTINGS_WINE_SELECT_ID}
              variant="secondary"
              icon={<FolderOpenIcon size={16} />}
              onClick={() => {
                handleSelectWinePrefix().catch(() => {});
              }}
              focusNavigationOverrides={{
                left: {
                  type: "item",
                  itemId: GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID,
                },
              }}
            >
              Select
            </Button>

            {winePrefixPath ? (
              <Button
                focusId={GAME_COMPATIBILITY_SETTINGS_WINE_CLEAR_ID}
                variant="danger"
                icon={<TrashIcon size={16} />}
                onClick={() => {
                  handleClearWinePrefix().catch(() => {});
                }}
                focusNavigationOverrides={{
                  left: {
                    type: "item",
                    itemId: GAME_COMPATIBILITY_SETTINGS_PRIMARY_CONTROL_ID,
                  },
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </HorizontalFocusGroup>
      </SettingsSection>

      <SettingsSection
        className="game-compatibility-settings-tab__section"
        title={t("proton_version")}
        description={t("proton_version_description")}
      >
        <div className="game-compatibility-settings-tab__proton-options">
          {protonOptions.map((option) => (
            <Radio
              key={option.focusId}
              id={option.focusId}
              label={
                <span className="game-compatibility-settings-tab__proton-option-label">
                  <span className="game-compatibility-settings-tab__proton-option-title">
                    {option.title}
                  </span>
                  <span className="game-compatibility-settings-tab__proton-option-description">
                    {option.description}
                  </span>
                </span>
              }
              checked={selectedProtonPath === option.value}
              block
              onChange={() => {
                handleChangeProtonVersion(option.value).catch(() => {});
              }}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        className="game-compatibility-settings-tab__section"
        title={t("additional_options")}
        description="Configure per-game overrides for GameMode and MangoHud"
      >
        <Checkbox
          id={GAME_COMPATIBILITY_SETTINGS_GAMEMODE_ID}
          label="GameMode"
          secondaryText={gamemodeSecondaryText}
          checked={autoRunGamemode || globalAutoRunGamemode}
          disabled={gamemodeDisabled}
          block
          onChange={(checked) => {
            handleToggleGamemode(checked).catch(() => {});
          }}
        />

        <Checkbox
          id={GAME_COMPATIBILITY_SETTINGS_MANGOHUD_ID}
          label="MangoHud"
          secondaryText={mangohudSecondaryText}
          checked={autoRunMangohud || globalAutoRunMangohud}
          disabled={mangohudDisabled}
          block
          onChange={(checked) => {
            handleToggleMangohud(checked).catch(() => {});
          }}
        />

        {isLinux ? (
          <Checkbox
            id={GAME_COMPATIBILITY_SETTINGS_GAMESCOPE_ID}
            label={t("run_with_gamescope")}
            secondaryText={
              gamescopeAvailable
                ? t("gamescope_description")
                : t("gamescope_unavailable_description")
            }
            checked={gamescopeEffective && gamescopeAvailable}
            disabled={!gamescopeAvailable}
            block
            onChange={(checked) => {
              handleToggleGamescope(checked).catch(() => {});
            }}
          />
        ) : null}
      </SettingsSection>

      {isLinux ? (
        <SettingsSection
          className="game-compatibility-settings-tab__section"
          title={t("enable_sandbox")}
          description={t("sandbox_description")}
        >
          <Checkbox
            id={GAME_COMPATIBILITY_SETTINGS_SANDBOX_ID}
            label={t("enable_sandbox")}
            secondaryText={
              sandboxAvailable ? undefined : t("sandbox_unavailable_tooltip")
            }
            checked={sandboxEnabled && sandboxAvailable}
            disabled={!sandboxAvailable}
            block
            onChange={(checked) => {
              handleToggleSandbox(checked).catch(() => {});
            }}
          />

          {showSandboxOptions ? (
            <>
              <Checkbox
                id={GAME_COMPATIBILITY_SETTINGS_SANDBOX_IPC_ID}
                label={t("sandbox_share_ipc")}
                secondaryText={t("sandbox_share_ipc_description")}
                checked={sandboxShareIpc}
                block
                onChange={(checked) => {
                  handleToggleSandboxShareIpc(checked).catch(() => {});
                }}
              />

              <Checkbox
                id={GAME_COMPATIBILITY_SETTINGS_NETWORK_ISOLATION_ID}
                label={t("enable_network_isolation")}
                secondaryText={
                  networkIsolationAvailable
                    ? t("network_isolation_description")
                    : t("network_isolation_unavailable_tooltip")
                }
                checked={networkIsolationEnabled && networkIsolationAvailable}
                disabled={!networkIsolationAvailable}
                block
                onChange={(checked) => {
                  handleToggleNetworkIsolation(checked).catch(() => {});
                }}
              />

              <div className="game-compatibility-settings-tab__seccomp">
                <DropdownSelect<SeccompSelectValue>
                  label={t("seccomp_level")}
                  ariaLabel={t("seccomp_level")}
                  value={seccompSelectValue}
                  focusId={GAME_COMPATIBILITY_SETTINGS_SECCOMP_LEVEL_ID}
                  options={[
                    { value: "", label: t("seccomp_level_follow_global") },
                    { value: "off", label: t("seccomp_level_off") },
                    { value: "low", label: t("seccomp_level_low") },
                    { value: "medium", label: t("seccomp_level_medium") },
                    { value: "high", label: t("seccomp_level_high") },
                  ]}
                  onValueChange={(value) => {
                    handleChangeSeccompLevel(value === "" ? null : value).catch(
                      () => {}
                    );
                  }}
                />
                <p className="game-compatibility-settings-tab__seccomp-description">
                  {t("seccomp_level_description")}
                </p>
              </div>

              <Checkbox
                id={GAME_COMPATIBILITY_SETTINGS_SECCOMP_AUDIT_ID}
                label={t("seccomp_audit")}
                secondaryText={t("seccomp_audit_description")}
                checked={seccompAudit}
                disabled={seccompLevel === "off"}
                block
                onChange={(checked) => {
                  handleToggleSeccompAudit(checked).catch(() => {});
                }}
              />

              <div className="game-compatibility-settings-tab__sandbox-paths">
                <p className="game-compatibility-settings-tab__sandbox-paths-title">
                  {t("sandbox_extra_paths")}
                </p>
                <p className="game-compatibility-settings-tab__sandbox-paths-description">
                  {t("sandbox_extra_paths_description")}
                </p>

                {sandboxExtraPaths.map((extraPath) => (
                  <HorizontalFocusGroup
                    key={extraPath}
                    className="game-compatibility-settings-tab__sandbox-path-row"
                    asChild
                  >
                    <div>
                      <Input
                        className="game-compatibility-settings-tab__sandbox-path-input"
                        value={extraPath}
                        readOnly
                      />
                      <Button
                        focusId={getSandboxPathRemoveFocusId(extraPath)}
                        variant="danger"
                        icon={<TrashIcon size={16} />}
                        onClick={() => {
                          handleRemoveSandboxPath(extraPath).catch(() => {});
                        }}
                      >
                        {t("clear")}
                      </Button>
                    </div>
                  </HorizontalFocusGroup>
                ))}

                <Button
                  focusId={GAME_COMPATIBILITY_SETTINGS_SANDBOX_ADD_PATH_ID}
                  variant="secondary"
                  icon={<PlusIcon size={16} />}
                  onClick={() => setSandboxPathPickerOpen(true)}
                >
                  {t("sandbox_add_path")}
                </Button>
              </div>
            </>
          ) : null}
        </SettingsSection>
      ) : null}

      <FileExplorerModal
        visible={winePickerOpen}
        onClose={() => setWinePickerOpen(false)}
        onSelect={(path) => {
          handleWinePrefixPicked(path).catch(() => {});
        }}
        title={t("wine_prefix")}
        initialPath={winePickerInitialPath}
        selectDirectory
      />

      <FileExplorerModal
        visible={sandboxPathPickerOpen}
        onClose={() => setSandboxPathPickerOpen(false)}
        onSelect={(path) => {
          handleSandboxPathPicked(path).catch(() => {});
        }}
        title={t("sandbox_extra_paths")}
        selectDirectory
      />
    </VerticalFocusGroup>
  );
}
