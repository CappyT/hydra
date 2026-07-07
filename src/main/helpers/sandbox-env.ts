/**
 * Block-by-default environment allowlist for sandboxed launches.
 *
 * Every game/installer spawn used to inherit the launcher's full `process.env`,
 * which the untrusted game can read back via `/proc/self/environ` — leaking any
 * secret the user happened to export into the shell that started Hydra
 * (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, ...). We instead pass through ONLY the
 * variables a game legitimately needs (display server, audio, GPU/driver,
 * wine/Proton, locale, XDG dirs). Everything else is dropped.
 *
 * An allowlist is used rather than a blocklist because the set of variables a
 * game needs is small and known, whereas the set of secrets is open-ended and a
 * blocklist would silently leak anything it forgot to name.
 *
 * This is applied at the spawn sites ONLY when the sandbox is enabled for that
 * launch, so a user who explicitly disables the sandbox for a game keeps the
 * old full-environment behavior (intentional escape hatch). The launch code's
 * own explicit variables (WINEPREFIX, PROTONPATH, ...) are merged on top of the
 * scrubbed base afterwards, so nothing the launch sets is lost.
 */

/** Exact variable names that always pass through. */
const ALLOWED_EXACT_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "LANG",
  "PWD",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
]);

/**
 * Variable-name prefixes whose whole family passes through. Covers the driver,
 * wine/Proton, audio, locale and toolkit knobs games and their runtimes rely
 * on (e.g. `WINEDEBUG`, `PROTON_LOG`, `MESA_GL_VERSION_OVERRIDE`, `__GL_SHADER_
 * DISK_CACHE`, `LC_ALL`).
 */
const ALLOWED_KEY_PREFIXES = [
  "LC_",
  "WINE",
  "PROTON",
  "STEAM",
  "UMU",
  "DXVK",
  "VKD3D",
  "MANGOHUD",
  "GAMESCOPE",
  "GAMEID",
  "SDL_",
  "PULSE",
  "PIPEWIRE",
  "VK_",
  "VULKAN",
  "MESA",
  "DRI",
  "LIBGL",
  "__GL_",
  "__NV_",
  "__VK_",
  "NV_",
  "NVIDIA",
  "RADV",
  "AMD_",
  "ACO_",
  "GALLIUM",
  "WAYLAND",
  "GDK_",
  "QT_",
  "FREETYPE",
  "FONTCONFIG",
  "ENABLE_",
  "DISABLE_",
  "HYDRA_UMU_",
];

const isAllowedKey = (key: string): boolean =>
  ALLOWED_EXACT_KEYS.has(key) ||
  ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Returns a copy of `base` keeping only the allowlisted variables (see above).
 * Undefined values are dropped so the result is a plain string map suitable for
 * a `spawn` env.
 */
export const buildSandboxEnv = (
  base: NodeJS.ProcessEnv
): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isAllowedKey(key)) {
      result[key] = value;
    }
  }

  return result;
};
