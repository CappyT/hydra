import fs from "node:fs";

import { defaultDownloadsPath } from "@main/constants";
import { db, levelKeys } from "@main/level";
import type { UserPreferences } from "@types";

export const getDownloadsPath = async () => {
  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    {
      valueEncoding: "json",
    }
  );

  if (userPreferences?.downloadsPath) return userPreferences.downloadsPath;

  // Unlike the system Downloads folder, the launcher-owned default may not
  // exist yet — create it before anything tries to write into it.
  fs.mkdirSync(defaultDownloadsPath, { recursive: true });

  return defaultDownloadsPath;
};
