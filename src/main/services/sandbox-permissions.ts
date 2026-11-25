/**
 * Sandbox permissions: resources a game may need but does not get by default.
 * Electron-free and type-only imports, so it stays unit-testable.
 */
import type { Game, UserPreferences } from "@types";

export const SANDBOX_PERMISSIONS = [
  "allowLocalNetwork",
  "allowMicrophone",
  "allowCamera",
] as const;

export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];

export type SandboxPermissions = Record<SandboxPermission, boolean>;

export const isSandboxPermission = (
  value: unknown
): value is SandboxPermission =>
  SANDBOX_PERMISSIONS.includes(value as SandboxPermission);

/** Per-game value wins in both directions; absent everywhere means denied. */
export const resolveSandboxPermissions = (
  userPreferences: Pick<UserPreferences, SandboxPermission> | null | undefined,
  game: Pick<Game, SandboxPermission> | null | undefined
): SandboxPermissions => {
  const resolve = (permission: SandboxPermission): boolean =>
    typeof game?.[permission] === "boolean"
      ? game[permission] === true
      : userPreferences?.[permission] === true;

  return {
    allowLocalNetwork: resolve("allowLocalNetwork"),
    allowMicrophone: resolve("allowMicrophone"),
    allowCamera: resolve("allowCamera"),
  };
};
