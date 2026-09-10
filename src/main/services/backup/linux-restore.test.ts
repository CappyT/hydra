import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { executeLinuxRestore, planLinuxRestore } from "./linux-restore.ts";

const options = {
  sourceRoot: "/scratch",
  destinationRoot: "/game/prefix",
  artifactHome: "C:/users/old",
  artifactWinePrefix: "/old/prefix",
  wineUserHome: "C:/users/new",
  wine: true,
};
const mapping = (files: string[]) => ({
  drives: { "drive-0": "" },
  backups: [
    { name: ".", files: Object.fromEntries(files.map((file) => [file, {}])) },
  ],
});
it("remaps Wine saves into the approved prefix and current user", () => {
  assert.deepEqual(
    planLinuxRestore(
      mapping(["/old/prefix/drive_c/users/old/save.dat"]),
      options
    ),
    [
      {
        source: "drive-0/old/prefix/drive_c/users/old/save.dat",
        destination: "drive_c/users/new/save.dat",
      },
    ]
  );
});
it("rejects traversal, foreign destinations, unsafe drives and incremental snapshots", () => {
  for (const file of [
    "/old/prefix/../secret",
    "/host/.ssh/key",
    "/old/prefix-sibling/save.dat",
  ])
    assert.throws(() => planLinuxRestore(mapping([file]), options));
  assert.throws(() =>
    planLinuxRestore(
      { drives: { "../drive": "" }, backups: [{ files: {} }] },
      options
    )
  );
  assert.throws(() =>
    planLinuxRestore(
      { drives: {}, backups: [{ name: "diff", files: {} }] },
      options
    )
  );
});
it("restores Windows drive mappings and confines native saves to the game home", () => {
  assert.equal(
    planLinuxRestore(
      {
        drives: { "drive-C": "C:" },
        backups: [{ files: { "C:/users/old/save.dat": {} } }],
      },
      options
    )[0].destination,
    "drive_c/users/new/save.dat"
  );
  const native = { ...options, wine: false, artifactHome: "/home/old" };
  assert.equal(
    planLinuxRestore(mapping(["/home/old/.config/game/save.dat"]), native)[0]
      .destination,
    ".config/game/save.dat"
  );
  assert.throws(() => planLinuxRestore(mapping(["/etc/passwd"]), native));
});
it("pins directories and refuses source, ancestor and leaf symlinks before replacing saves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-safe-restore-"));
  try {
    const sourceRoot = path.join(root, "source");
    const destinationRoot = path.join(root, "target");
    const outside = path.join(root, "outside");
    for (const dir of [sourceRoot, destinationRoot, outside]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(sourceRoot, "save"), "new");
    fs.writeFileSync(path.join(destinationRoot, "existing"), "keep");
    fs.writeFileSync(path.join(outside, "secret"), "secret");
    fs.symlinkSync(outside, path.join(destinationRoot, "escape"));
    const context = { ...options, sourceRoot, destinationRoot };
    await assert.rejects(
      executeLinuxRestore(context, [
        { source: "save", destination: "existing" },
        { source: "save", destination: "escape/secret" },
      ])
    );
    assert.equal(
      fs.readFileSync(path.join(destinationRoot, "existing"), "utf8"),
      "keep"
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "secret"), "utf8"),
      "secret"
    );
    fs.symlinkSync(
      path.join(outside, "secret"),
      path.join(sourceRoot, "bad-source")
    );
    await assert.rejects(
      executeLinuxRestore(context, [
        { source: "bad-source", destination: "existing" },
      ])
    );
    fs.symlinkSync(
      path.join(outside, "secret"),
      path.join(destinationRoot, "bad-leaf")
    );
    await assert.rejects(
      executeLinuxRestore(context, [
        { source: "save", destination: "bad-leaf" },
      ])
    );
    fs.linkSync(
      path.join(outside, "secret"),
      path.join(destinationRoot, "hardlink")
    );
    await executeLinuxRestore(context, [
      { source: "save", destination: "hardlink" },
      { source: "save", destination: "new-directory/save" },
    ]);
    assert.equal(
      fs.readFileSync(path.join(outside, "secret"), "utf8"),
      "secret"
    );
    assert.equal(
      fs.readFileSync(path.join(destinationRoot, "hardlink"), "utf8"),
      "new"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
