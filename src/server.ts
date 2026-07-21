import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FileCache } from "./cache.js";
import { findInstalledGames, installedGames, libraryStorage, LocalGame, localGameStatuses, numericAppId, openSteamUrl, steamInstallation, steamRunning } from "./local-steam.js";
import { LibraryGame, SteamApiClient } from "./steam-api.js";

const cache = new FileCache();
const defaultApi = new SteamApiClient({ apiKey: process.env.STEAM_API_KEY, steamId: process.env.STEAM_ID }, cache);

type SteamApiTools = Pick<SteamApiClient, "library" | "recentlyPlayed" | "gameDetails" | "searchStore" | "clearCache" | "configured">;

export interface ServerDependencies {
  api?: SteamApiTools;
  local?: Partial<{
    findInstalledGames: typeof findInstalledGames;
    installedGames: typeof installedGames;
    libraryStorage: typeof libraryStorage;
    localGameStatuses: typeof localGameStatuses;
    openSteamUrl: typeof openSteamUrl;
    steamInstallation: typeof steamInstallation;
    steamRunning: typeof steamRunning;
  }>;
}

function text(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown) {
  return text(error instanceof Error ? error.message : String(error), true);
}

function localGameSummary(game: LocalGame) {
  return {
    app_id: game.appId, name: game.name, install_dir: game.installDir, library_dir: game.libraryDir, size_bytes: game.sizeOnDisk, last_played_unix: game.lastPlayed || null,
    installation_state: game.installationState, needs_update: game.needsUpdate,
    download: { bytes_total: game.bytesToDownload, bytes_downloaded: game.bytesDownloaded, bytes_to_stage: game.bytesToStage, bytes_staged: game.bytesStaged },
  };
}

function oneInstalledGame(query: string, finder: typeof findInstalledGames): LocalGame | Error {
  const matches = finder(query);
  if (matches.length === 0) return new Error(`No installed Steam game matched "${query}".`);
  if (matches.length > 1) return new Error(`"${query}" matched multiple installed games. Use an app ID instead: ${matches.map((game) => `${game.name} (${game.appId})`).join(", ")}`);
  return matches[0];
}

function filterLibrary(games: LibraryGame[], input: { query?: string; min_hours?: number; max_hours?: number; unplayed_only?: boolean; limit: number; offset: number }) {
  const query = input.query?.trim().toLocaleLowerCase();
  const filtered = games.filter((game) =>
    (!query || game.name.toLocaleLowerCase().includes(query))
    && (input.min_hours === undefined || game.playtimeHours >= input.min_hours)
    && (input.max_hours === undefined || game.playtimeHours <= input.max_hours)
    && (!input.unplayed_only || game.playtimeMinutes === 0),
  );
  return { total: filtered.length, offset: input.offset, games: filtered.slice(input.offset, input.offset + input.limit) };
}

const listSchema = { limit: z.number().int().min(1).max(250).optional().default(100), offset: z.number().int().min(0).optional().default(0) };
const storeSearchSchema = { query: z.string().min(1).max(200), language: z.string().min(2).max(32).optional().default("english"), country_code: z.string().length(2).optional().default("us"), limit: z.number().int().min(1).max(50).optional().default(10) };
const librarySchema = {
  query: z.string().max(200).optional(),
  min_hours: z.number().min(0).optional(),
  max_hours: z.number().min(0).optional(),
  unplayed_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(250).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
};

