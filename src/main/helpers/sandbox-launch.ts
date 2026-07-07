import fs from "node:fs";
import path from "node:path";
import type { Game, UserPreferences } from "@types";
import { Sandbox } from "@main/services/sandbox";
import { assertSandboxAvailable } from "@main/services/sandbox-command-builder";
import { logger } from "@main/services/logger";
import { sandboxHomesPath } from "@main/constants";
import type { ResolvedLaunchCommand } from "./resolve-launch-command";

type SandboxGame = Pick<
  Game,
  "sandboxDisabled" | "sandboxExtraPaths" | "sandboxShareIpc"
>;

export interface SandboxLaunchContext {
  userPreferences?: UserPreferences | null;
  game?: SandboxGame | null;
  /**
   * Stable per-game identity (e.g. `levelKeys.game(shop, objectId)`). When
   * provided, a persistent per-game sandbox home is created and bound so native
   * saves and shader caches survive across launches. Callers without a game
   * identity omit it and fall back to the ephemeral home.
   */
  gameKey?: string | null;
  /** Game directory, bound read-write. */
  gameDir: string;
  /** Wine/Proton prefix, bound read-write when present. */
  winePrefix?: string | null;
  /** Proton installation directory, bound read-only when present. */
  protonDir?: string | null;
  /**
   * Extra read-write paths required by this launch flavor (e.g. emulator
   * config/save dirs and the disc directory), on top of the user-configured
   * per-game extra paths.
   */
  additionalBinds?: string[];
  /**
   * Extra read-only paths required by this launch flavor (e.g. the bundled
   * umu-run zipapp under the AppImage mount, hidden by the /tmp tmpfs).
   */
  additionalRoBinds?: string[];
}

const ensureUmuRuntimeDir = () => {
  const home = process.env.HOME;
  if (!home) return;

  try {
    fs.mkdirSync(path.join(home, ".local", "share", "umu"), {
      recursive: true,
    });
  } catch (error) {
    logger.warn("Failed to ensure umu runtime dir for sandbox", error);
  }
};

const ensureWinePrefixDir = (winePrefix?: string | null) => {
  if (!winePrefix) return;

  try {
    fs.mkdirSync(winePrefix, { recursive: true });
  } catch (error) {
    logger.warn("Failed to ensure wine prefix dir for sandbox", error);
  }
};

/**
 * Sanitizes a per-game key (e.g. `levelKeys.game(shop, objectId)`) into a
 * filesystem-safe directory name. Shared so the sandbox home and any code that
 * needs to locate that home derive the same path.
 */
export const sanitizeSandboxGameKey = (gameKey: string): string =>
  gameKey.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Resolves (and creates) the persistent per-game sandbox home directory. Real
 * home stays hidden; the game sees this directory bound over $HOME.
 */
const ensureSandboxHome = (gameKey?: string | null): string | undefined => {
  if (!gameKey) return undefined;

  const sanitized = sanitizeSandboxGameKey(gameKey);
  const homePersistDir = path.join(sandboxHomesPath, sanitized);

  try {
    fs.mkdirSync(homePersistDir, { recursive: true });
    return homePersistDir;
  } catch (error) {
    logger.warn("Failed to ensure sandbox home dir", error);
    return undefined;
  }
};

/**
 * Wraps an already-resolved launch command inside the bubblewrap sandbox when
 * the sandbox is enabled (globally by default, unless disabled). Throws
 * SandboxUnavailableError when the sandbox is enabled but bwrap is missing, so
 * that no launch silently escapes the sandbox.
 */
export const wrapWithSandbox = (
  resolved: ResolvedLaunchCommand,
  context: SandboxLaunchContext
): ResolvedLaunchCommand => {
  const {
    userPreferences,
    game,
    gameKey,
    gameDir,
    winePrefix,
    protonDir,
    additionalBinds = [],
    additionalRoBinds = [],
  } = context;

  const sandboxEnabled = Sandbox.isEnabled(userPreferences, game);
  if (!sandboxEnabled) {
    return resolved;
  }

  // Fail closed: never let a launch escape the sandbox when bwrap is missing.
  assertSandboxAvailable(sandboxEnabled, Sandbox.isAvailable());

  ensureUmuRuntimeDir();
  // On a first launch the wine prefix dir does not exist yet; create it before
  // binding so Proton writes the prefix (saves, achievements) to the host and
  // not into the sandbox tmpfs.
  ensureWinePrefixDir(winePrefix);

  const homePersistDir = ensureSandboxHome(gameKey);

  const { command, args } = Sandbox.wrapCommand({
    command: resolved.command,
    args: resolved.args,
    env: { ...process.env, ...resolved.env },
    gameDir,
    winePrefix,
    protonDir,
    extraBinds: [
      ...additionalBinds,
      ...(game?.sandboxExtraPaths?.filter(Boolean) ?? []),
    ],
    extraRoBinds: additionalRoBinds,
    homePersistDir,
    shareIpc: game?.sandboxShareIpc === true,
  });

  return {
    command,
    args,
    env: resolved.env,
  };
};
