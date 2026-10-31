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
 *
 * Variables from the resolved launch command (launch options such as
 * `LD_PRELOAD=... %command%`) never enter the host environment of a sandboxed
 * spawn: {@link moveLaunchEnvIntoPayload} applies them with env(1) at the final
 * exec inside the sandbox.
 */

import { SandboxUnavailableError } from "../services/sandbox-command-builder";

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

export const SANDBOX_ENV_PATH = "/usr/bin/env";
const SANDBOX_NICE_PATH = "/usr/bin/nice";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface LaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Moves the launch variables of a sandboxed command into its argv:
 * `/usr/bin/env NAME=VALUE... <command> <args...>`. bwrap, the network wrapper
 * (which holds CAP_SYS_ADMIN/CAP_NET_ADMIN in the host netns) and pasta inherit
 * the spawn environment, so a game-supplied `LD_PRELOAD`, `LD_LIBRARY_PATH` or
 * `BASH_ENV` must reach only the final exec after the capability drop. Values
 * travel as argv, so spaces, quotes and `=` survive without a shell. The
 * returned env is always empty.
 */
export const moveLaunchEnvIntoPayload = (
  launch: LaunchCommand
): LaunchCommand => {
  const entries = Object.entries(launch.env);
  if (entries.length === 0) return { ...launch, env: {} };

  for (const [name] of entries) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SandboxUnavailableError(
        `Invalid launch environment variable name: ${JSON.stringify(name)}`
      );
    }
  }

  // env(1) reads every leading operand that contains "=" as an assignment, so
  // a command path with "=" goes through a no-op exec that does not parse it.
  const target = launch.command.includes("=")
    ? [SANDBOX_NICE_PATH, "-n", "0", "--", launch.command]
    : [launch.command];

  return {
    command: SANDBOX_ENV_PATH,
    args: [
      ...entries.map(([name, value]) => `${name}=${value}`),
      ...target,
      ...launch.args,
    ],
    env: {},
  };
};
