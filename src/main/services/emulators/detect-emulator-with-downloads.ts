import {
  detectEmulator,
  type DetectableBinary,
  type DetectionResult,
} from "./detect-emulator.js";
import { getEmulatorInstallRoot } from "./emulator-install-root.js";

export const detectEmulatorWithDownloads = async (
  binary: DetectableBinary,
  options?: { resolveVersion?: boolean }
): Promise<DetectionResult | null> => {
  // Fork: emulators install under a launcher-owned root. Download dirs are
  // never searched: any download can occupy `<downloads>/<EmulatorName>`, and
  // detection runs the found binary unsandboxed.
  return detectEmulator(binary, {
    resolveVersion: options?.resolveVersion,
    downloadDirectories: [getEmulatorInstallRoot()],
  });
};
