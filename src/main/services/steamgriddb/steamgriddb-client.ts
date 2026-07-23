import type {
  ArtworkItem,
  ArtworkKind,
  ArtworkPage,
  GameShop,
  UserPreferences,
} from "@types";

/**
 * Accountless fork: a direct SteamGridDB Web API v2 client used in place of the
 * Hydra API artwork proxy (which requires a logged-in Hydra account). The key is
 * user-provided (global preferences), mirroring the RetroAchievements Web API
 * integration. All value dependencies (axios, the level DB, the logger) are
 * dynamically imported so the pure response→ArtworkPage mapping below stays
 * testable without pulling in Electron.
 */

const STEAMGRIDDB_BASE_URL = "https://www.steamgriddb.com/api/v2";
const STEAMGRIDDB_TIMEOUT_MS = 10_000;

// SteamGridDB returns a fixed page of 50 items; a full page means "there may be
// more" (mirrors the upstream game-artwork.ts ARTWORK_PAGE_SIZE contract).
export const STEAMGRIDDB_PAGE_SIZE = 50;

const PORTRAIT_GRID_DIMENSIONS = "600x900,342x482,660x930";

// Copied verbatim from the upstream KIND_PARAMS (game-artwork.ts) so the direct
// client requests the same styles/dimensions/mimes the Hydra proxy did.
const KIND_PARAMS: Record<ArtworkKind, Record<string, string>> = {
  grids: {
    nsfw: "false",
    dimensions: PORTRAIT_GRID_DIMENSIONS,
    mimes: "image/png,image/jpeg,image/webp",
  },
  heroes: { nsfw: "false", mimes: "image/png,image/jpeg,image/webp" },
  logos: { nsfw: "false", mimes: "image/png,image/webp" },
  icons: { nsfw: "false", mimes: "image/png,image/vnd.microsoft.icon" },
};

interface SteamGridDbArtworkResponse {
  success?: boolean;
  data?: ArtworkItem[];
}

interface SteamGridDbAutocompleteResponse {
  success?: boolean;
  data?: { id: number; name: string }[];
}

export const emptyArtworkPage = (): ArtworkPage => ({
  items: [],
  cache: "fresh",
  hasMore: false,
});

/**
 * Pure mapping from an HTTP status + response body to an ArtworkPage. Any
 * non-2xx status (including 404 empty pages and 401/403 bad-key responses) maps
 * to an empty page so an invalid or missing key can never throw into the picker.
 */
export const mapArtworkResponse = (
  status: number,
  data: unknown
): ArtworkPage => {
  if (status < 200 || status >= 300) return emptyArtworkPage();

  const items = (data as SteamGridDbArtworkResponse | null)?.data ?? [];

  return {
    items,
    cache: "fresh",
    hasMore: items.length === STEAMGRIDDB_PAGE_SIZE,
  };
};

// Resolved SteamGridDB game ids for non-Steam shops, keyed `${shop}:${objectId}`,
// so paging and kind switches don't re-run the autocomplete search.
const resolvedGameIdCache = new Map<string, number>();

let steamGridDbClient: import("axios").AxiosInstance | null = null;

const getClient = async () => {
  if (!steamGridDbClient) {
    const { default: axios } = await import("axios");
    steamGridDbClient = axios.create({
      baseURL: STEAMGRIDDB_BASE_URL,
      timeout: STEAMGRIDDB_TIMEOUT_MS,
    });
  }

  return steamGridDbClient;
};

const authHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
});

const warn = async (message: string, error?: unknown) => {
  const { logger } = await import("../logger");
  logger.warn(message, error);
};

const getApiKey = async (): Promise<string | null> => {
  const { db, levelKeys } = await import("@main/level");
  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    { valueEncoding: "json" }
  );

  return userPreferences?.steamGridDbApiKey?.trim() || null;
};

/**
 * Resolves the `/{kind}/…` path suffix for a game: Steam apps address the
 * SteamGridDB `steam/{appId}` endpoint directly; other shops are resolved to a
 * SteamGridDB game id via an autocomplete search on the stored game title.
 */
const resolveArtworkTarget = async (
  shop: GameShop,
  objectId: string,
  apiKey: string
): Promise<string | null> => {
  if (shop === "steam") return `steam/${objectId}`;

  const cacheKey = `${shop}:${objectId}`;
  const cached = resolvedGameIdCache.get(cacheKey);
  if (cached != null) return `game/${cached}`;

  const { gamesSublevel, levelKeys } = await import("@main/level");
  const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
  const title = game?.title?.trim();
  if (!title) return null;

  const client = await getClient();
  const response = await client.get<SteamGridDbAutocompleteResponse>(
    `/search/autocomplete/${encodeURIComponent(title)}`,
    { headers: authHeaders(apiKey), validateStatus: () => true }
  );

  if (response.status < 200 || response.status >= 300) return null;

  const first = response.data?.data?.[0];
  if (!first) return null;

  resolvedGameIdCache.set(cacheKey, first.id);
  return `game/${first.id}`;
};

export const fetchSteamGridDbArtwork = async (
  shop: GameShop,
  objectId: string,
  kind: ArtworkKind,
  page = 0
): Promise<ArtworkPage> => {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) return emptyArtworkPage();

    const target = await resolveArtworkTarget(shop, objectId, apiKey);
    if (!target) return emptyArtworkPage();

    const client = await getClient();
    const response = await client.get<SteamGridDbArtworkResponse>(
      `/${kind}/${target}`,
      {
        headers: authHeaders(apiKey),
        params: { ...KIND_PARAMS[kind], page },
        validateStatus: () => true,
      }
    );

    if (response.status === 401 || response.status === 403) {
      await warn(
        `SteamGridDB rejected the API key (status ${response.status})`
      );
    }

    return mapArtworkResponse(response.status, response.data);
  } catch (error) {
    await warn("Failed to fetch SteamGridDB artwork", error);
    return emptyArtworkPage();
  }
};

/**
 * Cheap key probe: a 2xx from a fixed public grids request means the key works.
 */
export const validateSteamGridDbApiKey = async (
  apiKey: string
): Promise<boolean> => {
  const trimmed = (apiKey ?? "").trim();
  if (!trimmed) return false;

  try {
    const client = await getClient();
    // SteamGridDB serves a short-TTL URL-keyed response cache that skips auth:
    // right after a successful request, the same URL returns 200 to ANY
    // non-empty bearer (observed live). A unique probe param forces a cache
    // miss so the key is actually checked.
    const response = await client.get("/grids/steam/440", {
      headers: authHeaders(trimmed),
      params: { page: 0, probe: Date.now() },
      validateStatus: () => true,
    });

    return response.status >= 200 && response.status < 300;
  } catch (error) {
    await warn("Failed to validate SteamGridDB API key", error);
    return false;
  }
};
