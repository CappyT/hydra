import type { LocalArtifact } from "@types";

export const assertStorageComponent = (value: string): void => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
    throw new Error("Invalid backup identifier");
};
export const assertArtifactId = (value: string): void => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value
    )
  )
    throw new Error("Invalid artifact id");
};
export const validateArtifact = (
  artifact: LocalArtifact,
  shop?: string,
  objectId?: string
): LocalArtifact => {
  if (!artifact || typeof artifact !== "object")
    throw new Error("Invalid backup metadata");
  assertArtifactId(artifact.id);
  assertStorageComponent(artifact.shop);
  assertStorageComponent(artifact.objectId);
  if (
    (shop && artifact.shop !== shop) ||
    (objectId && artifact.objectId !== objectId)
  )
    throw new Error("Backup game identity mismatch");
  if (
    typeof artifact.homeDir !== "string" ||
    (artifact.winePrefixPath != null &&
      typeof artifact.winePrefixPath !== "string")
  )
    throw new Error("Invalid backup paths");
  return artifact;
};
