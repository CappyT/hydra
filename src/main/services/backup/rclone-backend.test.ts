import assert from "node:assert/strict";
import { it } from "node:test";
import { rcloneRemoteBase } from "./rclone-remote-path.ts";

it("joins an rclone remote without creating absolute or doubled paths", () => {
  assert.equal(rcloneRemoteBase("myremote:games"), "myremote:games/");
  assert.equal(rcloneRemoteBase("myremote:games/"), "myremote:games/");
  assert.equal(rcloneRemoteBase("myremote:"), "myremote:");
  assert.equal(rcloneRemoteBase("/srv/saves"), "/srv/saves/");
  assert.equal(`${rcloneRemoteBase("myremote:")}steam-1`, "myremote:steam-1");
});
