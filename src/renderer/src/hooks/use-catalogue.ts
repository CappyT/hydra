import axios from "axios";
import { useCallback, useEffect, useState } from "react";
import { levelDBService } from "@renderer/services/leveldb.service";
import type { DownloadSource } from "@types";
import { useAppDispatch } from "./redux";
import { setGenres, setTags } from "@renderer/features";

export const externalResourcesInstance = axios.create({
  baseURL: import.meta.env.RENDERER_VITE_EXTERNAL_RESOURCES_URL,
});

/**
 * Fetches an optional external catalogue resource. These resources only feed
 * non-critical catalogue-filter UI, so a failure (e.g. a 403 from an
 * unreachable CDN) must never bubble up to the global error handler and show
 * an "Unexpected error" modal. On failure we log and resolve to `null` so the
 * caller can keep its state at the default value.
 */
const fetchExternalResource = async <T>(path: string): Promise<T | null> => {
  try {
    const response = await externalResourcesInstance.get<T>(path);
    return response.data;
  } catch (error) {
    console.warn(`Failed to fetch external resource "${path}"`, error);
    return null;
  }
};

export function useCatalogue() {
  const dispatch = useAppDispatch();

  const [steamPublishers, setSteamPublishers] = useState<string[]>([]);
  const [steamDevelopers, setSteamDevelopers] = useState<string[]>([]);
  const [downloadSources, setDownloadSources] = useState<DownloadSource[]>([]);

  const getSteamUserTags = useCallback(async () => {
    const data = await fetchExternalResource<
      Record<string, Record<string, number>>
    >("/steam-user-tags.json");
    if (data) dispatch(setTags(data));
  }, [dispatch]);

  const getSteamGenres = useCallback(async () => {
    const data =
      await fetchExternalResource<Record<string, string[]>>(
        "/steam-genres.json"
      );
    if (data) dispatch(setGenres(data));
  }, [dispatch]);

  const getSteamPublishers = useCallback(async () => {
    const data = await fetchExternalResource<string[]>(
      "/steam-publishers.json"
    );
    if (data) setSteamPublishers(data);
  }, []);

  const getSteamDevelopers = useCallback(async () => {
    const data = await fetchExternalResource<string[]>(
      "/steam-developers.json"
    );
    if (data) setSteamDevelopers(data);
  }, []);

  const getDownloadSources = useCallback(() => {
    levelDBService.values("downloadSources").then((results) => {
      const sources = results as DownloadSource[];
      setDownloadSources(sources.filter((source) => !!source.fingerprint));
    });
  }, []);

  useEffect(() => {
    getSteamUserTags();
    getSteamGenres();
    getSteamPublishers();
    getSteamDevelopers();
    getDownloadSources();
  }, [
    getSteamUserTags,
    getSteamGenres,
    getSteamPublishers,
    getSteamDevelopers,
    getDownloadSources,
  ]);

  return { steamPublishers, downloadSources, steamDevelopers };
}
