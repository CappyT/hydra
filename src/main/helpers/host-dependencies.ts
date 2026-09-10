import { Sandbox } from "@main/services";
import { isNetworkIsolationAvailable } from "@main/services/sandbox-network";
import { logger } from "@main/services/logger";
import { isGamescopeAvailable } from "./is-gamescope-available";

/**
 * Host tools required by the selected launch protections. Startup warns;
 * a launch with a missing required protection fails closed.
 */
export type HostTool = "bwrap" | "pasta" | "gamescope";

/**
 * Detects which of the optional host tools are MISSING, reusing the same
 * detection the rest of the app already uses:
 *  - `bwrap` (bubblewrap): {@link Sandbox.isAvailable}. Missing = the sandbox
 *    cannot run; with the sandbox enabled (the default) launches are BLOCKED by
 *    the fail-closed policy (SandboxUnavailableError) until bubblewrap is
 *    installed or the sandbox is disabled.
 *  - `pasta` (passt): {@link isNetworkIsolationAvailable}. Missing = network
 *    isolation cannot run; isolated launches are blocked.
 *  - `gamescope`: {@link isGamescopeAvailable}. Missing = the gamescope wrapper
 *    is unavailable; games run without it.
 *
 * Linux-only: returns an empty array on every other platform (these tools are
 * Linux-only and their absence there is expected, not a problem to warn about).
 */
export const getMissingHostTools = (): HostTool[] => {
  if (process.platform !== "linux") {
    return [];
  }

  const missing: HostTool[] = [];

  if (!Sandbox.isAvailable()) missing.push("bwrap");
  if (!isNetworkIsolationAvailable()) missing.push("pasta");
  if (!isGamescopeAvailable()) missing.push("gamescope");

  return missing;
};

let loggedMissingHostTools = false;

/**
 * Logs one warning at startup listing any missing host tools (once per process).
 * The user-facing toast is built and shown in the renderer (which owns the
 * locale strings); this only guarantees the state is recorded in the launch log
 * even when no window is shown (e.g. `--hidden` autostart). No-op when nothing
 * is missing.
 */
export const logMissingHostToolsOnce = (): void => {
  if (loggedMissingHostTools) return;
  loggedMissingHostTools = true;

  const missing = getMissingHostTools();
  if (missing.length === 0) return;

  logger.warn(
    `Missing optional host tools: ${missing.join(", ")}. ` +
      "bwrap -> sandbox cannot run (sandboxed launches blocked while enabled); " +
      "pasta -> isolated launches blocked; " +
      "gamescope -> gamescope wrapper unavailable."
  );
};
