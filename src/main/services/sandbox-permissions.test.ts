import assert from "node:assert/strict";
import { it } from "node:test";

import {
  isSandboxPermission,
  resolveSandboxPermissions,
} from "./sandbox-permissions.ts";

it("denies every permission by default", () => {
  for (const [preferences, game] of [
    [null, null],
    [{}, {}],
    [{}, { allowMicrophone: null }],
  ] as const) {
    assert.deepEqual(resolveSandboxPermissions(preferences, game), {
      allowLocalNetwork: false,
      allowMicrophone: false,
      allowCamera: false,
    });
  }
});

it("lets the per-game value win over the global default in both directions", () => {
  assert.deepEqual(
    resolveSandboxPermissions(
      { allowLocalNetwork: true, allowMicrophone: true },
      { allowMicrophone: false, allowCamera: true }
    ),
    { allowLocalNetwork: true, allowMicrophone: false, allowCamera: true }
  );
});

it("grants only on an explicit true", () => {
  const loose = { allowCamera: "yes", allowMicrophone: 1 } as never;
  assert.deepEqual(resolveSandboxPermissions(loose, loose), {
    allowLocalNetwork: false,
    allowMicrophone: false,
    allowCamera: false,
  });
});

it("recognizes only the three permission names", () => {
  assert.equal(isSandboxPermission("allowCamera"), true);
  for (const name of ["sandboxDisabled", "__proto__", "", null, 3]) {
    assert.equal(isSandboxPermission(name), false);
  }
});
