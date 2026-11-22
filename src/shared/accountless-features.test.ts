import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterAccountlessFeatures } from "./accountless-features.js";

describe("filterAccountlessFeatures", () => {
  it("drops account-only flags and keeps anonymous ones", () => {
    assert.deepEqual(
      filterAccountlessFeatures([
        "SCREENSHOTS",
        "SCREENSHOT_COMMENTS",
        "GLOBAL_LEADERBOARDS",
        "MULTIPART_HOSTER_DOWNLOADS",
        "LEADERBOARD_WRITES",
      ]),
      ["SCREENSHOTS", "MULTIPART_HOSTER_DOWNLOADS"]
    );
  });

  it("passes a non-array response through unchanged", () => {
    assert.equal(filterAccountlessFeatures(null), null);
  });
});
