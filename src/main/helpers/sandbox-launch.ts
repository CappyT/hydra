import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Game, UserPreferences } from "@types";
import { Sandbox } from "@main/services/sandbox";
import { assertSandboxAvailable } from "@main/services/sandbox-command-builder";
import { buildSeccompFilter } from "@main/services/sandbox-seccomp";
import {
  DNS_FORWARD_ADDRESS,
  isNetworkIsolationAvailable,
  isNetworkIsolationEnabled,
  resolveHostResolver,
  resolvePastaPath,
  resolveSandboxResolvConfDest,
  type SandboxNetworkIsolationOptions,
} from "@main/services/sandbox-network";
import { logger } from "@main/services/logger";
import {
  sandboxHomesPath,
  sandboxMachineIdsPath,
  sandboxResolvConfPath,
  sandboxSeccompFilterPath,
} from "@main/constants";
import type { ResolvedLaunchCommand } from "./resolve-launch-command";

/**
 * Conventional spawn `stdio` index at which a sandboxed spawn must place the
 * opened seccomp filter fd. It becomes fd 3 in the child, which is what the
 * bwrap args request via `--seccomp 3`. The two MUST agree; keep them in sync
 * through this constant.
 */
export const SANDBOX_SECCOMP_FD = 3;

/** Extends a resolved launch command with the seccomp filter path a sandboxed
 *  spawn must open and place at {@link SANDBOX_SECCOMP_FD}. Absent when seccomp
 *  is disabled (globally or because the sandbox itself is off). */
export interface SandboxedLaunchCommand extends ResolvedLaunchCommand {
  seccompFilterPath?: string;
}

/** Anything a sandboxed spawn's stdio array may hold at index 0..3. */
type SeccompStdioEntry = "ignore" | "inherit" | "pipe" | number | null;

type SandboxGame = Pick<
  Game,
  | "sandboxDisabled"
  | "sandboxExtraPaths"
  | "sandboxShareIpc"
  | "networkIsolationDisabled"
>;

