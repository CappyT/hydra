import { logger } from "./logger";
import type { InPlaceExtractionResult } from "./native-addon";
import { Sandbox } from "./sandbox";
import {
  buildExtractionSandboxArgs,
  type ExtractionSandboxBind,
} from "./extraction-sandbox";
import { removeEscapingSymlinks } from "./extraction-symlinks";

export class ExtractionSandboxUnavailableError extends Error {
  code = "EXTRACTION_SANDBOX_UNAVAILABLE" as const;

  constructor() {
    super(
      "bubblewrap (bwrap) is not available, so 7-Zip cannot run sandboxed. " +
        "Install bubblewrap to extract archives."
    );
  }
}

export const removeEscapingSymlinksLogged = async (root: string) => {
  const removed = await removeEscapingSymlinks(root);
  if (removed.length > 0) {
    logger.warn(
      `Removed ${removed.length} symlink(s) that point outside ${root}`,
      removed
    );
  }
};

/**
 * Runs hatchzip, which creates archive symlinks without checking their
 * target, then removes the escaping ones. A cleanup error after hatchzip ran
 * becomes a failed result: thrown, it would read as "hatchzip did not run" and
 * send a partly consumed archive to 7-Zip.
 */
export const extractInPlaceWithoutEscapingSymlinks = async (
  outputPath: string,
  run: () => Promise<InPlaceExtractionResult>
): Promise<InPlaceExtractionResult> => {
  let result: InPlaceExtractionResult;
  try {
    result = await run();
  } catch (error) {
    // The 7-Zip fallback removes the links again before it runs.
    await removeEscapingSymlinksLogged(outputPath).catch((cleanupError) =>
      logger.error(`Could not check symlinks in ${outputPath}`, cleanupError)
    );
    throw error;
  }

  try {
    await removeEscapingSymlinksLogged(outputPath);
  } catch (error) {
    return {
      status: "failed",
      message: `could not check symlinks in ${outputPath}: ${error}`,
    };
  }

  return result;
};

/**
 * Returns a function that wraps one 7-Zip command in bwrap. Throws up front
 * when bwrap is missing on Linux: 7-Zip never runs unsandboxed there.
 */
export const createSevenZipSandbox = (options: {
  binds: ExtractionSandboxBind[];
  chdir: string;
}) => {
  if (process.platform !== "linux") {
    return (command: string, args: string[]) => ({ command, args });
  }

  if (!Sandbox.isAvailable()) throw new ExtractionSandboxUnavailableError();

  return (command: string, args: string[]) =>
    buildExtractionSandboxArgs(command, args, options);
};
