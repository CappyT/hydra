import { registerEvent } from "../register-event";
import type { GameArtifact, GameShop } from "@types";
import {
  getArtifactBackend,
  localArtifactToGameArtifact,
} from "@main/services";

const getGameArtifacts = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop
): Promise<GameArtifact[]> => {
  if (shop === "custom") return [];

  const backend = await getArtifactBackend();
  const artifacts = await backend.list(shop, objectId);

  return artifacts.map(localArtifactToGameArtifact);
};

registerEvent("getGameArtifacts", getGameArtifacts);
