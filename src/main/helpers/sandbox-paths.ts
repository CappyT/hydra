import fs from "node:fs";
import path from "node:path";
import { SandboxUnavailableError } from "../services/sandbox-command-builder";

export const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
const canonical = (value: string): string => {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(canonical(parent), path.basename(resolved));
  }
};

/** Removable media mounts (udisks, Steam Deck SD card) are game locations. */
const RUN_MEDIA = "/run/media";

const LAUNCHER_GAME_DIRS = [
  "sandbox-homes",
  "wine-prefixes",
  "wine-prefix",
  "Downloads",
];

/**
 * The only hidden home locations a game may get: the folders where the stores
 * keep games and prefixes. Their client trees stay out: the Steam root holds
 * the client binaries and `steam.pipe`, a command channel to the unsandboxed
 * client.
 */
const HIDDEN_HOME_GAME_DIRS = [
  ".wine",
  ".steam/steam/steamapps",
  ".steam/root/steamapps",
  ".local/share/Steam/steamapps",
  ".local/share/lutris",
  ".local/share/bottles/bottles",
  ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps",
  ".var/app/com.valvesoftware.Steam/data/Steam/steamapps",
];

/** Reject broad mounts and credential/tool roots, including symlink aliases. */
export const assertSafeSandboxPath = (
  target: string,
  home: string,
  userData: string,
  runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR
): void => {
  if (!path.isAbsolute(target) || target.includes("\0"))
    throw new SandboxUnavailableError("Sandbox paths must be absolute");
  let candidate: string;
  try {
    candidate = canonical(target);
  } catch {
    throw new SandboxUnavailableError(`Sandbox cannot resolve path: ${target}`);
  }
  if (candidate === path.parse(candidate).root)
    throw new SandboxUnavailableError(
      `Sandbox refuses the filesystem root: ${target}`
    );
  const hostHome = canonical(home);
  const data = canonical(userData);
  const runtime = runtimeDir ? canonical(runtimeDir) : null;
  // Runtime and kernel trees hold the session/system buses, display and agent
  // sockets and other processes' roots: never bind them or anything inside.
  const systemTrees = [
    ...["/proc", "/sys", "/dev"].map(canonical),
    ...(runtime ? [runtime] : []),
  ];
  const run = canonical("/run");
  if (
    systemTrees.some((tree) => within(tree, candidate)) ||
    (within(run, candidate) && !within(canonical(RUN_MEDIA), candidate))
  )
    throw new SandboxUnavailableError(
      `Sandbox refuses runtime or kernel path: ${target}`
    );
  const roots = [
    hostHome,
    data,
    path.join(data, "sandbox-homes"),
    path.join(data, "wine-prefixes"),
    path.join(data, "Downloads"),
    canonical("/tmp"),
    ...systemTrees,
    run,
  ];
  if (roots.some((root) => within(candidate, root)))
    throw new SandboxUnavailableError(
      `Sandbox refuses broad host directory: ${target}`
    );
  const secrets = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".mozilla",
    ".netrc",
    ".git-credentials",
    ".bashrc",
    ".profile",
    ".zshrc",
    ".local/bin",
    "bin",
    ".local/share/umu",
    ".local/share/lutris/runners",
    ".local/share/lutris/runtime",
    ".config/systemd",
    ".config/autostart",
    ".config/gh",
    ".config/rclone",
  ];
  if (
    secrets.some((item) => {
      const forbidden = canonical(path.join(hostHome, item));
      return within(forbidden, candidate) || within(candidate, forbidden);
    })
  )
    throw new SandboxUnavailableError(
      `Sandbox refuses sensitive host path: ${target}`
    );
  const launcherGameDirs = LAUNCHER_GAME_DIRS.map((item) =>
    path.join(data, item)
  );
  if (
    within(data, candidate) &&
    !launcherGameDirs.some((dir) => within(dir, candidate))
  ) {
    throw new SandboxUnavailableError(
      `Sandbox refuses launcher state: ${target}`
    );
  }
  // Hidden home entries hold shell, session and tool config a writable bind
  // could plant code in; a denylist cannot list them all.
  if (
    within(hostHome, candidate) &&
    path.relative(hostHome, candidate).startsWith(".") &&
    ![
      ...launcherGameDirs,
      ...HIDDEN_HOME_GAME_DIRS.map((item) =>
        canonical(path.join(hostHome, item))
      ),
    ].some((dir) => within(dir, candidate))
  ) {
    throw new SandboxUnavailableError(
      `Sandbox refuses hidden home path: ${target}`
    );
  }
};
