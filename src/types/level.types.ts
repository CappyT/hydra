import type { Downloader } from "@shared";
import type {
  GameShop,
  SteamAchievement,
  UnlockedAchievement,
} from "./game.types";
import type { DownloadStatus } from "./download.types";
import type { ClassicsDisc } from "./emulator.types";

export type SubscriptionStatus = "active" | "pending" | "cancelled";

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  plan: { id: string; name: string };
  expiresAt: string | null;
  paymentMethod: "pix" | "paypal";
}

export interface Auth {
  accessToken: string;
  refreshToken: string;
  tokenExpirationTimestamp: number;
  workwondersJwt: string;
}

export interface User {
  id: string;
  displayName: string;
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  subscription: Subscription | null;
}

export interface GameCollectionRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface Game {
  title: string;
  iconUrl: string | null;
  libraryHeroImageUrl: string | null;
  logoImageUrl: string | null;
  customIconUrl?: string | null;
  customLogoImageUrl?: string | null;
  customHeroImageUrl?: string | null;
  originalIconPath?: string | null;
  originalLogoPath?: string | null;
  originalHeroPath?: string | null;
  customOriginalIconPath?: string | null;
  customOriginalLogoPath?: string | null;
  customOriginalHeroPath?: string | null;
  playTimeInMilliseconds: number;
  unsyncedDeltaPlayTimeInMilliseconds?: number;
  lastTimePlayed: Date | null;
  addedToLibraryAt?: Date | null;
  objectId: string;
  shop: GameShop;
  remoteId: string | null;
  collectionIds?: string[];
  isDeleted: boolean;
  winePrefixPath?: string | null;
  protonPath?: string | null;
  executablePath?: string | null;
  executablePathUpdatedAt?: Date | null;
  trackingExecutablePaths?: string[] | null;
  trackingExecutablePathsUpdatedAt?: Date | null;
  launchOptions?: string | null;
  autoRunMangohud?: boolean | null;
  autoRunGamemode?: boolean | null;
  /**
   * Per-game gamescope launch preference (tri-state): `null`/`undefined` means
   * AUTO (effective value is "gamescope binary detected on host"); an explicit
   * `true`/`false` is the user's choice and is always honored.
   */
  useGamescope?: boolean | null;
  sandboxDisabled?: boolean;
  sandboxExtraPaths?: string[];
  sandboxShareIpc?: boolean;
  /**
   * Per-game network-isolation preference (tri-state): `null`/`undefined` means
   * follow the global default; an explicit `true`/`false` is the user's choice
   * and always wins over the global `disableNetworkIsolation` preference. When
   * isolated, the game runs in its own network namespace (pasta userspace NAT):
   * host loopback services become unreachable and internet/LAN still work.
   */
  networkIsolationDisabled?: boolean | null;
  /**
   * Per-game seccomp override. `null`/`undefined` follows the global level;
   * `"off"` disables the syscall filter for this game only; an explicit
   * `"low"`/`"medium"`/`"high"` overrides the global protection level (and wins
   * over the global `disableSeccomp` kill-switch, mirroring the per-game network
   * and sandbox overrides).
   */
  seccompLevel?: "off" | "low" | "medium" | "high" | null;
  /**
   * Per-game diagnostic flag. When true the seccomp filter is built in AUDIT
   * mode (SECCOMP_RET_LOG): every would-be-blocked syscall is allowed but logged
   * by the kernel, so breakage can be diagnosed WITHOUT enforcing the filter.
   * Enforcement is suspended for the game while this is on.
   */
  seccompAudit?: boolean;
  favorite?: boolean;
  isPinned?: boolean;
  achievementCount?: number;
  unlockedAchievementCount?: number;
  pinnedDate?: Date | null;
  automaticCloudSync?: boolean;
  hasManuallyUpdatedPlaytime?: boolean;
  newDownloadOptionsCount?: number;
  installedSizeInBytes?: number | null;
  installerSizeInBytes?: number | null;
  steamShortcutAppId?: number;
  platform?: string | null;
  discs?: ClassicsDisc[];
  selectedDiscPath?: string | null;
  dontAskDiscSelection?: boolean;
  romSizeBytes?: number | null;
}

export interface Download {
  shop: GameShop;
  objectId: string;
  uri: string;
  folderName: string | null;
  downloadPath: string;
  progress: number;
  downloader: Downloader;
  bytesDownloaded: number;
  fileSize: number | null;
  shouldSeed: boolean;
  status: DownloadStatus | null;
  queued: boolean;
  pinnedToHero?: boolean;
  timestamp: number;
  extracting: boolean;
  extractionProgress?: number;
  automaticallyExtract: boolean;
  automaticallyDeleteArchiveFiles: boolean;
  fileIndices?: number[];
  selectedFilesSize?: number | null;
}

