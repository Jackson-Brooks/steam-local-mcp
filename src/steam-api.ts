import { z } from "zod";
import { FileCache } from "./cache.js";

const LIBRARY_TTL_MS = 60 * 60 * 1000;
const RECENT_TTL_MS = 30 * 60 * 1000;
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION_LENGTH = 2_000;

const ownedGameSchema = z.object({
  appid: z.number().int().nonnegative(),
  name: z.string(),
  playtime_forever: z.number().nonnegative().optional(),
  playtime_2weeks: z.number().nonnegative().optional(),
  rtime_last_played: z.number().int().nonnegative().optional(),
});
const ownedGamesResponseSchema = z.object({ response: z.object({ games: z.array(ownedGameSchema).optional() }).optional() });
const priceSchema = z.object({ currency: z.string(), initial_formatted: z.string(), final_formatted: z.string(), discount_percent: z.number() });
const storeDataSchema = z.object({
  name: z.string(),
  short_description: z.string().optional(),
  detailed_description: z.string().optional(),
  developers: z.array(z.string()).optional(),
  publishers: z.array(z.string()).optional(),
  genres: z.array(z.object({ description: z.string() })).optional(),
  categories: z.array(z.object({ description: z.string() })).optional(),
  release_date: z.object({ coming_soon: z.boolean(), date: z.string() }).optional(),
  metacritic: z.object({ score: z.number() }).optional(),
  price_overview: priceSchema.optional(),
  website: z.string().nullable().optional(),
});
const storeResponseSchema = z.record(z.string(), z.object({ success: z.boolean(), data: storeDataSchema.optional() }));
const storeSearchItemSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  type: z.string().optional(),
  tiny_image: z.string().optional(),
  metascore: z.union([z.string(), z.number()]).optional(),
  price: z.object({ currency: z.string(), initial: z.number().nonnegative(), final: z.number().nonnegative(), discount_percent: z.number().nonnegative() }).optional(),
});
const storeSearchResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(storeSearchItemSchema) });

type SteamOwnedGame = z.infer<typeof ownedGameSchema>;
type SteamStoreData = z.infer<typeof storeDataSchema>;
type SteamStoreSearchItem = z.infer<typeof storeSearchItemSchema>;

export interface SteamApiConfiguration {
  apiKey?: string;
  steamId?: string;
}

export interface LibraryGame {
  appId: number;
  name: string;
  playtimeMinutes: number;
  playtimeHours: number;
  playtimeTwoWeeksMinutes: number;
  lastPlayed: string | null;
}

interface CachedStoreGameDetails {
  appId: string;
  name: string;
  description: string;
  developers: string[];
  publishers: string[];
  genres: string[];
  categories: string[];
  releaseDate: string | null;
  comingSoon: boolean;
  metacriticScore: number | null;
  price: z.infer<typeof priceSchema> | null;
  website: string | null;
}

export interface StoreGameDetails extends Omit<CachedStoreGameDetails, "description"> {
  description: string | null;
  descriptionIsUntrusted: boolean;
}

export interface StoreSearchResult {
  appId: number;
  name: string;
  type: string | null;
  metacriticScore: number | null;
  price: { currency: string; initial: number; final: number; discountPercent: number } | null;
}

