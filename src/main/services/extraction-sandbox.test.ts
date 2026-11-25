import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  buildExtractionSandboxArgs,
  listArchiveVolumes,
} from "./extraction-sandbox.ts";
import { BWRAP_PATH } from "./sandbox-command-builder.ts";
import { resolveSystemBinary } from "../helpers/resolve-system-binary.ts";

const bindsOf = (args: string[]) => {
  const binds: string[] = [];
  const end = args.indexOf("--");
  for (let index = 0; index < end; index += 1) {
    if (args[index] === "--bind" || args[index] === "--ro-bind") {
      binds.push(`${args[index]} ${args[index + 1]} ${args[index + 2]}`);
      index += 2;
    }
  }
  return binds;
};

describe("listArchiveVolumes", () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-volumes-"));
    for (const name of [
      "Game.part1.rar",
      "Game.part2.rar",
      "Game.v2.7z.001",
      "Gamepad.zip",
      "notes.txt",
      "id_ed25519",
    ]) {
      fs.writeFileSync(path.join(root, name), "");
    }
    fs.mkdirSync(path.join(root, "Game.dir"));
    fs.symlinkSync("id_ed25519", path.join(root, "Game.link"));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists the volumes of the set and nothing else in the folder", () => {
    assert.deepEqual(
      listArchiveVolumes(path.join(root, "Game.part1.rar")).sort(),
      ["Game.part1.rar", "Game.part2.rar", "Game.v2.7z.001"].map((name) =>
        path.join(root, name)
      )
    );
  });

  it("returns the archive alone when it has no extension or is missing", () => {
    assert.deepEqual(listArchiveVolumes(path.join(root, "id_ed25519")), [
      path.join(root, "id_ed25519"),
    ]);
    assert.deepEqual(listArchiveVolumes(path.join(root, "gone.zip")), [
      path.join(root, "gone.zip"),
    ]);
  });
});

