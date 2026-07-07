import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveLaunchCommand } from "./resolve-launch-command.ts";

describe("resolveLaunchCommand wrappers", () => {
  it("keeps single-string wrapper behavior (byte-identical shape)", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/games/game",
      baseArgs: ["--foo"],
      wrapperCommands: ["gamemoderun"],
    });

    assert.equal(resolved.command, "gamemoderun");
    assert.deepEqual(resolved.args, ["/games/game", "--foo"]);
  });

  it("composes gamemode, gamescope and mangohud in the correct nesting", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/games/game.x86_64",
      baseArgs: ["--foo"],
      wrapperCommands: [
        "gamemoderun",
        ["gamescope", "-f", "--"],
        "mangohud",
      ],
    });

    // reduceRight nests mangohud closest to the game, gamescope around it, and
    // gamemoderun outermost: `gamemoderun gamescope -f -- mangohud game --foo`.
    assert.equal(resolved.command, "gamemoderun");
    assert.deepEqual(resolved.args, [
      "gamescope",
      "-f",
      "--",
      "mangohud",
      "/games/game.x86_64",
      "--foo",
    ]);
  });

  it("inserts a multi-token wrapper's fixed args before the command", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/games/game",
      wrapperCommands: [["gamescope", "-f", "--"]],
    });

    assert.equal(resolved.command, "gamescope");
    assert.deepEqual(resolved.args, ["-f", "--", "/games/game"]);
  });

  it("dedups a single-string wrapper already at the front of the command", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/usr/bin/mangohud",
      baseArgs: ["/games/game"],
      wrapperCommands: ["mangohud"],
    });

    assert.equal(resolved.command, "/usr/bin/mangohud");
    assert.deepEqual(resolved.args, ["/games/game"]);
  });

  it("dedups a multi-token wrapper by its first token's basename", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/usr/bin/gamescope",
      baseArgs: ["-f", "--", "/games/game"],
      wrapperCommands: [["gamescope", "-f", "--"]],
    });

    assert.equal(resolved.command, "/usr/bin/gamescope");
    assert.deepEqual(resolved.args, ["-f", "--", "/games/game"]);
  });

  it("ignores empty wrapper entries", () => {
    const resolved = resolveLaunchCommand({
      baseCommand: "/games/game",
      wrapperCommands: ["", [], ["gamescope", "-f", "--"]],
    });

    assert.equal(resolved.command, "gamescope");
    assert.deepEqual(resolved.args, ["-f", "--", "/games/game"]);
  });
});