export class SteamApiClient {
  constructor(
    private readonly config: SteamApiConfiguration,
    private readonly cache = new FileCache(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  configured(): boolean { return Boolean(this.config.apiKey && this.config.steamId); }

  async library(): Promise<LibraryGame[]> {
    const { apiKey, steamId } = this.requiredCredentials();
    const cacheKey = `library:${steamId}`;
    const cached = this.cache.get(cacheKey, parseLibraryGames);
    if (cached) return cached;
    const payload = await this.requestJson("https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/", { key: apiKey, steamid: steamId, include_appinfo: "true", include_played_free_games: "true" }, ownedGamesResponseSchema);
    const games = (payload.response?.games ?? []).map(normalizeLibraryGame).sort((left, right) => right.playtimeMinutes - left.playtimeMinutes || left.name.localeCompare(right.name));
    this.cache.set(cacheKey, games, LIBRARY_TTL_MS);
    return games;
  }

  async recentlyPlayed(): Promise<LibraryGame[]> {
    const { apiKey, steamId } = this.requiredCredentials();
    const cacheKey = `recent:${steamId}`;
    const cached = this.cache.get(cacheKey, parseLibraryGames);
    if (cached) return cached;
    const payload = await this.requestJson("https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/", { key: apiKey, steamid: steamId }, ownedGamesResponseSchema);
    const games = (payload.response?.games ?? []).map(normalizeLibraryGame).sort((left, right) => right.playtimeTwoWeeksMinutes - left.playtimeTwoWeeksMinutes || right.playtimeMinutes - left.playtimeMinutes);
    this.cache.set(cacheKey, games, RECENT_TTL_MS);
    return games;
  }

  async gameDetails(appId: string, language = "english", countryCode = "us", includeDescription = false): Promise<StoreGameDetails> {
    const normalizedAppId = String(appId);
    const normalizedLanguage = language.trim().toLocaleLowerCase();
    const normalizedCountry = countryCode.trim().toLocaleLowerCase();
    if (!/^\d+$/.test(normalizedAppId)) throw new Error("app_id must be a numeric Steam app ID.");
    if (!/^[a-z]{2}$/.test(normalizedCountry)) throw new Error("country_code must be a two-letter country code.");
    const cacheKey = `details:${normalizedAppId}:${normalizedLanguage}:${normalizedCountry}`;
    let details = this.cache.get(cacheKey, parseCachedStoreDetails);
    if (!details) {
      const url = new URL("https://store.steampowered.com/api/appdetails");
      url.search = new URLSearchParams({ appids: normalizedAppId, l: normalizedLanguage, cc: normalizedCountry }).toString();
      const response = await this.fetchWithTimeout(url);
      if (!response.ok) throw new Error(`Steam Store returned HTTP ${response.status}.`);
      const parsed = storeResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Steam Store returned an unexpected response.");
      const entry = parsed.data[normalizedAppId];
      if (!entry?.success || !entry.data) throw new Error(`Steam Store did not return details for app ID ${normalizedAppId}.`);
      details = normalizeStoreDetails(normalizedAppId, entry.data);
      this.cache.set(cacheKey, details, DETAILS_TTL_MS);
    }
    return { ...details, description: includeDescription ? details.description : null, descriptionIsUntrusted: includeDescription };
  }

  async searchStore(term: string, language = "english", countryCode = "us", limit = 10): Promise<{ total: number; results: StoreSearchResult[] }> {
    const normalizedTerm = term.trim();
    const normalizedLanguage = language.trim().toLocaleLowerCase();
    const normalizedCountry = countryCode.trim().toLocaleLowerCase();
    if (!normalizedTerm) throw new Error("Provide a search term.");
    if (!/^[a-z]{2}$/.test(normalizedCountry)) throw new Error("country_code must be a two-letter country code.");
    const cacheKey = `search:${normalizedTerm.toLocaleLowerCase()}:${normalizedLanguage}:${normalizedCountry}`;
    let result = this.cache.get(cacheKey, parseStoreSearch);
    if (!result) {
      const url = new URL("https://store.steampowered.com/api/storesearch/");
      url.search = new URLSearchParams({ term: normalizedTerm, l: normalizedLanguage, cc: normalizedCountry }).toString();
      const response = await this.fetchWithTimeout(url);
      if (!response.ok) throw new Error(`Steam Store returned HTTP ${response.status}.`);
      const parsed = storeSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Steam Store returned an unexpected search response.");
      result = { total: parsed.data.total, results: parsed.data.items.map(normalizeStoreSearchItem) };
      this.cache.set(cacheKey, result, SEARCH_TTL_MS);
    }
    return { total: result.total, results: result.results.slice(0, limit) };
  }

  clearCache(): number { return this.cache.clear(); }

  private requiredCredentials(): Required<SteamApiConfiguration> {
    if (!this.config.apiKey || !this.config.steamId) throw new Error("Steam Web API tools require STEAM_API_KEY and STEAM_ID. Local Steam tools work without them.");
    return { apiKey: this.config.apiKey, steamId: this.config.steamId };
  }

  private async requestJson<T>(baseUrl: string, parameters: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(baseUrl);
    url.search = new URLSearchParams(parameters).toString();
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`Steam Web API returned HTTP ${response.status}. Check credentials and profile privacy.`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Steam Web API returned an unexpected response.");
    return parsed.data;
  }

  private async fetchWithTimeout(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Steam request timed out. Please try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseLibraryGames(value: unknown): LibraryGame[] | undefined {
  const parsed = z.array(z.object({ appId: z.number().int(), name: z.string(), playtimeMinutes: z.number().nonnegative(), playtimeHours: z.number().nonnegative(), playtimeTwoWeeksMinutes: z.number().nonnegative(), lastPlayed: z.string().nullable() })).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseCachedStoreDetails(value: unknown): CachedStoreGameDetails | undefined {
  const parsed = z.object({ appId: z.string(), name: z.string(), description: z.string(), developers: z.array(z.string()), publishers: z.array(z.string()), genres: z.array(z.string()), categories: z.array(z.string()), releaseDate: z.string().nullable(), comingSoon: z.boolean(), metacriticScore: z.number().nullable(), price: priceSchema.nullable(), website: z.string().nullable() }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseStoreSearch(value: unknown): { total: number; results: StoreSearchResult[] } | undefined {
  const parsed = z.object({
    total: z.number().int().nonnegative(),
    results: z.array(z.object({ appId: z.number().int().nonnegative(), name: z.string(), type: z.string().nullable(), metacriticScore: z.number().nullable(), price: z.object({ currency: z.string(), initial: z.number().nonnegative(), final: z.number().nonnegative(), discountPercent: z.number().nonnegative() }).nullable() })),
  }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeLibraryGame(game: SteamOwnedGame): LibraryGame {
  const playtimeMinutes = game.playtime_forever ?? 0;
  return { appId: game.appid, name: game.name, playtimeMinutes, playtimeHours: Math.round((playtimeMinutes / 60) * 10) / 10, playtimeTwoWeeksMinutes: game.playtime_2weeks ?? 0, lastPlayed: game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null };
}

function normalizeStoreDetails(appId: string, data: SteamStoreData): CachedStoreGameDetails {
  return {
    appId, name: data.name, description: sanitizeStoreText(data.short_description ?? data.detailed_description ?? ""), developers: data.developers ?? [], publishers: data.publishers ?? [],
    genres: (data.genres ?? []).map((genre) => genre.description), categories: (data.categories ?? []).map((category) => category.description),
    releaseDate: data.release_date?.date ?? null, comingSoon: data.release_date?.coming_soon ?? false, metacriticScore: data.metacritic?.score ?? null, price: data.price_overview ?? null, website: data.website ?? null,
  };
}

function normalizeStoreSearchItem(item: SteamStoreSearchItem): StoreSearchResult {
  const metacriticScore = Number(item.metascore);
  return {
    appId: item.id, name: sanitizeStoreText(item.name).slice(0, 200), type: item.type ?? null,
    metacriticScore: Number.isFinite(metacriticScore) && metacriticScore > 0 ? metacriticScore : null,
    price: item.price ? { currency: item.price.currency, initial: item.price.initial, final: item.price.final, discountPercent: item.price.discount_percent } : null,
  };
}

function sanitizeStoreText(value: string): string {
  const plainText = value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return plainText.length > MAX_DESCRIPTION_LENGTH ? `${plainText.slice(0, MAX_DESCRIPTION_LENGTH)}...` : plainText;
}