export interface DownloadLayoutState {
  version: 1;
  queueOrder: string[];
  pausedOrder: string[];
}

export interface GameAchievement {
  achievements: SteamAchievement[];
  unlockedAchievements: UnlockedAchievement[];
  updatedAt: number | undefined;
  language: string | undefined;
  catalogueValidator?: string;
}

export type AchievementCustomNotificationPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type BigPictureDiagnosticsPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface DownloadDirectoryPreference {
  path: string;
  createdAt: string;
  source: "manual" | "auto";
}

export interface UserPreferences {
  downloadsPath?: string | null;
  defaultWinePrefixPath?: string | null;
  downloadDirectories?: DownloadDirectoryPreference[];
  optionalDownloadsPaths?: string[];
  ggDealsApiKey?: string | null;
  language?: string;
  realDebridApiToken?: string | null;
  premiumizeApiToken?: string | null;
  allDebridApiToken?: string | null;
  torBoxApiToken?: string | null;
  retroAchievementsWebApiKey?: string | null;
  retroAchievementsUsername?: string | null;
  preferQuitInsteadOfHiding?: boolean;
  runAtStartup?: boolean;
  startMinimized?: boolean;
  launchToLibraryPage?: boolean;
  launchInBigPicture?: boolean;
  disableNsfwAlert?: boolean;
  enableAutoInstall?: boolean;
  seedAfterDownloadComplete?: boolean;
  showHiddenAchievementsDescription?: boolean;
  showDownloadSpeedInMegabits?: boolean;
  downloadNotificationsEnabled?: boolean;
  repackUpdatesNotificationsEnabled?: boolean;
  achievementNotificationsEnabled?: boolean;
  achievementCustomNotificationsEnabled?: boolean;
  achievementCustomNotificationPosition?: AchievementCustomNotificationPosition;
  achievementSoundVolume?: number;
  friendRequestNotificationsEnabled?: boolean;
  friendStartGameNotificationsEnabled?: boolean;
  showDownloadSpeedInMegabytes?: boolean;
  extractFilesByDefault?: boolean;
  deleteArchiveFilesAfterExtractionByDefault?: boolean;
  enableSteamAchievements?: boolean;
  autoplayGameTrailers?: boolean;
  hideToTrayOnGameStart?: boolean;
  enableNewDownloadOptionsBadges?: boolean;
  createStartMenuShortcut?: boolean;
  bigPictureSoundsEnabled?: boolean;
  bigPictureVirtualKeyboardEnabled?: boolean;
  bigPictureDiagnosticsEnabled?: boolean;
  bigPictureDiagnosticsPosition?: BigPictureDiagnosticsPosition;
  maxDownloadSpeedBytesPerSecond?: number | null;
  torrentNetworkInterface?: string | null;
  defaultProtonPath?: string | null;
  autoRunMangohud?: boolean;
  autoRunGamemode?: boolean;
  disableSandbox?: boolean;
  /**
   * Global kill-switch for the sandbox seccomp syscall filter. Default falsy =
   * seccomp ON. When true, sandboxed launches get no `--seccomp` filter (the
   * bwrap sandbox itself is unaffected). Disabling the whole sandbox
   * (`disableSandbox`) also disables seccomp.
   */
  disableSeccomp?: boolean;
  /**
   * Global sandbox seccomp protection level. Absent = `"medium"` (the default).
   * Selects how much the syscall filter blocks (cumulative: low ⊂ medium ⊂
   * high). Ignored when `disableSeccomp` is set. A per-game `seccompLevel`
   * override wins over this.
   */
  seccompLevel?: "low" | "medium" | "high";
  /**
   * Global kill-switch for sandbox network isolation. Default falsy = isolation
   * ON (when the sandbox is enabled and pasta is available). When true,
   * sandboxed games keep the host network namespace instead of running in their
   * own pasta-provided one. A per-game `networkIsolationDisabled` override wins.
   */
  disableNetworkIsolation?: boolean;
  hideClassicsBookmark?: boolean;
  classicsUseHeroLayout?: boolean;
  backupBackend?: "local" | "rclone";
  backupLocalPath?: string | null;
  rcloneRemote?: string | null;
  autoBackupNewGames?: boolean;
  ludusaviManifestUrl?: string | null;
}

export interface NetworkInterface {
  name: string;
  addresses: string[];
}

export interface ScreenState {
  x?: number;
  y?: number;
  height: number;
  width: number;
  isMaximized: boolean;
}
