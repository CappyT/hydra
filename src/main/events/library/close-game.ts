import { registerEvent } from "../register-event";
import {
  emulators,
  launchedGamePids,
  sandboxedGamePids,
  logger,
  Sandbox,
  Wine,
} from "@main/services";
import sudo from "sudo-prompt";
import { app } from "electron";
import { gamesSublevel, levelKeys } from "@main/level";
import { GameShop } from "@types";
import path from "node:path";
import { NativeAddon } from "@main/services/native-addon";
import { processReferencesExecutable } from "@main/services/linux-process-match";
import { isWindowsBatchFile } from "@main/helpers/windows-batch-command";

const getKillCommand = (pid: number) => {
  if (process.platform == "win32") {
    return `taskkill /PID ${pid}`;
  }

  return `kill -9 ${pid}`;
};

const closeGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
) => {
  if (emulators.closeEmulatorSession(levelKeys.game(shop, objectId))) return;

  const processes = await NativeAddon.listProcesses();

  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));

  if (!game) return;

  const gameKey = levelKeys.game(shop, objectId);
  const launchedPid = launchedGamePids.get(gameKey);

  // A sandboxed launch records the bwrap wrapper pid. Because the payload runs
  // in its own pid namespace and session, killing the wrapper's group is not
  // enough; Sandbox.killSandboxTree reaps the whole tree via the pid-namespace
  // init. We never return early: after the kill attempt we fall through to the
  // legacy per-process scan below as a safety net for any survivor.
  if (launchedPid && sandboxedGamePids.has(gameKey)) {
    Sandbox.killSandboxTree(launchedPid);
    launchedGamePids.delete(gameKey);
    sandboxedGamePids.delete(gameKey);
  }

  const trackingPaths = game.trackingExecutablePaths?.filter(Boolean) ?? [];
  const targetPaths =
    game.executablePath && !isWindowsBatchFile(game.executablePath)
      ? [game.executablePath, ...trackingPaths]
      : trackingPaths;

  const gameProcesses = processes.filter((runningProcess) => {
    const matchesTargetPath = targetPaths.some((targetPath) => {
      if (process.platform === "linux") {
        return processReferencesExecutable(
          {
            cwd: runningProcess.cwd,
            exe: runningProcess.exe,
            appImagePath: runningProcess.environ?.APPIMAGE,
          },
          targetPath
        );
      }

      return runningProcess.exe === targetPath;
    });

    if (matchesTargetPath) return true;

    return (
      process.platform === "linux" &&
      runningProcess.pid === launchedPid &&
      processReferencesExecutable(
        {
          cwd: runningProcess.cwd,
          exe: runningProcess.exe,
          appImagePath: runningProcess.environ?.APPIMAGE,
        },
        game.executablePath ?? ""
      )
    );
  });

  const linuxFallbackProcess =
    process.platform === "linux" &&
    !gameProcesses.length &&
    game.executablePath?.toLowerCase().endsWith(".exe")
      ? processes.find((runningProcess) => {
          const processCwd = runningProcess.cwd?.toLowerCase();
          const gameDirectory = path
            .dirname(game.executablePath!)
            .toLowerCase();

          if (!processCwd || processCwd !== gameDirectory) {
            return false;
          }

          const expectedPrefix = Wine.getEffectivePrefixPath(
            game.winePrefixPath,
            game.objectId
          )?.toLowerCase();
          const processPrefix =
            runningProcess.environ?.STEAM_COMPAT_DATA_PATH?.toLowerCase();

          if (
            expectedPrefix &&
            processPrefix &&
            processPrefix !== expectedPrefix
          ) {
            return false;
          }

          return runningProcess.exe?.toLowerCase().includes("wine") ?? false;
        })
      : null;

  const fallbackProcesses = linuxFallbackProcess ? [linuxFallbackProcess] : [];
  const processesToClose = gameProcesses.length
    ? gameProcesses
    : fallbackProcesses;

  for (const processToClose of processesToClose) {
    try {
      process.kill(processToClose.pid);
    } catch {
      sudo.exec(
        getKillCommand(processToClose.pid),
        { name: app.getName() },
        (error, _stdout, _stderr) => {
          logger.error(error);
        }
      );
    }
  }
};

registerEvent("closeGame", closeGame);
