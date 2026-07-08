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

  // The backends list artifacts in filesystem order; sort newest-first so the
  // UI always shows the most recent backup at the top.
  const toMs = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
  };

  return artifacts
    .slice()
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .map(localArtifactToGameArtifact);
};

registerEvent("getGameArtifacts", getGameArtifacts);
