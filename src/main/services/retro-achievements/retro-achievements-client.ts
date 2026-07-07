import axios, { AxiosInstance } from "axios";
import https from "node:https";

export interface RetroAchievementsApiAchievement {
  ID: number;
  Title: string;
  Description: string;
  Points: number;
  BadgeName: string;
  DateEarned?: string;
  DateEarnedHardcore?: string;
}

export interface RetroAchievementsGameInfoAndUserProgress {
  Achievements: Record<string, RetroAchievementsApiAchievement>;
}

export interface RetroAchievementsUserProfile {
  User: string;
  ID?: number;
  ULID?: string;
}

interface GetGameInfoAndUserProgressParams {
  username: string;
  webApiKey: string;
  raGameId: number;
}

interface GetUserProfileParams {
  username: string;
  webApiKey: string;
}

export class RetroAchievementsClient {
  private static readonly instance: AxiosInstance = axios.create({
    baseURL: "https://retroachievements.org/API",
    httpsAgent: new https.Agent({ family: 4 }),
  });

  static async getGameInfoAndUserProgress({
    username,
    webApiKey,
    raGameId,
  }: GetGameInfoAndUserProgressParams) {
    const response =
      await this.instance.get<RetroAchievementsGameInfoAndUserProgress>(
        "/API_GetGameInfoAndUserProgress.php",
        { params: { u: username, y: webApiKey, g: raGameId } }
      );

    return response.data;
  }

  static async getUserProfile({
    username,
    webApiKey,
  }: GetUserProfileParams) {
    const response = await this.instance.get<RetroAchievementsUserProfile>(
      "/API_GetUserProfile.php",
      { params: { u: username, z: username, y: webApiKey } }
    );

    return response.data;
  }
}
