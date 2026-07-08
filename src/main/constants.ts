import { app } from "electron";
import path from "node:path";
import { SystemPath } from "./services/system-path";

// Downloads default to a launcher-owned directory instead of the user's
// system Downloads folder, so the sandbox game-dir bind never exposes any
// real user data. A user-configured downloadsPath preference still wins.
export const defaultDownloadsPath = path.join(
  SystemPath.getPath("userData"),
  "Downloads"
);

export const isStaging =
  import.meta.env.MAIN_VITE_API_URL?.includes("staging") ?? false;

export const windowsStartMenuPath = path.join(
  SystemPath.getPath("appData"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs"
);

export const publicProfilePath = "C:/Users/Public";

export const levelDatabasePath = path.join(
  SystemPath.getPath("userData"),
  `hydra-db${isStaging ? "-staging" : ""}`
);

export const commonRedistPath = path.join(
  SystemPath.getPath("userData"),
  "CommonRedist"
);

export const logsPath = path.join(
  SystemPath.getPath("userData"),
  `logs${isStaging ? "-staging" : ""}`
);

export const achievementSoundPath = app.isPackaged
  ? path.join(process.resourcesPath, "achievement.wav")
  : path.join(__dirname, "..", "..", "resources", "achievement.wav");

export const backupsPath = path.join(SystemPath.getPath("userData"), "Backups");

export const sandboxHomesPath = path.join(
  SystemPath.getPath("userData"),
  "sandbox-homes"
);

// Per-game fake /etc/machine-id files, ro-bound into each sandbox. Kept outside
// the game-writable sandbox home so a game cannot tamper with its own id.
export const sandboxMachineIdsPath = path.join(
  SystemPath.getPath("userData"),
  "sandbox-machine-ids"
);

// Compiled seccomp cBPF filter for the bwrap sandbox. Written once per process
// (see sandbox-launch.ts) and passed to bwrap via an inherited fd (`--seccomp`).
export const sandboxSeccompFilterPath = path.join(
  SystemPath.getPath("userData"),
  "seccomp-filter.bpf"
);

// Generated resolv.conf ro-bound into network-isolated sandboxes. It points at
// pasta's DNS-forward address (see sandbox-network.ts) because the host's real
// resolver usually lives on the loopback (127.0.0.53), which is unreachable
// from inside the game's fresh network namespace.
export const sandboxResolvConfPath = path.join(
  SystemPath.getPath("userData"),
  "sandbox-resolv.conf"
);

export const appVersion = app.getVersion() + (isStaging ? "-staging" : "");

export const ASSETS_PATH = path.join(SystemPath.getPath("userData"), "Assets");

export const THEMES_PATH = path.join(SystemPath.getPath("userData"), "themes");

export const INTERVALS = {
  processWatcher: 2_000,
  downloadWatcher: 2_000,
  achievementWatcher: 2_000,
  seedStatusWatcher: 2_000,
  updateChecker: 60_000 * 50, // 50 minutes
  powerSaveBlockerSync: 20_000,
};

export const DEFAULT_ACHIEVEMENT_SOUND_VOLUME = 0.15;

export const DECKY_PLUGINS_LOCATION = path.join(
  SystemPath.getPath("home"),
  "homebrew",
  "plugins"
);

export const HYDRA_DECKY_PLUGIN_LOCATION = path.join(
  DECKY_PLUGINS_LOCATION,
  "Hydra"
);
