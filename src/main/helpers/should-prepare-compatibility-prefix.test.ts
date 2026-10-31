import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldPrepareCompatibilityPrefix } from "./should-prepare-compatibility-prefix.ts";

const decide = (
  overrides: Partial<Parameters<typeof shouldPrepareCompatibilityPrefix>[0]>
) =>
  shouldPrepareCompatibilityPrefix({
    v2AutomaticSync: false,
    managedEpic: false,
    localAutomaticSync: false,
    prefixExists: true,
    ...overrides,
  });

describe("shouldPrepareCompatibilityPrefix", () => {
  it("never prepares an existing prefix for the local automatic sync", () => {
    assert.equal(
      decide({ localAutomaticSync: true, prefixExists: true }),
      false
    );
  });

  it("prepares a missing prefix for the local automatic sync", () => {
    assert.equal(
      decide({ localAutomaticSync: true, prefixExists: false }),
      true
    );
  });

  it("does not prepare without any automatic sync", () => {
    assert.equal(decide({ prefixExists: false }), false);
  });

  it("keeps the v2 and managed Epic preparation unchanged", () => {
    assert.equal(decide({ v2AutomaticSync: true }), true);
    assert.equal(decide({ managedEpic: true }), true);
  });
});
