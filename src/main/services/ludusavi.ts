import type { GameShop, LudusaviBackup, LudusaviConfig } from "@types";

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import cp from "node:child_process";
import { SystemPath } from "./system-path";
import { resolveSystemBinary } from "@main/helpers/resolve-system-binary";

export class Ludusavi {
  private static ludusaviResourcesPath = app.isPackaged
    ? path.join(process.resourcesPath, "ludusavi")
    : path.join(__dirname, "..", "..", "ludusavi");

  private static configPath = path.join(
    SystemPath.getPath("userData"),
    "ludusavi"
  );
  private static binaryName =
    process.platform === "win32" ? "ludusavi.exe" : "ludusavi";

  private static userDataBinaryPath = path.join(
    this.configPath,
    this.binaryName
  );

  // Prefer a system-installed ludusavi if present on PATH, otherwise use the
  // copy placed in userData from the build-time download.
  private static resolveBinaryPath(): string {
    const systemLudusavi = resolveSystemBinary(["ludusavi"]);
    if (systemLudusavi) return systemLudusavi;

    return this.userDataBinaryPath;
  }

  public static async getConfig() {
    const config = YAML.parse(
      fs.readFileSync(path.join(this.configPath, "config.yaml"), "utf-8")
    ) as LudusaviConfig;

    return config;
  }

  public static async copyConfigFileToUserData() {
    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath, { recursive: true });

      fs.cpSync(
        path.join(this.ludusaviResourcesPath, "config.yaml"),
        path.join(this.configPath, "config.yaml")
      );
    }
  }

  public static async copyBinaryToUserData() {
    // A system-installed ludusavi takes precedence, so no copy is needed.
    if (resolveSystemBinary(["ludusavi"])) return;

    if (!fs.existsSync(this.userDataBinaryPath)) {
      fs.cpSync(
        path.join(this.ludusaviResourcesPath, this.binaryName),
        this.userDataBinaryPath
      );
    }
  }

  public static async backupGame(
    _shop: GameShop,
    objectId: string,
    backupPath?: string | null,
    winePrefix?: string | null,
    preview?: boolean
  ): Promise<LudusaviBackup> {
    return new Promise((resolve, reject) => {
      const args = [
        "--config",
        this.configPath,
        "backup",
        objectId,
        "--api",
        "--force",
      ];

      if (preview) args.push("--preview");
      if (backupPath) args.push("--path", backupPath);
      if (winePrefix) args.push("--wine-prefix", winePrefix);

      cp.execFile(
        this.resolveBinaryPath(),
        args,
        (err: cp.ExecFileException | null, stdout: string) => {
          if (err) {
            return reject(err);
          }

          return resolve(JSON.parse(stdout) as LudusaviBackup);
        }
      );
    });
  }

  public static async getBackupPreview(
    _shop: GameShop,
    objectId: string,
    winePrefix?: string | null
  ): Promise<LudusaviBackup | null> {
    const config = await this.getConfig();

    const backupData = await this.backupGame(
      _shop,
      objectId,
      null,
      winePrefix,
      true
    );

    const customGame = config.customGames.find(
      (game) => game.name === objectId
    );

    return {
      ...backupData,
      customBackupPath: customGame?.files[0] || null,
    };
  }

  static async addCustomGame(title: string, savePath: string | null) {
    const config = await this.getConfig();
    const filteredGames = config.customGames.filter(
      (game) => game.name !== title
    );

    if (savePath) {
      filteredGames.push({
        name: title,
        files: [savePath],
        registry: [],
      });
    }

    config.customGames = filteredGames;

    fs.writeFileSync(
      path.join(this.configPath, "config.yaml"),
      YAML.stringify(config)
    );
  }
}
