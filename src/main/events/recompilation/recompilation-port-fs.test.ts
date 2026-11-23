import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { portFs } from "./recompilation-port-fs.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recomp-port-fs-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("portFs", () => {
  it("reads and writes a regular file", async () => {
    const file = path.join(scratch, "trophies.txt");
    await portFs.writeFile(file, "1 2\n");
    assert.equal(await portFs.readFile(file, "utf8"), "1 2\n");
  });

  it("refuses to write through a symlink the port planted", async () => {
    const host = path.join(scratch, "host-file");
    fs.writeFileSync(host, "host");
    const link = path.join(scratch, "planted-link");
    fs.symlinkSync(host, link);

    await assert.rejects(portFs.writeFile(link, "owned"));
    await assert.rejects(portFs.readFile(link));
    assert.equal(fs.readFileSync(host, "utf8"), "host");
  });

  it("refuses an oversized file, sparse ones included", async () => {
    const log = path.join(scratch, "huge.log");
    fs.writeFileSync(log, "");
    fs.truncateSync(log, 65 * 1024 * 1024);

    await assert.rejects(portFs.readFile(log), /File too large/);
    await assert.rejects(portFs.open(log, "r"), /File too large/);
  });

  it("stats a planted link itself, not its target", async () => {
    const link = path.join(scratch, "stat-link");
    fs.symlinkSync("/etc/hostname", link);

    assert.equal((await portFs.stat(link)).isSymbolicLink(), true);
  });

  it("refuses a FIFO without blocking", async () => {
    const fifo = path.join(scratch, "trophies.fifo");
    execFileSync("mkfifo", [fifo]);

    await assert.rejects(portFs.readFile(fifo, "utf8"));
    await assert.rejects(portFs.open(fifo, "r"));
  });
});
