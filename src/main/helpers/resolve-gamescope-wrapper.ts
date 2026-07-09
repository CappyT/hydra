import { execFileSync } from "node:child_process";
import { screen } from "electron";

import { WindowManager } from "@main/services/window-manager";
import { logger } from "@main/services/logger";
import { resolveSystemBinary } from "./resolve-system-binary";

/**
 * Resolves the display refresh rate (Hz) for gamescope's `-r`.
 *
 * Electron's `display.displayFrequency` works on X11 but commonly reports 0 on
 * Wayland (GNOME/KDE), which would silently drop `-r` and leave gamescope at its
 * 60 Hz nested default. When it is missing we fall back to `xrandr`, whose
 * current-mode refresh is correct on X11 AND on XWayland-backed Wayland
 * sessions (the `*` marks the active mode). If neither yields a value we return
 * 0 and the caller omits `-r` (gamescope keeps its default).
 */
const resolveRefreshHz = (electronFrequency: number): number => {
  if (electronFrequency > 0) {
    return Math.round(electronFrequency);
  }

  try {
    const output = execFileSync("xrandr", ["--current"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    // The active mode's refresh is the number immediately before the `*`, e.g.
    // "3440x1440    119.98*+". Take the first (primary/current) match.
    const match = output.match(/(\d+(?:\.\d+)?)\*/);
    if (match) {
      const hz = Math.round(Number.parseFloat(match[1]));
      if (hz > 0) return hz;
    }
  } catch {
    // xrandr absent or no X server reachable (pure Wayland, no XWayland) — fall
    // through to "unknown" so the caller simply omits -r.
  }

  return 0;
};

/**
 * Builds the gamescope wrapper tokens for a launch, sized to the host display.
 *
 * gamescope in nested mode defaults its internal render size to 1280x720 and
 * upscales, so without explicit dimensions every game runs at 720p (and, on a
 * non-16:9 monitor, at the wrong aspect ratio). We size it to the CURRENT
 * display instead: output (`-W`/`-H`) and internal render (`-w`/`-h`) are both
 * set to the display's physical resolution (native, correct aspect, no upscale
 * blur) and `-r` to its refresh rate.
 *
 * The geometry is read from Electron's `screen` API (portable across X11 and
 * Wayland, unlike shelling out to wlr-randr/gnome-randr which vary per
 * compositor) and re-evaluated on every launch, so it adapts to whatever
 * monitor the launcher is on today — no configuration. The target is the
 * display the launcher window is on (falling back to the primary display), so
 * on a mixed-resolution multi-monitor setup the game gets that monitor's mode.
 *
 * Fully guarded: on any failure, or when the display reports no usable size, it
 * falls back to the previous bare `gamescope -f` (gamescope then picks its own
 * default) rather than emitting a broken command line.
 */
export const buildGamescopeWrapper = (): string[] => {
  // Spawn the SAME binary `isGamescopeAvailable()` probed. Both go through
  // `resolveSystemBinary`, which also searches `~/.local/bin` (the XDG user bin
  // dir Steam gaming mode drops from PATH); emitting the bare `"gamescope"` here
  // would be resolved by the spawn-time PATH instead, so a gamescope installed
  // only in `~/.local/bin` would probe available yet fail to spawn. Fall back to
  // the bare name if resolution unexpectedly returns null (callers already gate
  // on availability) rather than crashing.
  const gamescopeBinary = resolveSystemBinary(["gamescope"]) ?? "gamescope";
  const wrapper = [gamescopeBinary, "-f"];

  try {
    const bounds = WindowManager.mainWindow?.getBounds();
    const display = bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getPrimaryDisplay();

    // `size` is in logical (DIP) pixels; multiply by scaleFactor to recover the
    // monitor's physical resolution, which is what gamescope wants.
    const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
    const width = Math.round(display.size.width * scale);
    const height = Math.round(display.size.height * scale);
    const refresh = resolveRefreshHz(display.displayFrequency);

    if (width > 0 && height > 0) {
      wrapper.push(
        "-W",
        String(width),
        "-H",
        String(height),
        "-w",
        String(width),
        "-h",
        String(height)
      );

      if (refresh > 0) {
        wrapper.push("-r", String(refresh));
      }
    } else {
      logger.warn(
        "gamescope: display reported no usable size; using gamescope defaults"
      );
    }
  } catch (error) {
    logger.warn(
      "gamescope: failed to resolve display geometry; using gamescope defaults",
      error
    );
  }

  wrapper.push("--");
  return wrapper;
};
