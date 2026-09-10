import assert from "node:assert/strict";
import { it } from "node:test";
import { isControllerProperties } from "./sandbox-input.ts";
it("permits only positively classified controllers, not keyboard/mouse composites", () => {
  assert.equal(
    isControllerProperties("E:ID_INPUT_JOYSTICK=1\nE:ID_INPUT=1"),
    true
  );
  for (const flags of [
    "",
    "E:ID_INPUT_KEYBOARD=1",
    "E:ID_INPUT_JOYSTICK=0",
    "E:ID_INPUT_JOYSTICK=1\nE:ID_INPUT_KEYBOARD=1",
    "E:ID_INPUT_JOYSTICK=1\nE:ID_INPUT_MOUSE=1",
  ]) {
    assert.equal(isControllerProperties(flags), false);
  }
});
