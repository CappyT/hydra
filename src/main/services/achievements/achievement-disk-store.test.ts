import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createKeyedSerializer,
  parseGameKey,
} from "./achievement-disk-store.ts";

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

describe("achievement disk store write ordering", () => {
  it("lands the last overlapping write for a key on disk", async () => {
    const serialize = createKeyedSerializer();
    const disk = new Map<string, string>();
    const delays = [30, 0];

    // A fake level put: the older write takes longer, so without
    // serialization it would finish last and overwrite the newer one.
    const put = (key: string, value: string, delay: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      disk.set(key, value);
    };

    await Promise.all([
      serialize("steam:1", put("steam:1", "old", delays[0])),
      serialize("steam:1", put("steam:1", "new", delays[1])),
    ]);

    assert.equal(disk.get("steam:1"), "new");
  });

  it("keeps writing after a failed write and does not block other keys", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];

    const failing = serialize("steam:1", async () => {
      throw new Error("disk full");
    });
    const next = serialize("steam:1", async () => {
      order.push("steam:1");
    });
    const other = serialize("steam:2", async () => {
      order.push("steam:2");
    });

    await assert.rejects(failing, /disk full/);
    await Promise.all([next, other]);

    assert.deepEqual(order.sort(), ["steam:1", "steam:2"]);
  });
});
