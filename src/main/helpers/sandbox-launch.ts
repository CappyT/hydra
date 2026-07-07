import fs from "node:fs";
import path from "node:path";
import type { Game, UserPreferences } from "@types";
import { Sandbox, SandboxUnavailableError } from "@main/services/sandbox";
import { logger } from "@main/services/logger";
import type { ResolvedLaunchCommand } from "./resolve-launch-command";

type SandboxGame = Pick<
  Game,
  "sandboxDisabled" | "sandboxExtraPaths" | "sandboxShareIpc"
>;

export interface SandboxLaunchContext {
  userPreferences?: UserPreferences | null;
  game?: SandboxGame | null;
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
    gameDir,
    winePrefix,
    protonDir,
    additionalBinds = [],
  } = context;

  if (!Sandbox.isEnabled(userPreferences, game)) {
    return resolved;
  }

  if (!Sandbox.isAvailable()) {
    throw new SandboxUnavailableError();
  }

  ensureUmuRuntimeDir();

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
    shareIpc: game?.sandboxShareIpc === true,
  });

  return {
    command,
    args,
    env: resolved.env,
  };
};
