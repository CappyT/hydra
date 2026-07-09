import fs from "node:fs";
import { resolveSystemBinary } from "./resolve-system-binary";

/**
 * Detects whether the `gamescope` compositor binary is available on the host.
 * resolveSystemBinary walks PATH and fs.stat()s each candidate, so this is
 * re-evaluated on every call and picks up a gamescope installed mid-session on
 * the next launch. Linux-only: returns false everywhere else.
 */
export const isGamescopeAvailable = (): boolean => {
  if (process.platform !== "linux") {
    return false;
  }

  return resolveSystemBinary(["gamescope"]) !== null;
};

/**
 * Detects whether we are already running inside a gamescope session (SteamOS
 * gaming mode / Steam Deck). Nesting a second gamescope there is never wanted:
 * the session compositor already owns the display, and the nested instance
 * cannot even bring up its embedded Xwayland inside the sandbox (host
 * /tmp/.X11-unix fails its socket-dir ownership check), leaving a doomed
 * process that pops the gamescope WSI dialog and segfaults on dismissal.
 */
export const isGamescopeSessionActive = (): boolean => {
  return (
    process.platform === "linux" &&
    process.env.XDG_CURRENT_DESKTOP === "gamescope"
  );
};

/**
 * Detects whether a Wayland session socket is present. Used to decide the
 * gamescope backend: with a Wayland session gamescope presents as a single
 * Wayland client (and the sandbox can drop the session X11 binds); without one
 * gamescope falls back to its X11 backend, which still needs the session X
 * server, so the X11 binds must be kept.
 */
export const isWaylandSessionAvailable = (): boolean => {
  if (process.platform !== "linux") {
    return false;
  }

  if (process.env.WAYLAND_DISPLAY) {
    return true;
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    return false;
  }

  try {
    return fs
      .readdirSync(runtimeDir)
      .some((entry) => entry.startsWith("wayland-"));
  } catch {
    return false;
  }
};
