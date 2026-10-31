import path from "node:path";

import { SystemPath } from "../system-path";

/**
 * Launcher-owned root for emulators that Hydra installs:
 * `<userData>/emulators/<displayName>`. Game downloads never write here, so a
 * download cannot plant an executable that emulator detection runs and the
 * classics/RetroArch launch then spawns outside the sandbox.
 */
export const getEmulatorInstallRoot = (): string =>
  path.join(SystemPath.getPath("userData"), "emulators");
