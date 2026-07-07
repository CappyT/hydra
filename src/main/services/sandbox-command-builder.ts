import fs from "node:fs";
import path from "node:path";
import type { Game, UserPreferences } from "@types";

export const BWRAP_PATH = "/usr/bin/bwrap";

export class SandboxUnavailableError extends Error {
  code = "SANDBOX_UNAVAILABLE" as const;

  constructor() {
    super(
      "bubblewrap (bwrap) is not available, but the sandbox is enabled. " +
        "Install bubblewrap or disable the sandbox to launch this game."
    );
  }
}

/**
 * Fail-closed guard for the sandbox. When the sandbox is enabled but bwrap is
 * unavailable, this throws SandboxUnavailableError so that no launch can ever
 * escape the sandbox. Kept in this electron/logger-free module so the
 * security-critical invariant is unit-testable in isolation.
 */
export const assertSandboxAvailable = (
  enabled: boolean,
  available: boolean
): void => {
  if (enabled && !available) {
    throw new SandboxUnavailableError();
  }
};

export interface SandboxWrapOptions {
  command: string;
  args: string[];
  /**
   * The environment that will be passed to the spawned process. Used only to
   * read HOME / XDG_RUNTIME_DIR / display related values while building the
   * bwrap profile. bwrap inherits the environment from the spawn call, so no
   * value is mutated here.
   */
  env: Record<string, string | undefined>;
  /** Game directory, bound read-write (1:1). */
  gameDir: string;
  /** Wine/Proton prefix, bound read-write (1:1) when present. */
  winePrefix?: string | null;
  /** Proton installation directory, bound read-only (1:1) when present. */
  protonDir?: string | null;
  /** User-configured extra paths, bound read-write (1:1) when present. */
  extraBinds?: string[];
  /**
   * Extra read-only paths required by this launch flavor (e.g. the bundled
   * umu-run zipapp, which lives under the AppImage mount in /tmp and would
   * otherwise be hidden by the /tmp tmpfs).
   */
  extraRoBinds?: string[];
  /**
   * Persistent per-game home directory. When set and existing, it is bound
   * over the sandbox $HOME (an intentional path remap of $HOME only) instead of
   * a fresh empty dir, so native saves and shader caches survive across
   * launches. The real host home stays hidden behind the /home tmpfs.
   */
  homePersistDir?: string | null;
  /** When false (default) the IPC namespace is unshared. */
  shareIpc?: boolean;
}

const isExistingPath = (
  candidate: string | null | undefined
): candidate is string =>
  Boolean(candidate) && fs.existsSync(candidate as string);

const getUmuRuntimeDir = (home: string): string | null => {
  if (!home) return null;
  return path.join(home, ".local", "share", "umu");
};

const listNvidiaDevices = (): string[] => {
  try {
    return fs.readdirSync("/dev").filter((entry) => entry.startsWith("nvidia"));
  } catch {
    return [];
  }
};

const listRuntimeSockets = (runtimeDir: string): string[] => {
  try {
    return fs
      .readdirSync(runtimeDir)
      .filter(
        (entry) =>
          entry.startsWith("wayland-") ||
          entry.startsWith("pipewire-") ||
          entry === "pulse"
      );
  } catch {
    return [];
  }
};

/**
 * Decides whether the sandbox should wrap a launch. The sandbox is ON by
 * default; a per-game override takes precedence over the global preference.
 */
export const isSandboxEnabled = (
  userPreferences: UserPreferences | null | undefined,
  game: Pick<Game, "sandboxDisabled"> | null | undefined
): boolean => {
  if (process.platform !== "linux") {
    return false;
  }

  if (game?.sandboxDisabled === true) {
    return false;
  }

  if (game?.sandboxDisabled === false) {
    return true;
  }

  return userPreferences?.disableSandbox !== true;
};

/**
 * Builds a bwrap command that wraps the given command/args inside an isolated
 * filesystem/pid/ipc sandbox. Network access is intentionally left open. The
 * returned environment is still supplied by the caller's spawn call and
 * inherited by everything inside the sandbox.
 */
export const buildSandboxArgs = (
  options: SandboxWrapOptions
): { command: string; args: string[] } => {
  const {
    command,
    args,
    env,
    gameDir,
    winePrefix,
    protonDir,
    extraBinds = [],
    extraRoBinds = [],
    homePersistDir,
    shareIpc = false,
  } = options;

  const home = env.HOME || "";
  const runtimeDir = env.XDG_RUNTIME_DIR || "";

  const bwrapArgs: string[] = [
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup",
  ];

  if (!shareIpc) {
    bwrapArgs.push("--unshare-ipc");
  }

  // Never --unshare-net: the game keeps full network access.
  bwrapArgs.push("--new-session");

  // Read-only system tree.
  bwrapArgs.push(
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // --dev already provides a small /dev/shm; give games a full-sized tmpfs.
    "--tmpfs",
    "/dev/shm"
  );

  // GPU access.
  if (isExistingPath("/dev/dri")) {
    bwrapArgs.push("--dev-bind", "/dev/dri", "/dev/dri");
  }

  for (const deviceName of listNvidiaDevices()) {
    const devicePath = path.join("/dev", deviceName);
    bwrapArgs.push("--dev-bind", devicePath, devicePath);
  }

  // /sys is required for GPU / device discovery. A whole-tree ro bind is
  // acceptable here.
  if (isExistingPath("/sys")) {
    bwrapArgs.push("--ro-bind", "/sys", "/sys");
  }

  // Wipe $HOME and the runtime dir, then re-create the directories. When a
  // persistent per-game home is provided, bind it over $HOME so saves and
  // shader caches survive; otherwise re-create an empty $HOME on the tmpfs.
  bwrapArgs.push("--tmpfs", "/home");
  if (home) {
    if (isExistingPath(homePersistDir)) {
      bwrapArgs.push("--bind", homePersistDir, home);
    } else {
      bwrapArgs.push("--dir", home);
    }
  }

  bwrapArgs.push("--tmpfs", "/run");
  if (runtimeDir) {
    bwrapArgs.push("--dir", runtimeDir);
  }

  // /etc/resolv.conf is a symlink into /run/systemd/resolve on systemd hosts;
  // re-expose it after the /run tmpfs so DNS keeps working.
  if (isExistingPath("/run/systemd/resolve")) {
    bwrapArgs.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  }

  // Read-write, 1:1 binds. These must come after the tmpfs mounts above so
  // paths located under $HOME re-appear inside the sandbox.
  const readWriteBinds: (string | null | undefined)[] = [
    gameDir,
    winePrefix,
    getUmuRuntimeDir(home),
    ...extraBinds,
  ];

  for (const target of readWriteBinds) {
    if (isExistingPath(target)) {
      bwrapArgs.push("--bind", target, target);
    }
  }

  // Read-only, 1:1 binds.
  const readOnlyBinds: (string | null | undefined)[] = [
    protonDir,
    ...extraRoBinds,
    env.XAUTHORITY,
    home ? path.join(home, ".Xauthority") : null,
    "/tmp/.X11-unix",
    home ? path.join(home, ".config", "MangoHud") : null,
  ];

  if (runtimeDir) {
    for (const socketName of listRuntimeSockets(runtimeDir)) {
      readOnlyBinds.push(path.join(runtimeDir, socketName));
    }
  }

  for (const target of readOnlyBinds) {
    if (isExistingPath(target)) {
      bwrapArgs.push("--ro-bind", target, target);
    }
  }

  bwrapArgs.push("--", command, ...args);

  return { command: BWRAP_PATH, args: bwrapArgs };
};
