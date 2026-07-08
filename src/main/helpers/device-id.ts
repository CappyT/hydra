import fs from "node:fs";
import crypto from "node:crypto";
import { deviceIdPath } from "@main/constants";
import { logger } from "@main/services/logger";

/**
 * In-process memoized device id so we hit the filesystem at most once.
 */
let cachedDeviceId: string | null = null;

/**
 * Returns this installation's stable device id, used to tell save backups apart
 * across machines (Steam-Cloud-like device identity).
 *
 * The id is a random `crypto.randomUUID()` persisted at `<userData>/device-id`
 * on first use. It is deliberately RANDOM, never derived from hardware or the
 * hostname: it is launcher-only metadata and is never exposed to games, so it
 * must not become a fingerprint. Legacy artifacts without a device id simply
 * compare unequal to this value, which is safe.
 */
export const getDeviceId = (): string => {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    if (fs.existsSync(deviceIdPath)) {
      const existing = fs.readFileSync(deviceIdPath, "utf8").trim();
      if (existing) {
        cachedDeviceId = existing;
        return cachedDeviceId;
      }
    }
  } catch (error) {
    logger.error("Failed to read device id, regenerating", { error });
  }

  const generated = crypto.randomUUID();

  try {
    fs.writeFileSync(deviceIdPath, generated);
  } catch (error) {
    // If persistence fails we still return the generated id for this run so
    // the caller keeps working; it just won't be stable across restarts.
    logger.error("Failed to persist device id", { error });
  }

  cachedDeviceId = generated;
  return cachedDeviceId;
};
