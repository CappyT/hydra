import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGameKey } from "./achievement-disk-store.ts";

describe("achievement disk store key parsing", () => {
  it("splits a level key into shop and objectId", () => {
    assert.deepEqual(parseGameKey("steam:367520"), {
      shop: "steam",
      objectId: "367520",
    });
  });

  it("keeps separators inside the objectId", () => {
    assert.deepEqual(parseGameKey("custom:uuid:with:colons"), {
      shop: "custom",
      objectId: "uuid:with:colons",
    });
  });

  it("rejects malformed keys", () => {
    assert.equal(parseGameKey("steam:"), null);
    assert.equal(parseGameKey(":367520"), null);
    assert.equal(parseGameKey("no-separator"), null);
  });
});
