import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { resolveSystemBinary } from "./resolve-system-binary.ts";
it("does not execute or select PATH-injected tools or explicit untrusted paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "untrusted-tools-"));
  const previous = process.env.PATH;
  try {
    const fake = path.join(root, "true");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = root;
    assert.notEqual(resolveSystemBinary(["true"]), fake);
    assert.equal(resolveSystemBinary([fake]), null);
    assert.equal(resolveSystemBinary(["../true"]), null);
    assert.ok(resolveSystemBinary(["true"])?.startsWith("/usr/bin/"));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