export interface SandboxLaunchContext {
  userPreferences?: UserPreferences | null;
  game?: SandboxGame | null;
  /**
   * Stable per-game identity (e.g. `levelKeys.game(shop, objectId)`). When
   * provided, a persistent per-game sandbox home is created and bound so native
   * saves and shader caches survive across launches. Callers without a game
   * identity omit it and fall back to the ephemeral home.
   */
  gameKey?: string | null;
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
  /**
   * Extra read-only paths required by this launch flavor (e.g. the bundled
   * umu-run zipapp under the AppImage mount, hidden by the /tmp tmpfs).
   */
  additionalRoBinds?: string[];
  /**
   * When true, the session X11 binds are omitted from the sandbox. Set by the
   * launch sites when gamescope wraps the launch on a Wayland session, so the
   * game only sees gamescope's private embedded Xwayland.
   */
  hideX11?: boolean;
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

const ensureWinePrefixDir = (winePrefix?: string | null) => {
  if (!winePrefix) return;

  try {
    fs.mkdirSync(winePrefix, { recursive: true });
  } catch (error) {
    logger.warn("Failed to ensure wine prefix dir for sandbox", error);
  }
};

/**
 * Sanitizes a per-game key (e.g. `levelKeys.game(shop, objectId)`) into a
 * filesystem-safe directory name. Shared so the sandbox home and any code that
 * needs to locate that home derive the same path.
 */
export const sanitizeSandboxGameKey = (gameKey: string): string =>
  gameKey.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Resolves (and creates) the persistent per-game sandbox home directory. Real
 * home stays hidden; the game sees this directory bound over $HOME.
 */
const ensureSandboxHome = (gameKey?: string | null): string | undefined => {
  if (!gameKey) return undefined;

  const sanitized = sanitizeSandboxGameKey(gameKey);
  const homePersistDir = path.join(sandboxHomesPath, sanitized);

  try {
    fs.mkdirSync(homePersistDir, { recursive: true });
    return homePersistDir;
  } catch (error) {
    logger.warn("Failed to ensure sandbox home dir", error);
    return undefined;
  }
};

/**
 * Writes (and returns the path to) a per-game fake `/etc/machine-id`. The value
 * is a deterministic hash of the game key rendered as 32 lowercase hex chars +
 * newline (the machine-id format): stable per game so the game is not confused
 * by an id changing under it, yet different across games so two titles cannot
 * correlate to a single host fingerprint. Guards fs errors like
 * ensureSandboxHome: on failure the launch simply keeps the host machine-id.
 */
const ensureSandboxMachineId = (
  gameKey?: string | null
): string | undefined => {
  if (!gameKey) return undefined;

  const sanitized = sanitizeSandboxGameKey(gameKey);
  const machineIdFile = path.join(sandboxMachineIdsPath, sanitized);

  try {
    const fakeMachineId =
      crypto.createHash("sha256").update(gameKey).digest("hex").slice(0, 32) +
      "\n";

    fs.mkdirSync(sandboxMachineIdsPath, { recursive: true });
    fs.writeFileSync(machineIdFile, fakeMachineId);
    return machineIdFile;
  } catch (error) {
    logger.warn("Failed to write sandbox machine-id", error);
    return undefined;
  }
};

let cachedSeccompFilterPath: string | null = null;

/**
 * Writes the compiled seccomp cBPF filter to its cached file under userData and
 * returns the path, or undefined on failure. Written once per process so an app
 * update always refreshes the filter, then memoized. On failure the launch
 * proceeds WITHOUT `--seccomp` (the path is undefined, so no fd is wired and no
 * `--seccomp` flag is emitted): seccomp is a hardening layer, not the sandbox
 * boundary, so a write failure must not block launches.
 */
const ensureSeccompFilterFile = (): string | undefined => {
  if (cachedSeccompFilterPath) return cachedSeccompFilterPath;

  try {
    fs.mkdirSync(path.dirname(sandboxSeccompFilterPath), { recursive: true });
    fs.writeFileSync(sandboxSeccompFilterPath, buildSeccompFilter());
    cachedSeccompFilterPath = sandboxSeccompFilterPath;
    return cachedSeccompFilterPath;
  } catch (error) {
    logger.warn("Failed to write seccomp filter, launching without it", error);
    return undefined;
  }
};

/** The seccomp filter is attached only when the global kill-switch is unset.
 *  (Gated together with the sandbox being enabled at the call site.) */
const isSeccompEnabled = (
  userPreferences: UserPreferences | null | undefined
): boolean => userPreferences?.disableSeccomp !== true;

let cachedResolvConfPath: string | null = null;

/**
 * Writes (once per process) the generated resolv.conf bound into isolated
 * sandboxes and returns its path, or undefined on failure. The single
 * `nameserver` is pasta's DNS-forward address; pasta relays those queries to
 * the real host resolver. On failure the caller drops the resolv.conf override
 * (and the DNS-forward), so pasta falls back to its own DNS handling.
 */
const ensureSandboxResolvConf = (): string | undefined => {
  if (cachedResolvConfPath) return cachedResolvConfPath;

  try {
    fs.mkdirSync(path.dirname(sandboxResolvConfPath), { recursive: true });
    fs.writeFileSync(
      sandboxResolvConfPath,
      `nameserver ${DNS_FORWARD_ADDRESS}\noptions edns0\n`
    );
    cachedResolvConfPath = sandboxResolvConfPath;
    return cachedResolvConfPath;
  } catch (error) {
    logger.warn("Failed to write sandbox resolv.conf", error);
    return undefined;
  }
};

let loggedPastaMissing = false;

/**
 * Resolves the network-isolation options for a sandboxed launch, or undefined
 * when the game should keep the host network namespace. Isolation applies when
 * it is not disabled (globally or per game) AND pasta is available. When pasta
 * is desired but missing, logs once and returns undefined (the game launches
 * with the host network, the previous behavior).
 */
const resolveNetworkIsolation = (
  userPreferences: UserPreferences | null | undefined,
  game: SandboxGame | null | undefined
): SandboxNetworkIsolationOptions | undefined => {
  if (!isNetworkIsolationEnabled(userPreferences, game)) return undefined;

  const pastaPath = resolvePastaPath();
  if (!pastaPath || !isNetworkIsolationAvailable()) {
    if (!loggedPastaMissing) {
      loggedPastaMissing = true;
      logger.warn(
        "Network isolation is enabled but pasta (passt) is not available; " +
          "launching with the host network namespace. Install passt to isolate."
      );
    }
    return undefined;
  }

  // Determine the host resolver up front (before the sandbox overlays its own
  // resolv.conf). When known, forward DNS through pasta; otherwise fall back to
  // pasta's default DNS handling with no override.
  const hostResolver = resolveHostResolver();
  const resolvConfSource = hostResolver ? ensureSandboxResolvConf() : undefined;

  return {
    pastaPath,
    ...(hostResolver && resolvConfSource
      ? {
          dnsForwardAddress: DNS_FORWARD_ADDRESS,
          hostResolver,
          resolvConfSource,
          resolvConfDest: resolveSandboxResolvConfDest(),
        }
      : {}),
  };
};

/**
 * Opens the compiled seccomp filter for a sandboxed spawn. Returns the fd to
 * place at {@link SANDBOX_SECCOMP_FD} (via {@link withSeccompStdio}), or null
 * when the launch carries no filter. The caller MUST release the fd with
 * {@link closeSeccompFd} after the spawn — the child inherits its own dup, so
 * closing the parent's copy is safe once `spawn` has returned.
 */
export const openSeccompFd = (
  launch: Pick<SandboxedLaunchCommand, "seccompFilterPath">
): number | null => {
  if (!launch.seccompFilterPath) return null;

  try {
    return fs.openSync(launch.seccompFilterPath, "r");
  } catch (error) {
    // The bwrap args already carry `--seccomp <fd>`; without the fd bwrap fails
    // and the game does not launch. This is a rare fs race and fails closed.
    logger.error("Failed to open seccomp filter fd", error);
    return null;
  }
};

/**
 * Appends the opened seccomp fd at {@link SANDBOX_SECCOMP_FD} of a spawn stdio
 * array so it becomes fd 3 in the child (matching bwrap's `--seccomp 3`).
 * Returns `base` unchanged when there is no fd. `base` must be the leading
 * stdio triple (stdin/out/err); the seccomp fd is appended as the fourth entry.
 */
export const withSeccompStdio = (
  base: [SeccompStdioEntry, SeccompStdioEntry, SeccompStdioEntry],
  seccompFd: number | null
): SeccompStdioEntry[] => (seccompFd === null ? base : [...base, seccompFd]);

/** Closes a seccomp fd opened by {@link openSeccompFd}. No-op for null. Call
 *  exactly once per fd (guard double-calls via try/finally at the call site) so
 *  a reused fd number is never closed twice. */
export const closeSeccompFd = (fd: number | null): void => {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed / invalid — ignore.
  }
};

