import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  getPortPathTemplates,
  getRecompilationSandboxPaths,
  listRomFiles,
  removeEscapingSymlinks,
} from "./recompilation-sandbox-paths.ts";

const install = "/data/hydra/recompilations/zelda64recomp";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recomp-sandbox-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const write = (file: string, content = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

describe("getPortPathTemplates", () => {
  it("collects the Linux path templates of every meta section", () => {
    assert.deepEqual(
      getPortPathTemplates({
        executable: { win32: "Game.exe" },
        rom: {
          path: {
            arg: ["{rom}"],
            config: {
              file: {
                win32: "<base>/launcher.ini",
                linux: "<xdgConfig>/launcher/settings.json",
              },
            },
          },
          copyTo: { linux: "<home>/.config/Zelda64Recompiled/mm.z64" },
          imported: { linux: ["<xdgData>/sm64/sm64.o2r", "<base>/sm64.o2r"] },
          folder: ["eboot.bin", "sce_sys/param.sfo"],
        },
        trophies: { path: { linux: "<xdgData>/port/trophies.txt" } },
      }),
      [
        "<xdgConfig>/launcher/settings.json",
        "<home>/.config/Zelda64Recompiled/mm.z64",
        "<xdgData>/sm64/sm64.o2r",
        "<base>/sm64.o2r",
        "<xdgData>/port/trophies.txt",
      ]
    );
  });

  it("skips Windows-only folders outside a win32 branch", () => {
    assert.deepEqual(
      getPortPathTemplates({
        settings: ["<winAppData>/Port/port.ini", "<xdgData>/Port/port.ini"],
      }),
      ["<xdgData>/Port/port.ini"]
    );
  });

  it("expands {titleId} to each listed title id, once each", () => {
    assert.deepEqual(
      getPortPathTemplates({
        rom: { titleIds: ["CUSA00001", "CUSA00002"] },
        trophies: {
          path: { linux: "<xdgData>/port/{titleId}/trophies.json" },
          reset: ["<xdgData>/port/{titleId}/trophies.json"],
        },
      }),
      [
        "<xdgData>/port/CUSA00001/trophies.json",
        "<xdgData>/port/CUSA00002/trophies.json",
      ]
    );
  });

  it("returns nothing for an unknown port", () => {
    assert.deepEqual(getPortPathTemplates(undefined), []);
  });
});

describe("recompilation-meta.json binds", () => {
  const home = "/home/u";
  const xdgConfig = `${home}/.config`;
  const xdgData = `${home}/.local/share`;
  const base = "/data/hydra/recompilations/port";
  // Same tokens as resolveRecompilationPath on Linux.
  const resolve = (template: string) =>
    path.normalize(
      template
        .replaceAll("<base>", base)
        .replaceAll("<home>", home)
        .replaceAll("<xdgData>", xdgData)
        .replaceAll("<appData>", xdgData)
        .replaceAll("<xdgConfig>", xdgConfig)
        .replaceAll("{romName}", "")
    );
  const meta = JSON.parse(
    fs.readFileSync(
      new URL("./recompilation-meta.json", import.meta.url),
      "utf8"
    )
  ) as Record<string, unknown>;

  // Every writable bind comes from upstream meta; a broad one such as
  // ~/.cache must fail here and get a human review.
  it("binds only port-specific folders inside the XDG config and data dirs", () => {
    for (const [slug, entry] of Object.entries(meta)) {
      const { binds } = getRecompilationSandboxPaths(
        base,
        getPortPathTemplates(entry).map(resolve),
        []
      );
      for (const bind of binds) {
        assert.ok(
          [xdgConfig, xdgData].some(
            (root) => bind !== root && bind.startsWith(`${root}/`)
          ),
          `${slug} binds ${bind}`
        );
      }
    }
  });
});

describe("listRomFiles", () => {
  it("returns a single-file ROM by itself", async () => {
    const rom = write(path.join(scratch, "single", "mm.z64"));
    write(path.join(scratch, "single", "unrelated.txt"));
    assert.deepEqual(await listRomFiles(rom), [rom]);
  });

  it("returns a game folder as a whole", async () => {
    const folder = path.join(scratch, "ps4", "CUSA00001");
    write(path.join(folder, "eboot.bin"));
    write(path.join(folder, "sce_sys", "param.sfo"));
    assert.deepEqual(await listRomFiles(folder), [folder]);
  });

  it("maps an eboot.bin to its game folder", async () => {
    const folder = path.join(scratch, "ps4-eboot", "CUSA00002");
    const eboot = write(path.join(folder, "EBOOT.BIN"));
    assert.deepEqual(await listRomFiles(eboot), [folder]);
  });

  it("adds the tracks a cue sheet lists next to it", async () => {
    const folder = path.join(scratch, "cue");
    const track1 = write(path.join(folder, "Game (Track 1).bin"));
    const track2 = write(path.join(folder, "Game (Track 2).bin"));
    const cue = write(
      path.join(folder, "Game.cue"),
      `FILE "Game (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\nFILE "Game (Track 2).bin" BINARY\n`
    );
    write(path.join(folder, "other.bin"));
    assert.deepEqual(
      (await listRomFiles(cue)).sort(),
      [cue, track1, track2].sort()
    );
  });

  it("ignores listed names with a folder part", async () => {
    const secret = write(path.join(scratch, "secret", "id_ed25519"));
    const cue = write(
      path.join(scratch, "evil", "Game.cue"),
      `FILE "../secret/id_ed25519" BINARY\nFILE "${secret}" BINARY\n`
    );
    assert.deepEqual(await listRomFiles(cue), [cue]);
  });

  it("matches listed names case-insensitively and adds cue sidecars", async () => {
    const folder = path.join(scratch, "case");
    const track = write(path.join(folder, "GAME.BIN"));
    const sidecar = write(path.join(folder, "Game.sbi"));
    const cue = write(
      path.join(folder, "Game.cue"),
      `FILE "game.bin" BINARY\n`
    );
    assert.deepEqual(
      (await listRomFiles(cue)).sort(),
      [cue, track, sidecar].sort()
    );
  });

  it("ignores a listed track whose real path leaves the folder", async () => {
    const elsewhere = write(path.join(scratch, "elsewhere", "track.bin"));
    const folder = path.join(scratch, "linked");
    fs.mkdirSync(folder, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(folder, "track.bin"));
    const cue = write(
      path.join(folder, "Game.cue"),
      `FILE "track.bin" BINARY\n`
    );
    assert.deepEqual(await listRomFiles(cue), [cue]);
  });

  it("follows an m3u playlist to its discs and their tracks", async () => {
    const folder = path.join(scratch, "m3u");
    const track = write(path.join(folder, "Disc1.bin"));
    const disc = write(
      path.join(folder, "Disc1.cue"),
      `FILE "Disc1.bin" BINARY\n`
    );
    const playlist = write(
      path.join(folder, "Game.m3u"),
      "# discs\nDisc1.cue\n"
    );
    assert.deepEqual(
      (await listRomFiles(playlist)).sort(),
      [playlist, disc, track].sort()
    );
  });
});

describe("getRecompilationSandboxPaths", () => {
  it("binds setup folders outside the install folder, once each", () => {
    const { binds } = getRecompilationSandboxPaths(
      install,
      [
        "/home/u/.config/Zelda64Recompiled/mm.z64",
        "/home/u/.config/Zelda64Recompiled/other.z64",
        `${install}/baserom.us.z64`,
      ],
      []
    );
    assert.deepEqual(binds, ["/home/u/.config/Zelda64Recompiled"]);
  });

  it("binds ROM files read-only unless a writable bind covers them", () => {
    const { roBinds } = getRecompilationSandboxPaths(
      install,
      ["/home/u/.config/Zelda64Recompiled/mm.z64"],
      [
        "/home/u/Downloads/mm.z64",
        "/home/u/.config/Zelda64Recompiled/mm.z64",
        `${install}/rom/game.iso`,
      ]
    );
    assert.deepEqual(roBinds, ["/home/u/Downloads/mm.z64"]);
  });

  it("binds only the outermost of nested setup folders", () => {
    const { binds } = getRecompilationSandboxPaths(
      install,
      [
        "/home/u/.local/share/port/CUSA00001/trophies.json",
        "/home/u/.local/share/port/settings.ini",
        "/home/u/.config/port/config.json",
      ],
      []
    );
    assert.deepEqual(binds.sort(), [
      "/home/u/.config/port",
      "/home/u/.local/share/port",
    ]);
  });

  it("tells a sibling with a shared prefix from a child named ..foo", () => {
    const { binds } = getRecompilationSandboxPaths(
      install,
      [`${install}-data/save.json`, `${install}/..foo/save.json`],
      []
    );
    assert.deepEqual(binds, [`${install}-data`]);
  });
});

describe("removeEscapingSymlinks", () => {
  const exists = (root: string, name: string) =>
    fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }) !==
    undefined;

  it("keeps links inside the root or into /usr and removes the others", async () => {
    const root = path.join(scratch, "port");
    const outside = path.join(scratch, "outside");
    const inside = write(path.join(root, "lib", "libport.so.1"));
    write(path.join(outside, ".bashrc"));
    fs.mkdirSync(path.join(root, "deep"), { recursive: true });

    fs.symlinkSync(inside, path.join(root, "lib", "libport.so"));
    fs.symlinkSync(path.join(outside, ".bashrc"), path.join(root, "rc"));
    fs.symlinkSync(outside, path.join(root, "deep", "gamedata"));
    fs.symlinkSync(path.join(outside, "new-file"), path.join(root, "dangling"));
    fs.symlinkSync("/", path.join(root, "host-root"));
    fs.symlinkSync("/usr", path.join(root, "system"));

    await removeEscapingSymlinks(root);

    assert.equal(exists(root, "lib/libport.so"), true);
    assert.equal(exists(root, "system"), true);
    for (const name of ["rc", "deep/gamedata", "dangling", "host-root"]) {
      assert.equal(exists(root, name), false, name);
    }
    assert.equal(fs.existsSync(path.join(outside, ".bashrc")), true);
  });

  it("removes a dangling link that only looks inside the root", async () => {
    const root = path.join(scratch, "lexical");
    const nested = path.join(root, "d1", "d2", "d3");
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync("/usr/share", path.join(nested, "s"));
    fs.symlinkSync(
      "s/../../../outside/x.json",
      path.join(nested, "settings.json")
    );

    await removeEscapingSymlinks(root);

    assert.equal(exists(root, "d1/d2/d3/s"), true);
    assert.equal(exists(root, "d1/d2/d3/settings.json"), false);
  });

  it("removes FIFOs and other special files", async () => {
    const root = path.join(scratch, "fifo");
    fs.mkdirSync(root, { recursive: true });
    execFileSync("mkfifo", [path.join(root, ".hydra-recompilation.json")]);

    await removeEscapingSymlinks(root);

    assert.equal(exists(root, ".hydra-recompilation.json"), false);
  });
});
