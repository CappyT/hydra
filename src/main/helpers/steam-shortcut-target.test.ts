import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseBuffer, writeBuffer } from "steam-shortcut-editor";

import {
  rewriteShortcutTargets,
  rewriteSteamShortcutTargetsSync,
} from "./steam-shortcut-target.ts";

const OLD = "/home/u/Apps/hydralauncher-4.2.0.AppImage";
const NEW = "/home/u/Apps/hydralauncher-4.2.1.AppImage";

describe("rewriteShortcutTargets", () => {
  it("rewrites quoted Exe and the matching StartDir", () => {
    const { shortcuts, changed } = rewriteShortcutTargets(
      [{ appname: "A", Exe: `"${OLD}"`, StartDir: '"/home/u/Apps"' }],
      OLD,
      NEW
    );

    assert.equal(changed, 1);
    assert.equal(shortcuts[0].Exe, `"${NEW}"`);
    assert.equal(shortcuts[0].StartDir, '"/home/u/Apps"');
  });

  it("rewrites unquoted and lowercase keys, keeping their style", () => {
    const { shortcuts } = rewriteShortcutTargets(
      [{ exe: OLD, startdir: "/home/u/Apps" }],
      OLD,
      "/other/hydra.AppImage"
    );

    assert.deepEqual(shortcuts[0], {
      exe: "/other/hydra.AppImage",
      startdir: "/other",
    });
  });

  it("leaves unrelated shortcuts and a custom StartDir alone", () => {
    const other = { appname: "B", Exe: '"/usr/bin/foo"', StartDir: '"/usr"' };
    const custom = { appname: "C", Exe: `"${OLD}"`, StartDir: '"/custom"' };

    const { shortcuts, changed } = rewriteShortcutTargets(
      [other, custom],
      OLD,
      NEW
    );

    assert.equal(changed, 1);
    assert.equal(shortcuts[0], other);
    assert.equal(shortcuts[1].Exe, `"${NEW}"`);
    assert.equal(shortcuts[1].StartDir, '"/custom"');
  });

  it("does not match a path that only shares a prefix", () => {
    const { changed } = rewriteShortcutTargets(
      [{ Exe: `"${OLD}.bak"` }],
      OLD,
      NEW
    );

    assert.equal(changed, 0);
  });
});

describe("rewriteSteamShortcutTargetsSync", () => {
  it("rewrites shortcuts.vdf on disk for every Steam user", () => {
    const steam = fs.mkdtempSync(path.join(os.tmpdir(), "steam-shortcuts-"));

    try {
      const configDir = path.join(steam, "userdata", "123", "config");
      fs.mkdirSync(configDir, { recursive: true });
      const vdf = path.join(configDir, "shortcuts.vdf");
      fs.writeFileSync(
        vdf,
        writeBuffer({
          shortcuts: [
            {
              appid: 1,
              appname: "A",
              Exe: `"${OLD}"`,
              StartDir: '"/home/u/Apps"',
            },
            {
              appid: 2,
              appname: "B",
              Exe: '"/usr/bin/foo"',
              StartDir: '"/usr"',
            },
          ],
        })
      );

      assert.equal(rewriteSteamShortcutTargetsSync(steam, OLD, NEW), 1);

      const result = parseBuffer(fs.readFileSync(vdf)).shortcuts as Record<
        string,
        unknown
      >[];
      assert.equal(result[0].Exe, `"${NEW}"`);
      assert.equal(result[1].Exe, '"/usr/bin/foo"');
      assert.equal(fs.existsSync(`${vdf}.hydra-tmp`), false);
    } finally {
      fs.rmSync(steam, { recursive: true, force: true });
    }
  });

  it("returns 0 when Steam has no userdata", () => {
    assert.equal(
      rewriteSteamShortcutTargetsSync("/nonexistent/steam", OLD, NEW),
      0
    );
  });
});
