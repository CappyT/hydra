import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { removeEscapingSymlinks } from "./extraction-symlinks.ts";

describe("removeEscapingSymlinks", () => {
  let tmpRoot: string;
  let root: string;
  let outside: string;

  const isLink = (target: string) => {
    try {
      return fs.lstatSync(target).isSymbolicLink();
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "extract-links-"))
    );
    root = path.join(tmpRoot, "root");
    outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "x");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("removes absolute links, even ones that point inside the root", async () => {
    fs.symlinkSync(outside, path.join(root, "abs-out"));
    fs.symlinkSync(path.join(root, "sub"), path.join(root, "abs-in"));

    const removed = await removeEscapingSymlinks(root);

    assert.deepEqual(removed.sort(), [
      path.join(root, "abs-in"),
      path.join(root, "abs-out"),
    ]);
    assert.ok(fs.existsSync(path.join(outside, "secret")));
  });

  it("removes relative links that climb out of the root, at any depth", async () => {
    fs.symlinkSync("../outside", path.join(root, "up"));
    fs.symlinkSync("../../../outside", path.join(root, "sub", "deep", "up"));
    fs.symlinkSync("../../autostart-missing", path.join(root, "sub", "gone"));

    const removed = await removeEscapingSymlinks(root);

    assert.equal(removed.length, 3);
    assert.ok(!isLink(path.join(root, "up")));
    assert.ok(!isLink(path.join(root, "sub", "deep", "up")));
    assert.ok(!isLink(path.join(root, "sub", "gone")));
  });

  it("follows chains: a link through an escaping link escapes too", async () => {
    fs.symlinkSync("../outside", path.join(root, "hop"));
    fs.symlinkSync("hop/secret", path.join(root, "chain"));

    await removeEscapingSymlinks(root);

    assert.ok(!isLink(path.join(root, "hop")));
    assert.ok(!isLink(path.join(root, "chain")));
  });

  it("removes a dangling link that escapes only through an in-root link", async () => {
    // `dot/..` is the parent of the root, not the root: a lexical resolve
    // would keep this link.
    fs.symlinkSync(".", path.join(root, "dot"));
    fs.symlinkSync("dot/../escaped-new", path.join(root, "sneaky"));

    const removed = await removeEscapingSymlinks(root);

    assert.deepEqual(removed, [path.join(root, "sneaky")]);
    assert.ok(isLink(path.join(root, "dot")));
  });

  it("keeps in-root links, dangling or not, and a loop to the root", async () => {
    fs.writeFileSync(path.join(root, "sub", "file"), "data");
    fs.symlinkSync("sub/file", path.join(root, "ok"));
    fs.symlinkSync("deep/../file", path.join(root, "sub", "ok-dotdot"));
    fs.symlinkSync("sub/not-yet", path.join(root, "dangling-in"));
    fs.symlinkSync(".", path.join(root, "loop"));
    fs.symlinkSync("ring-b", path.join(root, "ring-a"));
    fs.symlinkSync("ring-a", path.join(root, "ring-b"));

    const removed = await removeEscapingSymlinks(root);

    assert.deepEqual(removed, []);
    for (const name of ["ok", "dangling-in", "loop", "ring-a", "ring-b"]) {
      assert.ok(isLink(path.join(root, name)), name);
    }
    assert.ok(isLink(path.join(root, "sub", "ok-dotdot")));
  });

  it("never touches regular files or directories, and never descends links", async () => {
    fs.writeFileSync(path.join(root, "game.exe"), "binary");
    fs.writeFileSync(path.join(root, "sub", "deep", "save.dat"), "save");
    fs.mkdirSync(path.join(outside, "nested"));
    fs.symlinkSync(
      path.join(outside, "secret"),
      path.join(outside, "nested", "abs")
    );
    fs.symlinkSync("../outside", path.join(root, "into-outside"));

    await removeEscapingSymlinks(root);

    assert.equal(
      fs.readFileSync(path.join(root, "game.exe"), "utf8"),
      "binary"
    );
    assert.equal(
      fs.readFileSync(path.join(root, "sub", "deep", "save.dat"), "utf8"),
      "save"
    );
    assert.ok(fs.statSync(path.join(root, "sub", "deep")).isDirectory());
    // The walk never entered the link, so the link outside the root stays.
    assert.ok(isLink(path.join(outside, "nested", "abs")));
    assert.ok(fs.existsSync(path.join(outside, "secret")));
  });

  it("works when the root path itself goes through a symlink", async () => {
    const alias = path.join(tmpRoot, "alias");
    fs.symlinkSync(root, alias);
    fs.symlinkSync("sub", path.join(root, "in"));
    fs.symlinkSync("../outside", path.join(root, "out"));

    const removed = await removeEscapingSymlinks(alias);

    assert.deepEqual(removed, [path.join(root, "out")]);
    assert.ok(isLink(path.join(root, "in")));
    assert.ok(isLink(alias));
  });

  it("returns nothing for a missing root", async () => {
    assert.deepEqual(
      await removeEscapingSymlinks(path.join(tmpRoot, "missing")),
      []
    );
  });
});
