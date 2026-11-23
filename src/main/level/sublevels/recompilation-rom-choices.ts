import { db } from "../level";
import { levelKeys } from "./keys";

/**
 * The ROM picked for each recompiled port, keyed by its install folder. It
 * lives in the launcher's database, not in the folder: the sandboxed port can
 * write its folder, and the choice steers launcher-side binds and copies.
 */
export const recompilationRomChoicesSublevel = db.sublevel<string, unknown>(
  levelKeys.recompilationRomChoices,
  {
    valueEncoding: "json",
  }
);
