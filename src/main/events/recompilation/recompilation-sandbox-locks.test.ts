import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  assertSandboxCanStart,
  RecompilationSandboxBusyError,
  trackLiveSandbox,
  whileSandboxQuiet,
} from "./recompilation-sandbox-locks.ts";

const install = "/data/recompilations/port";
const bind = "/home/u/.config/port";

// A failed spawn leaves pid undefined.
const fakeChild = (spawned = true) =>
  Object.assign(new EventEmitter(), {
    pid: spawned ? 4242 : undefined,
  }) as unknown as ChildProcess;

describe("recompilation sandbox locks", () => {
  it("refuses to sanitize a folder a live sandbox can write", async () => {
    const child = fakeChild();
    trackLiveSandbox(child, [install, bind]);

    await assert.rejects(
      whileSandboxQuiet([`${bind}/CUSA00001`], async () => {}),
      RecompilationSandboxBusyError
    );
    await assert.rejects(
      whileSandboxQuiet(["/home/u/.config"], async () => {}),
      RecompilationSandboxBusyError
    );

    child.emit("exit", 0, null);
    assert.equal(await whileSandboxQuiet([bind], async () => "ok"), "ok");
  });

  it("keeps unrelated folders usable", async () => {
    const child = fakeChild();
    trackLiveSandbox(child, [install]);

    assert.equal(
      await whileSandboxQuiet([`${install}-other`], async () => "ok"),
      "ok"
    );
    child.emit("exit", 0, null);
  });

  it("refuses a new sandbox on folders the launcher works in", async () => {
    let checked = false;
    await whileSandboxQuiet([install], async () => {
      assert.throws(
        () => assertSandboxCanStart([install, bind]),
        RecompilationSandboxBusyError
      );
      checked = true;
    });
    assert.equal(checked, true);
    assertSandboxCanStart([install, bind]);
  });

  it("releases a sandbox that never spawned", async () => {
    const child = fakeChild(false);
    trackLiveSandbox(child, [install]);
    child.emit("error", new Error("ENOENT"));

    assert.equal(await whileSandboxQuiet([install], async () => "ok"), "ok");
  });
});
