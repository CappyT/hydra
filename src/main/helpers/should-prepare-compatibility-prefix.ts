/**
 * Whether the launch must create or repair the Wine prefix on the host before
 * a save sync-in. The local automatic sync prepares only a prefix that does
 * not exist yet: umu/wineboot runs unsandboxed, and an existing prefix is game
 * writable (a planted RunOnce key or DLL would run outside the sandbox).
 */
export const shouldPrepareCompatibilityPrefix = (params: {
  v2AutomaticSync: boolean;
  managedEpic: boolean;
  localAutomaticSync: boolean;
  prefixExists: boolean;
}): boolean =>
  params.v2AutomaticSync ||
  params.managedEpic ||
  (params.localAutomaticSync && !params.prefixExists);