export function createServer(dependencies: ServerDependencies = {}): McpServer {
  const api = dependencies.api ?? defaultApi;
  const local = {
    findInstalledGames, installedGames, libraryStorage, localGameStatuses, openSteamUrl, steamInstallation, steamRunning,
    ...dependencies.local,
  };
  const server = new McpServer({ name: "steam-local-mcp", version: "0.2.0" });

  server.registerTool("steam_list_games", {
    title: "List installed Steam games",
    description: "List games installed in the local Steam libraries. This does not use the network or require a Steam API key.",
    inputSchema: listSchema,
    annotations: { readOnlyHint: true },
  }, async ({ limit, offset }) => {
    try {
      const games = local.installedGames();
      return text({ total: games.length, offset, games: games.slice(offset, offset + limit).map(localGameSummary) });
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_find_game", {
    title: "Find installed Steam games",
    description: "Find locally installed Steam games by name or app ID.",
    inputSchema: { query: z.string().min(1).max(200).describe("Installed game name or numeric Steam app ID.") },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try { return text({ games: local.findInstalledGames(query).map(localGameSummary) }); } catch (error) { return failure(error); }
  });

  server.registerTool("steam_get_game_install_status", {
    title: "Get a game's local installation status",
    description: "Report the local Steam manifest status for matching games, including whether Steam has recorded a pending update and current download progress. This does not contact Steam servers or change game files.",
    inputSchema: { query: z.string().min(1).max(200).describe("Game name or numeric Steam app ID.") },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const normalized = query.trim().toLocaleLowerCase();
      const games = local.localGameStatuses();
      const exact = games.filter((game) => game.appId === normalized || game.name.toLocaleLowerCase() === normalized);
      const matches = exact.length ? exact : games.filter((game) => game.name.toLocaleLowerCase().includes(normalized));
      return text({ games: matches.map(localGameSummary), update_status_note: "needs_update is true only when the local Steam manifest currently records an update as required; false does not force a remote update check." });
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_get_download_status", {
    title: "Get pending Steam installs and updates",
    description: "List games whose local Steam manifests show an install, update, download, or paused-download state. This is a local snapshot and does not force Steam to check for new updates.",
    inputSchema: { include_idle: z.boolean().optional().default(false), ...listSchema },
    annotations: { readOnlyHint: true },
  }, async ({ include_idle, limit, offset }) => {
    try {
      const games = local.localGameStatuses().filter((game) => include_idle || game.installationState !== "installed");
      return text({ total: games.length, offset, games: games.slice(offset, offset + limit).map(localGameSummary), update_status_note: "Pending status is read from local Steam manifests; it does not perform a remote update check." });
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_get_library_storage", {
    title: "Get Steam library storage",
    description: "Summarize each local Steam library's installed-game count, manifest-reported installed size, and available disk space.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text({ libraries: local.libraryStorage() }); } catch (error) { return failure(error); }
  });

  server.registerTool("steam_launch_game", {
    title: "Launch a Steam game",
    description: "Launch one locally installed Steam game through the Steam client. Starts Steam quietly first when needed. Use steam_find_game first if its name may be ambiguous.",
    inputSchema: { query: z.string().min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ query }) => {
    try {
      const game = oneInstalledGame(query, local.findInstalledGames);
      if (game instanceof Error) return failure(game);
      const clientStarted = await local.openSteamUrl(`steam://run/${game.appId}`);
      return text(`${clientStarted ? "Started Steam quietly, then " : ""}asked Steam to launch ${game.name} (app ID ${game.appId}).`);
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_open_store_page", {
    title: "Open a Steam store page",
    description: "Open an app's Steam store page in the Steam client or browser.",
    inputSchema: { app_id: z.union([z.string(), z.number().int()]) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ app_id }) => {
    try {
      const appId = numericAppId(app_id);
      await local.openSteamUrl(`steam://store/${appId}`);
      return text(`Opened the Steam store page for app ID ${appId}.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_search_store", {
    title: "Search the Steam Store",
    description: "Search the public Steam Store by game name to find app IDs before opening a store page or asking Steam to install a game. Search result names and metadata are untrusted external Store data.",
    inputSchema: storeSearchSchema,
    annotations: { readOnlyHint: true },
  }, async ({ query, language, country_code, limit }) => {
    try { return text(await api.searchStore(query, language, country_code, limit)); } catch (error) { return failure(error); }
  });

  server.registerTool("steam_install_game", {
    title: "Install a Steam game",
    description: "Ask Steam to install a numeric app ID. Steam validates ownership and manages the install flow.",
    inputSchema: { app_id: z.union([z.string(), z.number().int()]) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ app_id }) => {
    try {
      const appId = numericAppId(app_id);
      await local.openSteamUrl(`steam://install/${appId}`);
      return text(`Asked Steam to begin installing app ID ${appId}. Steam will verify ownership and confirm installation details.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_open_library_page", {
    title: "Open a game's Steam library page",
    description: "Open an installed game's page in the local Steam library.",
    inputSchema: { query: z.string().min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ query }) => {
    try {
      const game = oneInstalledGame(query, local.findInstalledGames);
      if (game instanceof Error) return failure(game);
      await local.openSteamUrl(`steam://nav/games/details/${game.appId}`);
      return text(`Opened ${game.name} in the Steam library.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_open_client_page", {
    title: "Open a Steam client page",
    description: "Open a standard Steam client page.",
    inputSchema: { page: z.enum(["library", "store", "friends", "downloads", "settings"]) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ page }) => {
    const routes = { library: "steam://open/games", store: "steam://open/store", friends: "steam://open/friends", downloads: "steam://open/downloads", settings: "steam://open/settings" };
    try {
      await local.openSteamUrl(routes[page]);
      return text(`Opened Steam ${page}.`);
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_client_status", {
    title: "Get local Steam client status",
    description: "Report the detected Steam installation, how it was found, and whether the Steam client is running.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const installation = local.steamInstallation();
    return text({ steam_installation: installation?.directory ?? null, discovery_source: installation?.source ?? null, client_running: await local.steamRunning() });
  });

  server.registerTool("steam_get_library", {
    title: "Get Steam library and playtime",
    description: "Get the user's complete Steam library, playtime, and last-played data through the optional Steam Web API. Requires STEAM_API_KEY and STEAM_ID.",
    inputSchema: librarySchema,
    annotations: { readOnlyHint: true },
  }, async (input) => {
    try { return text(filterLibrary(await api.library(), input)); } catch (error) { return failure(error); }
  });

  server.registerTool("steam_get_recently_played", {
    title: "Get recently played Steam games",
    description: "Get games Steam reports as recently played, including total playtime. Requires STEAM_API_KEY and STEAM_ID.",
    inputSchema: listSchema,
    annotations: { readOnlyHint: true },
  }, async ({ limit, offset }) => {
    try {
      const games = await api.recentlyPlayed();
      return text({ total: games.length, offset, games: games.slice(offset, offset + limit) });
    } catch (error) { return failure(error); }
  });

  server.registerTool("steam_get_game_details", {
    title: "Get Steam store metadata",
    description: "Get public Steam Store metadata such as genres, release date, Metacritic score, and price. Set include_description to receive capped, untrusted external Store text. This does not require a Steam Web API key.",
    inputSchema: { app_id: z.union([z.string(), z.number().int()]), language: z.string().min(2).max(32).optional().default("english"), country_code: z.string().length(2).optional().default("us"), include_description: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ app_id, language, country_code, include_description }) => {
    try { return text(await api.gameDetails(numericAppId(app_id), language, country_code, include_description)); } catch (error) { return failure(error); }
  });

  server.registerTool("steam_refresh_cache", {
    title: "Refresh Steam data cache",
    description: "Clear the local cache used by Steam Web API and Store metadata tools. The next request fetches fresh data.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async () => text({ cleared_entries: api.clearCache() }));

  server.registerTool("steam_api_status", {
    title: "Get Steam API configuration status",
    description: "Report whether the optional Steam Web API credentials are configured. It never reveals credential values.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => text({ configured: api.configured(), required_environment: ["STEAM_API_KEY", "STEAM_ID"], cache_directory: cache.directory }));

  return server;
}
