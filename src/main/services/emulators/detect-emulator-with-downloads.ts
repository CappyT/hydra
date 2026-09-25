import path from "node:path";

import { getDownloadsPath } from "../../events/helpers/get-downloads-path.js";
import {
  detectEmulator,
  type DetectableBinary,
  type DetectionResult,
} from "./detect-emulator.js";

export const detectEmulatorWithDownloads = async (
  binary: DetectableBinary,
  options?: { resolveVersion?: boolean }
): Promise<DetectionResult | null> => {
  const configuredDownloads = await getDownloadsPath().catch(() => null);
  // Emulators install under the configured downloads dir; the user's
  // ~/Downloads holds arbitrary untrusted files.
  const downloadDirectories = Array.from(
    new Set(
      [configuredDownloads]
        .filter((directory): directory is string => Boolean(directory))
        .map((directory) => path.normalize(directory))
    )
  );

  return detectEmulator(binary, {
    resolveVersion: options?.resolveVersion,
    downloadDirectories,
  });
};
