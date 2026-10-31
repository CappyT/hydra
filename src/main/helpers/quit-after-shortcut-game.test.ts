import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearQuitAfterGameExit,
  markQuitAfterGameExit,
  quitAfterGameExit,
  shouldQuitAfterGameExit,
} from "./quit-after-shortcut-game.ts";

describe("quit-after-shortcut-game", () => {
  afterEach(() => clearQuitAfterGameExit());

  it("matches only the marked game", () => {
    assert.equal(shouldQuitAfterGameExit("steam:1"), false);
    markQuitAfterGameExit("steam:1", () => {});
    assert.equal(shouldQuitAfterGameExit("steam:1"), true);
    assert.equal(shouldQuitAfterGameExit("steam:2"), false);
    clearQuitAfterGameExit();
    assert.equal(shouldQuitAfterGameExit("steam:1"), false);
  });

  it("does not quit for an unmarked game", async () => {
    let quits = 0;
    markQuitAfterGameExit("steam:1", () => quits++);

    assert.equal(await quitAfterGameExit("steam:2", []), false);
    assert.equal(quits, 0);
    assert.equal(shouldQuitAfterGameExit("steam:1"), true);
  });

  it("quits once, after the close work settled", async () => {
    const events: string[] = [];
    const record = (event: string) => {
      events.push(event);
    };
    markQuitAfterGameExit("steam:1", () => record("quit"));
    let releaseBackup: () => void = () => {};
    const backup = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    }).then(() => {
      record("backup-done");
    });
    const failing = Promise.reject(new Error("persist failed"));

    const pending = quitAfterGameExit("steam:1", [backup, failing, undefined]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 0);

    releaseBackup();
    assert.equal(await pending, true);
    assert.deepEqual(events, ["backup-done", "quit"]);
    assert.equal(await quitAfterGameExit("steam:1", []), false);
  });
});
