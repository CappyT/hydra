import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { IpcMainInvokeEvent } from "electron";
import * as tar from "tar";
import ts from "typescript";
import YAML from "yaml";

import type { Game, GameShop } from "@types";
import { assertSafeSandboxPath } from "../../helpers/sandbox-paths.js";
import { restoreLinuxBackup } from "../../services/backup/linux-restore.js";
import { restoreFromArtifactTar } from "../../services/backup/restore-scratch.js";

const transpile = (sourceUrl: URL) =>
  ts.transpileModule(fs.readFileSync(sourceUrl, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;

const handlerCode = transpile(
  new URL("./download-game-artifact.ts", import.meta.url)
);
const cloudSyncCode = transpile(
  new URL("../../services/cloud-sync.ts", import.meta.url)
);

const runDownload = async (
  game: Pick<Game, "shop" | "platform"> | null,
  requestFails = false
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-artifact-"));
  const objectId = "legacy-game";
  const shop = game?.shop ?? "steam";
  const winePrefixPath = path.join(root, "wine-prefixes", objectId);
  const destination =
    shop === "launchbox"
      ? path.join(root, "restored", "save.bin")
      : path.join(winePrefixPath, "drive_c", "users", "current", "save.bin");
  const requests: string[] = [];
  const artifact = {
    id: "artifact-id",
    createdAt: "2026-01-01T00:00:00.000Z",
    homeDir: shop === "launchbox" ? "/original-profile" : "C:/users/original",
    winePrefixPath: shop === "launchbox" ? null : "/original-prefix",
  };
  const archiveRoot = path.join(root, "archive");
  const gameBackupPath = path.join(archiveRoot, objectId);
  const sourceRelative =
    shop === "launchbox"
      ? destination
      : path.join("drive-c", "users", "original", "save.bin");
  const source = path.join(gameBackupPath, sourceRelative);
  const mappedPath =
    shop === "launchbox"
      ? destination
      : "/original-prefix/drive_c/users/original/save.bin";
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "legacy save contents");
  fs.writeFileSync(
    path.join(gameBackupPath, "mapping.yaml"),
    YAML.stringify({
      backups: [{ files: { [mappedPath]: {} } }],
      drives:
        shop === "launchbox" ? {} : { "drive-c": "/original-prefix/drive_c" },
    })
  );

  const backend = {
    list: async () => [artifact],
    download: async (artifactId: string) => {
      requests.push(artifactId);
      if (requestFails) throw new Error("download unavailable");
      const tarLocation = path.join(root, "artifact.tar");
      tar.c({ file: tarLocation, cwd: archiveRoot, sync: true }, ["."]);
      return tarLocation;
    },
  };
  const logger = { info: () => {}, error: () => {} };
  const WindowManager = {
    sendToAppWindows: (channel: string, result: boolean) => {
      assert.equal(channel, `on-backup-download-complete-${objectId}-${shop}`);
      complete(result);
    },
  };
  let listener!: (
    event: IpcMainInvokeEvent,
    objectId: string,
    shop: GameShop,
    artifactId: string
  ) => Promise<void>;
  let complete!: (success: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    complete = resolve;
  });

  const dependencies: Record<string, unknown> = {
    electron: { Notification: { isSupported: () => false } },
    "./sandbox": { Sandbox: { isEnabled: () => true } },
    "@main/level": {
      db: { get: async () => null },
      gamesSublevel: { get: async () => game },
      levelKeys: { game: () => "game-key", userPreferences: "preferences" },
    },
    "node:path": path,
    tar,
    "node:crypto": crypto,
    "node:fs": fs,
    "node:os": os,
    yaml: YAML,
    "@main/constants": {
      backupsPath: path.join(root, "backups"),
      publicProfilePath: "/public-profile",
      sandboxHomesPath: path.join(root, "sandbox-homes"),
    },
    "@main/helpers": {
      addTrailingSlash: (value: string) => `${value}/`,
      getDeviceId: () => "device-id",
      normalizePath: (value: string) => value,
    },
    "./backup/linux-restore": { restoreLinuxBackup },
    "./backup/backup-source-paths": {
      assertBackupSourcesInsideRoot: () => {},
    },
    "./game-record-updater": { updateGameRecord: async () => undefined },
    "@main/helpers/sandbox-paths": { assertSafeSandboxPath },
    "@main/helpers/sandbox-launch": {
      sanitizeSandboxGameKey: (value: string) => value,
    },
    "./logger": { logger },
    "./window-manager": { WindowManager },
    "./ludusavi": { Ludusavi: {} },
    "@shared": { ACCOUNTLESS: true, formatDate: () => "" },
    "./cloud-save/legacy-cloud-save-policy": {
      assertLegacyCloudSaveWriteAllowed: () => {},
    },
    "@main/services/epic/cloud-saves": {
      runWithHydraSaveGuard: <T>(task: () => Promise<T>) => task(),
    },
    i18next: { language: "en", t: () => "" },
    "./system-path": {
      SystemPath: {
        getPath: (name: string) =>
          name === "home" ? path.join(root, "home") : root,
      },
    },
    "./wine": {
      Wine: {
        getEffectivePrefixPath: () => winePrefixPath,
        getWindowsUserProfilePath: () => "C:/users/current",
      },
    },
    "./backup": {
      getArtifactBackend: async () => backend,
      restoreFromArtifactTar,
    },
    "../register-event": {
      registerEvent: (name: string, callback: typeof listener) => {
        assert.equal(name, "downloadGameArtifact");
        listener = callback;
      },
    },
  };

  try {
    const cloudSyncExports: Record<string, unknown> = {};
    runInNewContext(cloudSyncCode, {
      exports: cloudSyncExports,
      process,
      require: (id: string) => {
        assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
        return dependencies[id];
      },
    });
    dependencies["@main/services"] = {
      CloudSync: cloudSyncExports.CloudSync,
      logger,
      WindowManager,
    };

    runInNewContext(handlerCode, {
      exports: {},
      require: (id: string) => {
        assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
        return dependencies[id];
      },
    });
    await listener({} as IpcMainInvokeEvent, objectId, shop, "artifact-id");
    const success = await completion;
    return {
      success,
      requests,
      contents: fs.existsSync(destination)
        ? fs.readFileSync(destination, "utf8")
        : null,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("legacy GameArtifact downloads", () => {
  for (const platform of [
    "Sony PlayStation 3",
    "Nintendo Entertainment System",
    "Super Nintendo Entertainment System",
    "Nintendo 64",
    "Nintendo Game Boy",
    "Nintendo Game Boy Color",
    "Nintendo Game Boy Advance",
  ]) {
    it(
      `restores existing backups for LaunchBox ${platform}`,
      { timeout: 3000 },
      async () => {
        const result = await runDownload({ shop: "launchbox", platform });
        assert.equal(result.success, true);
        assert.deepEqual(result.requests, ["artifact-id"]);
        assert.equal(result.contents, "legacy save contents");
      }
    );
  }

  it(
    "preserves Steam, other consoles, and missing game records",
    { timeout: 3000 },
    async () => {
      for (const game of [
        { shop: "steam" as const, platform: "Sony PlayStation 3" },
        { shop: "launchbox" as const, platform: "Sony PlayStation 2" },
        null,
      ]) {
        const result = await runDownload(game);
        assert.equal(result.success, true);
        assert.equal(result.contents, "legacy save contents");
      }
    }
  );

  it(
    "still reports genuine download failures without restoring files",
    { timeout: 3000 },
    async () => {
      const result = await runDownload(
        { shop: "launchbox", platform: "Sony PlayStation 3" },
        true
      );
      assert.equal(result.success, false);
      assert.deepEqual(result.requests, ["artifact-id"]);
      assert.equal(result.contents, null);
    }
  );
});
