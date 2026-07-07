import { dialog } from "electron";
import { registerEvent } from "../register-event";
import { GameShop } from "@types";
import { launchGame } from "@main/helpers";
import { SandboxUnavailableError } from "@main/services";

const openGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  executablePath: string,
  launchOptions?: string | null
) => {
  try {
    await launchGame({ shop, objectId, executablePath, launchOptions });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      dialog.showErrorBox("Hydra", error.message);
      return;
    }

    throw error;
  }
};

registerEvent("openGame", openGame);