/**
 * Wraps an already-resolved launch command inside the bubblewrap sandbox when
 * the sandbox is enabled (globally by default, unless disabled). Throws
 * SandboxUnavailableError when the sandbox is enabled but bwrap is missing, so
 * that no launch silently escapes the sandbox. When the sandbox is enabled and
 * seccomp is not disabled, the result also carries `seccompFilterPath`: the
 * caller must open it and place the fd at {@link SANDBOX_SECCOMP_FD} in its
 * spawn (see {@link openSeccompFd} / {@link withSeccompStdio}).
 */
export const wrapWithSandbox = (
  resolved: ResolvedLaunchCommand,
  context: SandboxLaunchContext
): SandboxedLaunchCommand => {
  const {
    userPreferences,
    game,
    gameKey,
    gameDir,
    winePrefix,
    protonDir,
    additionalBinds = [],
    additionalRoBinds = [],
    hideX11 = false,
  } = context;

  const sandboxEnabled = Sandbox.isEnabled(userPreferences, game);
  if (!sandboxEnabled) {
    return resolved;
  }

  // Fail closed: never let a launch escape the sandbox when bwrap is missing.
  assertSandboxAvailable(sandboxEnabled, Sandbox.isAvailable());

  ensureUmuRuntimeDir();
  // On a first launch the wine prefix dir does not exist yet; create it before
  // binding so Proton writes the prefix (saves, achievements) to the host and
  // not into the sandbox tmpfs.
  ensureWinePrefixDir(winePrefix);

  const homePersistDir = ensureSandboxHome(gameKey);
  const machineIdFile = ensureSandboxMachineId(gameKey);

  // Attach the seccomp filter unless the global kill-switch is set. Build the
  // filter file first so the `--seccomp` flag is only emitted when the fd will
  // actually be available at spawn time (args and fd stay in agreement).
  const seccompFilterPath = isSeccompEnabled(userPreferences)
    ? ensureSeccompFilterFile()
    : undefined;

  const networkIsolation = resolveNetworkIsolation(userPreferences, game);

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
    extraRoBinds: additionalRoBinds,
    homePersistDir,
    shareIpc: game?.sandboxShareIpc === true,
    hideX11,
    machineIdFile,
    seccompFd: seccompFilterPath ? SANDBOX_SECCOMP_FD : undefined,
    networkIsolation,
  });

  return {
    command,
    args,
    env: resolved.env,
    seccompFilterPath,
  };
};
