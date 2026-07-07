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
