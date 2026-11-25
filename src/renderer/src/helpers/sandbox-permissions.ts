import type { Game, UserPreferences } from "@types";

export const SANDBOX_PERMISSIONS = [
  "allowLocalNetwork",
  "allowMicrophone",
  "allowCamera",
] as const;

export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];

/** Per-game control value: "default" follows the global preference. */
export type SandboxPermissionChoice = "default" | "allow" | "block";

export const SANDBOX_PERMISSION_CHOICES: SandboxPermissionChoice[] = [
  "default",
  "allow",
  "block",
];

/** i18n key stem of each permission in the `game_details` namespace. */
export const SANDBOX_PERMISSION_KEYS: Record<SandboxPermission, string> = {
  allowLocalNetwork: "permission_local_network",
  allowMicrophone: "permission_microphone",
  allowCamera: "permission_camera",
};

/** i18n key stem of each global default in the `settings` namespace. */
export const SANDBOX_PERMISSION_SETTINGS_KEYS: Record<
  SandboxPermission,
  string
> = {
  allowLocalNetwork: "allow_local_network",
  allowMicrophone: "allow_microphone",
  allowCamera: "allow_camera",
};

export function toSandboxPermissionChoice(
  value: boolean | null | undefined
): SandboxPermissionChoice {
  if (value === true) return "allow";
  if (value === false) return "block";
  return "default";
}

export function fromSandboxPermissionChoice(
  choice: SandboxPermissionChoice
): boolean | null {
  if (choice === "allow") return true;
  if (choice === "block") return false;
  return null;
}

export function getSandboxPermissionValues(
  source: Pick<Game, SandboxPermission> | null | undefined
): Record<SandboxPermission, boolean | null> {
  return {
    allowLocalNetwork: source?.allowLocalNetwork ?? null,
    allowMicrophone: source?.allowMicrophone ?? null,
    allowCamera: source?.allowCamera ?? null,
  };
}

export function getSandboxPermissionDefaults(
  preferences: Pick<UserPreferences, SandboxPermission> | null | undefined
): Record<SandboxPermission, boolean> {
  return {
    allowLocalNetwork: preferences?.allowLocalNetwork === true,
    allowMicrophone: preferences?.allowMicrophone === true,
    allowCamera: preferences?.allowCamera === true,
  };
}
