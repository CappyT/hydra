import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAchievementNotificationInfo } from "./build-achievement-notification-info.ts";
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

describe("buildAchievementNotificationInfo", () => {
  it("uses metadata (displayName/icon/points) when available", () => {
    const [info] = buildAchievementNotificationInfo(
      [{ name: "ach_one", unlockTime: 1 }],
      [steamAchievement],
      0
    );

    assert.equal(info.title, "First Blood");
    assert.equal(info.iconUrl, "https://cdn.example.com/ach_one.jpg");
    assert.equal(info.points, 100);
    assert.equal(info.isHidden, false);
  });

  it("falls back to the raw name when metadata is missing entirely", () => {
    const result = buildAchievementNotificationInfo(
      [{ name: "ACH_UNKNOWN", unlockTime: 1 }],
      [],
      0
    );

    assert.equal(result.length, 1);
    const [info] = result;
    assert.equal(info.title, "ACH_UNKNOWN");
    assert.equal(info.iconUrl, "");
    assert.equal(info.points, undefined);
    assert.equal(info.isHidden, false);
    assert.equal(info.isRare, false);
    // Never mark platinum when the total achievement count is unknown.
    assert.equal(info.isPlatinum, false);
  });

  it("falls back to the raw name for achievements missing from metadata while keeping matched ones", () => {
    const result = buildAchievementNotificationInfo(
      [
        { name: "ACH_ONE", unlockTime: 1 },
        { name: "ACH_MISSING", unlockTime: 2 },
      ],
      [steamAchievement],
      0
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].title, "First Blood");
    assert.equal(result[1].title, "ACH_MISSING");
    assert.equal(result[1].iconUrl, "");
  });

  it("marks the final achievement platinum once every achievement is unlocked", () => {
    const second: SteamAchievement = {
      ...steamAchievement,
      name: "ACH_TWO",
      displayName: "Second",
    };

    const result = buildAchievementNotificationInfo(
      [
        { name: "ACH_ONE", unlockTime: 1 },
        { name: "ACH_TWO", unlockTime: 2 },
      ],
      [steamAchievement, second],
      0
    );

    assert.equal(result[0].isPlatinum, false);
    assert.equal(result[1].isPlatinum, true);
  });
});
