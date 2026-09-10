import fs from "node:fs";
import path from "node:path";

const within = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent + path.sep);
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

/** Reject broad mounts and credential/tool roots, including symlink aliases. */
export const assertSafeSandboxPath = (
  target: string,
  home: string,
  userData: string
): void => {
  if (!path.isAbsolute(target) || target.includes("\0"))
    throw new Error("Sandbox paths must be absolute");
  const candidate = canonical(target);
  const hostHome = canonical(home);
  const data = canonical(userData);
  const roots = [
    hostHome,
    data,
    path.join(data, "sandbox-homes"),
    path.join(data, "wine-prefixes"),
    path.join(data, "Downloads"),
  ];
  if (roots.some((root) => within(candidate, root)))
    throw new Error(`Sandbox refuses broad host directory: ${target}`);
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
    ".local/share/umu",
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
    throw new Error(`Sandbox refuses sensitive host path: ${target}`);
  if (
    within(data, candidate) &&
    !["sandbox-homes", "wine-prefixes", "wine-prefix", "Downloads"].some(
      (item) => within(path.join(data, item), candidate)
    )
  ) {
    throw new Error(`Sandbox refuses launcher state: ${target}`);
  }
};