describe("buildExtractionSandboxArgs", () => {
  const sevenZip = "/tmp/.mount_hydra/resources/7zzs";
  const payload = ["x", "/games/dl/Game.zip", "-o.", "-y"];

  it("isolates everything and runs 7-Zip in the destination", () => {
    const { command, args } = buildExtractionSandboxArgs(sevenZip, payload, {
      binds: [
        { path: "/games/dl", writable: false },
        { path: "/games/dl/Game", writable: true },
      ],
      chdir: "/games/dl/Game",
    });

    assert.equal(command, BWRAP_PATH);
    for (const flag of [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(!args.includes("--share-net"));
    assert.deepEqual(
      args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2),
      ["--chdir", "/games/dl/Game"]
    );
    assert.deepEqual(args.slice(args.indexOf("--") + 1), [
      sevenZip,
      ...payload,
    ]);
    assert.deepEqual(bindsOf(args), [
      "--ro-bind /usr /usr",
      "--ro-bind /games/dl /games/dl",
      "--bind /games/dl/Game /games/dl/Game",
      `--ro-bind ${sevenZip} ${sevenZip}`,
    ]);
    for (const [target, link] of [
      ["usr/bin", "/bin"],
      ["usr/sbin", "/sbin"],
      ["usr/lib", "/lib"],
      ["usr/lib64", "/lib64"],
    ]) {
      const index = args.indexOf(link);
      assert.deepEqual(args.slice(index - 2, index + 1), [
        "--symlink",
        target,
        link,
      ]);
    }
    assert.ok(args.join(" ").includes("--proc /proc --dev /dev --tmpfs /tmp"));
    // The binary under the AppImage mount must be bound after the /tmp tmpfs.
    assert.ok(args.lastIndexOf(sevenZip) > args.indexOf("--tmpfs"));
    assert.ok(!args.some((arg) => arg === os.homedir()));
  });

  it("keeps the destination writable when the archive sits inside it", () => {
    const { args } = buildExtractionSandboxArgs(sevenZip, payload, {
      binds: [
        { path: "/games/dl/Game", writable: false },
        { path: "/games/dl/Game", writable: true },
      ],
      chdir: "/games/dl/Game",
    });

    assert.deepEqual(bindsOf(args).slice(1, -1), [
      "--bind /games/dl/Game /games/dl/Game",
    ]);
  });

  it("mounts the deeper bind last so it wins", () => {
    const { args } = buildExtractionSandboxArgs(sevenZip, ["a", "out.zip"], {
      binds: [
        { path: "/saves/game/export", writable: true },
        { path: "/saves/game", writable: false },
      ],
      chdir: "/saves/game",
    });

    assert.deepEqual(bindsOf(args).slice(1, -1), [
      "--ro-bind /saves/game /saves/game",
      "--bind /saves/game/export /saves/game/export",
    ]);
  });
});

const findSevenZip = () => {
  const bundled = path.resolve("binaries", "7zzs");
  if (fs.existsSync(bundled)) return bundled;
  return resolveSystemBinary(["7zz", "7z"]);
};

const sandboxSkipReason = (sevenZip: string | null) => {
  if (process.platform !== "linux") return "not Linux";
  if (!fs.existsSync(BWRAP_PATH)) return "bwrap is missing";
  if (!sevenZip) return "7-Zip is missing";
  const probe = buildExtractionSandboxArgs("/usr/bin/true", [], {
    binds: [],
    chdir: "/",
  });
  const result = spawnSync(probe.command, probe.args, { stdio: "ignore" });
  if (result.status !== 0) return "bwrap cannot create user namespaces here";
  return null;
};

const sevenZipBinary = findSevenZip();
const skip = sandboxSkipReason(sevenZipBinary);

describe("7-Zip in the extraction sandbox", { skip: skip ?? false }, () => {
  const sevenZip = sevenZipBinary as string;
  let tmpRoot: string;
  let archive: string;

  const run = (command: string, args: string[], cwd: string) =>
    spawnSync(command, args, { cwd, encoding: "utf8" });

  // A destination with a planted `evil -> ../outside`, as a sandboxed game
  // could leave in its own install folder.
  const plantedDestination = (name: string) => {
    const destination = path.join(tmpRoot, name, "dest");
    const outside = path.join(tmpRoot, name, "outside");
    fs.mkdirSync(destination, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync("../outside", path.join(destination, "evil"));
    return { destination, outside };
  };

  before(() => {
    tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "extract-sandbox-"))
    );
    const staging = path.join(tmpRoot, "staging");
    fs.mkdirSync(path.join(staging, "evil"), { recursive: true });
    fs.writeFileSync(path.join(staging, "evil", "x.desktop"), "payload");
    fs.writeFileSync(path.join(staging, "readme.txt"), "game");
    fs.mkdirSync(path.join(tmpRoot, "downloads"));
    archive = path.join(tmpRoot, "downloads", "Game.zip");
    const created = run(
      sevenZip,
      ["a", archive, "evil", "readme.txt"],
      staging
    );
    assert.equal(created.status, 0, created.stderr);
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reproduces the write-through without the sandbox", () => {
    const { destination, outside } = plantedDestination("bare");

    run(sevenZip, ["x", archive, "-o.", "-y", "-spd"], destination);

    assert.ok(fs.existsSync(path.join(outside, "x.desktop")));
  });

  it("writes nothing outside the destination inside the sandbox", () => {
    const { destination, outside } = plantedDestination("sandboxed");
    const listTree = () =>
      fs.readdirSync(tmpRoot, { recursive: true, encoding: "utf8" }).sort();
    const before = listTree();

    const wrapped = buildExtractionSandboxArgs(
      sevenZip,
      ["x", archive, "-o.", "-y", "-spd", "-bsp1"],
      {
        binds: [
          { path: path.dirname(archive), writable: false },
          { path: destination, writable: true },
        ],
        chdir: destination,
      }
    );
    const result = run(wrapped.command, wrapped.args, destination);

    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(
      fs.readFileSync(path.join(destination, "readme.txt"), "utf8"),
      "game",
      result.stderr
    );
    const after = listTree();
    assert.deepEqual(
      after.filter((entry) => !before.includes(entry)),
      [path.join("sandboxed", "dest", "readme.txt")]
    );
    // node-7z parses the -bsp1 progress from stdout.
    assert.match(result.stdout, /\d+%/);
  });
});
