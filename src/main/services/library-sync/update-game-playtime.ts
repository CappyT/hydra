import type { Game } from "@types";
import { HydraApi } from "../hydra-api";
import { ACCOUNTLESS } from "@shared";

export const trackGamePlaytime = async (
  game: Game,
  deltaInMillis: number,
  lastTimePlayed: Date
) => {
  if (ACCOUNTLESS) return;

  if (game.shop === "custom") {
    return;
  }

  return HydraApi.put(`/profile/games/${game.shop}/${game.objectId}`, {
    playTimeDeltaInSeconds: Math.trunc(deltaInMillis / 1000),
    lastTimePlayed,
  });
};
