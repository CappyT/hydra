import assert from "node:assert/strict";
import { it } from "node:test";
import {
  assertArtifactId,
  assertStorageComponent,
  validateArtifact,
} from "./artifact-validation.ts";
it("rejects traversal identifiers and metadata for a different game", () => {
  for (const name of ["..", "../../state", "/tmp/file", "", "a/b", "a\\b"])
    assert.throws(() => assertStorageComponent(name));
  assert.throws(() => assertArtifactId("../../state"));
  const artifact = {
    id: "00000000-0000-4000-8000-000000000000",
    shop: "steam",
    objectId: "123",
    homeDir: "C:/users/player",
    winePrefixPath: null,
  };
  assert.doesNotThrow(() =>
    validateArtifact(artifact as never, "steam", "123")
  );
  assert.throws(() => validateArtifact(artifact as never, "steam", "456"));
  assert.throws(() => validateArtifact({ ...artifact, homeDir: {} } as never));
});
