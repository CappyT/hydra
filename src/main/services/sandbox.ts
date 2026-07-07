import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { Game, UserPreferences } from "@types";
import { logger } from "./logger";
import {
  BWRAP_PATH,
  buildSandboxArgs,
  isSandboxEnabled,
  type SandboxWrapOptions,
} from "./sandbox-command-builder";

export type { SandboxWrapOptions };

export class SandboxUnavailableError extends Error {
  code = "SANDBOX_UNAVAILABLE" as const;

  constructor() {
    super(
      "bubblewrap (bwrap) is not available, but the sandbox is enabled. " +
        "Install bubblewrap or disable the sandbox to launch this game."
    );
  }
}

export class Sandbox {
  private static availabilityCache: boolean | null = null;

  /**
   * Probes for a working bwrap binary. The result is cached for the lifetime of
   * the process.
   */
  public static isAvailable(): boolean {
    if (this.availabilityCache !== null) {
      return this.availabilityCache;
    }

    if (process.platform !== "linux" || !fs.existsSync(BWRAP_PATH)) {
      this.availabilityCache = false;
      return false;
    }

    try {
      const result = spawnSync(BWRAP_PATH, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
      });
      this.availabilityCache = result.status === 0;
    } catch {
      this.availabilityCache = false;
    }

    return this.availabilityCache;
  }

  public static isEnabled(
    userPreferences: UserPreferences | null | undefined,
    game: Pick<Game, "sandboxDisabled"> | null | undefined
  ): boolean {
    return isSandboxEnabled(userPreferences, game);
  }

  /**
   * Tears down a sandboxed launch started from the given bwrap wrapper pid.
   *
   * A sandboxed payload runs with `--unshare-pid` and `--new-session`, so it
   * setsid()s into its own process group inside a private pid namespace and
   * bwrap does not use `--die-with-parent` (games survive launcher exit).
   * Killing the wrapper's process group therefore leaves the pid-namespace
   * init (and the game under it) alive. To reliably reap the whole tree we
   * first SIGKILL bwrap's direct children, which are the pid-namespace init
   * processes: killing a namespace's init makes the kernel kill every process
   * inside that namespace. We then kill the wrapper's group and the wrapper
   * itself. ESRCH and read failures are ignored — this is best effort and the
   * caller falls back to a per-process scan.
   */
  public static killSandboxTree(pid: number): void {
    try {
      const childrenRaw = fs.readFileSync(
        `/proc/${pid}/task/${pid}/children`,
        "utf8"
      );

      const childPids = childrenRaw
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((childPid) => Number.isInteger(childPid) && childPid > 0);

      for (const childPid of childPids) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // ESRCH / already gone — ignore.
        }
      }
    } catch (error) {
      logger.warn("Failed to read sandbox children for kill", error);
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH / already gone — ignore.
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH / already gone — ignore.
    }
  }

  /**
   * Builds a bwrap command that wraps the given command/args inside an isolated
   * sandbox and logs the full invocation for debugging.
   */
  public static wrapCommand(options: SandboxWrapOptions): {
    command: string;
    args: string[];
  } {
    const wrapped = buildSandboxArgs(options);

    logger.info("Wrapping launch command with bubblewrap sandbox", {
      command: wrapped.command,
      args: wrapped.args,
    });

    return wrapped;
  }
}
