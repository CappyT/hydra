import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveNotifiedAchievements } from "./notified-achievements.ts";
import type { SteamAchievement } from "@types";

const steamAchievement: SteamAchievement = {
  name: "ACH_ONE",
  displayName: "First Blood",
  description: "Win your first match",
  icon: "https://cdn.example.com/ach_one.jpg",
  icongray: "https://cdn.example.com/ach_one_gray.jpg",
  hidden: false,
  points: 100,
};

describe("resolveNotifiedAchievements", () => {
  it("uses the metadata when it is available", () => {
    const [achievement] = resolveNotifiedAchievements(
      [{ name: "ach_one", unlockTime: 1 }],
      [steamAchievement]
    );

    assert.equal(achievement, steamAchievement);
  });

  it("keeps an unlock without metadata under its raw name", () => {
    const result = resolveNotifiedAchievements(
      [{ name: "ACH_UNKNOWN", unlockTime: 1 }],
      []
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].displayName, "ACH_UNKNOWN");
    assert.equal(result[0].icon, "");
    assert.equal(result[0].points, undefined);
    assert.equal(result[0].hidden, false);
  });

  it("keeps matched and unmatched unlocks in unlock order", () => {
    const result = resolveNotifiedAchievements(
      [
        { name: "ACH_MISSING", unlockTime: 2 },
        { name: "ACH_ONE", unlockTime: 1 },
      ],
      [steamAchievement]
    );

    assert.deepEqual(
      result.map((achievement) => achievement.displayName),
      ["First Blood", "ACH_MISSING"]
    );
  });
});
