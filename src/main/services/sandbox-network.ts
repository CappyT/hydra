/**
 * Network isolation for the bwrap game sandbox, backed by pasta (the `passt`
 * package). Self-contained and electron/logger-free so the argv/preference
 * logic stays unit-testable in isolation, mirroring sandbox-seccomp.ts.
 *
 * ## Single-user-namespace design (podman-rootless style)
 * The obvious design — `bwrap --unshare-net` plus pasta attaching from outside —
 * does NOT work: the bwrap-created netns is owned by bwrap's user namespace and
 * pasta (in the init userns) gets EPERM on `setns()`. The previous fix — running
 * `pasta ... -- <game>` as the OUTERMOST command — worked for the network but
 * made pasta create a SECOND user namespace (uid 1000→0), which blocks nested
 * unprivileged user namespaces and crashes gamescope (glycin's nested bwrap) and
 * Proton's pressure-vessel. Verified on the host.
 *
 * Instead everything stays in bwrap's ONE user namespace. bwrap keeps the host
 * network namespace but is granted CAP_NET_ADMIN + CAP_SYS_ADMIN and runs an
 * in-sandbox wrapper (see NETWORK_ISOLATION_WRAPPER) that: opens a fresh netns
 * in the SAME userns (a placeholder process), services it with pasta in ATTACH
 * mode (`--netns`), then runs the game inside that netns with all capabilities
 * dropped. No second userns is ever created, so the game's own nested
 * unprivileged userns keep working. From the game's point of view: host loopback
 * services (CUPS, Discord RPC, dev servers) and the host X11 abstract socket
 * (netns-scoped) are unreachable, while internet + LAN still work through pasta's
 * NAT.
 *
 * The wrapper, the placeholder and pasta all live INSIDE bwrap's pid namespace,
 * so the bwrap wrapper stays the tracked process and Sandbox.killSandboxTree
 * reaps them together with the game (killing the pid-namespace init tears down
 * the whole tree); pasta additionally exits when the netns is released. No
 * orphan survives.
 */

import fs from "node:fs";
import path from "node:path";
import type { Game, UserPreferences } from "@types";

/**
 * Address the isolated sandbox's resolv.conf points at. It is a link-local
 * address routed to pasta's tap; pasta forwards its :53/:853 traffic to the
 * real host resolver (`--dns-host`). Chosen to not collide with any real
 * destination a game would legitimately reach.
 */
export const DNS_FORWARD_ADDRESS = "169.254.1.1";

/** pasta options that owns the game's network namespace and its DNS. */
export interface SandboxNetworkIsolationOptions {
  /** Absolute path to the pasta binary. */
  pastaPath: string;
  /**
   * When set, DNS is forwarded: the sandbox resolv.conf (bound from
   * `resolvConfSource` to `resolvConfDest`) points at `dnsForwardAddress` and
   * pasta relays those queries to `hostResolver`. All four are set together, or
   * all omitted (pasta falls back to its default DNS handling) when the host
   * resolver could not be determined.
   */
  dnsForwardAddress?: string;
  hostResolver?: string;
  resolvConfSource?: string;
  resolvConfDest?: string;
}

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let pastaPathCache: string | null | undefined;

/**
 * Resolves the pasta binary on PATH, cached for the process lifetime. Returns
 * the absolute path, or null when pasta (the `passt` package) is not installed.
 * Kept self-contained (a plain PATH scan) so this module has no cross-module
 * dependency and stays loadable by the ts-node test runner.
 */
export const resolvePastaPath = (): string | null => {
  if (pastaPathCache !== undefined) return pastaPathCache;

  const pathDirectories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const directory of pathDirectories) {
    const candidate = path.join(directory, "pasta");
    if (isExecutableFile(candidate)) {
      pastaPathCache = candidate;
      return pastaPathCache;
    }
  }

  pastaPathCache = null;
  return pastaPathCache;
};

/** True when pasta is available to provide the isolated network namespace. */
export const isNetworkIsolationAvailable = (): boolean =>
  resolvePastaPath() !== null;

/**
 * Preference logic for network isolation (tri-state, per-game wins over
 * global), mirroring {@link isSandboxEnabled}. This is only the ON/OFF wish:
 * callers AND it with the sandbox being enabled and pasta being available.
 *
 * Isolation is ON BY DEFAULT (opt-out, paranoia-first): an absent/unset global
 * preference means ENABLED; the user must explicitly set `disableNetworkIsolation`
 * to turn it off globally. A per-game `networkIsolationDisabled` override wins
 * over the global preference in either direction.
 */
export const isNetworkIsolationEnabled = (
  userPreferences: UserPreferences | null | undefined,
  game: Pick<Game, "networkIsolationDisabled"> | null | undefined
): boolean => {
  if (game?.networkIsolationDisabled === true) {
    return false;
  }

  if (game?.networkIsolationDisabled === false) {
    return true;
  }

  return userPreferences?.disableNetworkIsolation !== true;
};

/**
 * Resolves the path of the host's active resolv.conf, following the
 * `/etc/resolv.conf` symlink once. This is where the generated resolv.conf must
 * be bound inside the sandbox: binding the symlink target (rather than the
 * dangling `/etc/resolv.conf` symlink, whose /run target is wiped by the
 * sandbox tmpfs) is host-agnostic (systemd-resolved, NetworkManager, ...).
 */
export const resolveSandboxResolvConfDest = (): string => {
  try {
    if (fs.lstatSync("/etc/resolv.conf").isSymbolicLink()) {
      return path.resolve("/etc", fs.readlinkSync("/etc/resolv.conf"));
    }
  } catch {
    // No /etc/resolv.conf at all — fall back to the canonical path.
  }
  return "/etc/resolv.conf";
};

/**
 * Reads the first `nameserver` from the host's real resolv.conf, used as pasta's
 * `--dns-host` (the resolver pasta relays the sandbox's DNS queries to). Returns
 * null when it cannot be determined; the caller then skips DNS forwarding.
 */
export const resolveHostResolver = (): string | null => {
  try {
    const content = fs.readFileSync(fs.realpathSync("/etc/resolv.conf"), "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*nameserver\s+(\S+)/);
      if (match) return match[1];
    }
  } catch {
    // Unreadable / missing — caller falls back to pasta's default DNS handling.
  }
  return null;
};
