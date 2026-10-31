import assert from "node:assert/strict";
import { it } from "node:test";
import { rcloneRemoteBase } from "./rclone-remote-path.ts";

it("joins an rclone remote keeping the legacy absolute form for a bare remote", () => {
  assert.equal(rcloneRemoteBase("myremote:games"), "myremote:games/");
  assert.equal(rcloneRemoteBase("myremote:games/"), "myremote:games/");
  assert.equal(rcloneRemoteBase("myremote:"), "myremote:/");
  assert.equal(rcloneRemoteBase("/srv/saves"), "/srv/saves/");
  assert.equal(`${rcloneRemoteBase("myremote:")}steam-1`, "myremote:/steam-1");
});
