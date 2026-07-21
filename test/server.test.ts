import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LocalGame } from "../src/local-steam.js";
import { ServerDependencies, createServer } from "../src/server.js";

const installedGame: LocalGame = {
  appId: "2379780", name: "Balatro", installDir: "Balatro", libraryDir: "C:\\Steam", lastPlayed: 1_700_000_000, sizeOnDisk: 100,
  stateFlags: 4, installationState: "installed", needsUpdate: false, bytesToDownload: 0, bytesDownloaded: 0, bytesToStage: 0, bytesStaged: 0,
};
const updatingGame: LocalGame = {
  ...installedGame, appId: "10", name: "Update Game", stateFlags: 6, installationState: "update-pending", needsUpdate: true,
  bytesToDownload: 200, bytesDownloaded: 75, bytesToStage: 300, bytesStaged: 50,
};

function toolText(result: unknown): string {
  const value = result as { content?: unknown; isError?: boolean };
  assert.equal(value.isError, undefined);
  assert.ok(Array.isArray(value.content));
  assert.equal(value.content.length, 1);
  const content = value.content[0] as { type?: unknown; text?: unknown };
  assert.equal(content.type, "text");
  if (typeof content.text !== "string") throw new Error("Tool response did not contain text.");
  return content.text;
}

function parseToolResult(result: unknown): unknown {
  return JSON.parse(toolText(result));
}

test("exposes and executes every MCP tool through the MCP protocol", async () => {
  const openedUrls: string[] = [];
  let cacheClears = 0;
  const dependencies: ServerDependencies = {
    local: {
      installedGames: () => [installedGame],
      findInstalledGames: (query) => query === "missing" ? [] : [installedGame],
      localGameStatuses: () => [installedGame, updatingGame],
      libraryStorage: () => [{ libraryDir: "C:\\Steam", installedGames: 1, installedBytes: 100, availableBytes: 1_000, totalBytes: 2_000 }],
      openSteamUrl: async (url) => { openedUrls.push(url); return true; },
      steamInstallation: () => ({ directory: "C:\\Steam", source: "environment" }),
      steamRunning: async () => false,
    },
    api: {
      configured: () => true,
      clearCache: () => { cacheClears += 1; return 3; },
      library: async () => [
        { appId: 1, name: "Played", playtimeMinutes: 120, playtimeHours: 2, playtimeTwoWeeksMinutes: 30, lastPlayed: "2024-01-01T00:00:00.000Z" },
        { appId: 2, name: "Unplayed", playtimeMinutes: 0, playtimeHours: 0, playtimeTwoWeeksMinutes: 0, lastPlayed: null },
      ],
      recentlyPlayed: async () => [{ appId: 1, name: "Played", playtimeMinutes: 120, playtimeHours: 2, playtimeTwoWeeksMinutes: 30, lastPlayed: "2024-01-01T00:00:00.000Z" }],
      searchStore: async () => ({ total: 1, results: [{ appId: 2379780, name: "Balatro", type: "app", metacriticScore: 90, price: null }] }),
      gameDetails: async () => ({ appId: "2379780", name: "Balatro", developers: ["LocalThunk"], publishers: ["Playstack"], genres: ["Strategy"], categories: ["Single-player"], releaseDate: "20 Feb, 2024", comingSoon: false, metacriticScore: 90, price: null, website: null, description: null, descriptionIsUntrusted: false }),
    },
  };
  const server = createServer(dependencies);
  const client = new Client({ name: "steam-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "steam_api_status", "steam_client_status", "steam_find_game", "steam_get_download_status", "steam_get_game_details", "steam_get_game_install_status",
      "steam_get_library", "steam_get_library_storage", "steam_get_recently_played", "steam_install_game", "steam_launch_game", "steam_list_games",
      "steam_open_client_page", "steam_open_library_page", "steam_open_store_page", "steam_refresh_cache", "steam_search_store",
    ]);

    assert.equal((parseToolResult(await client.callTool({ name: "steam_list_games", arguments: { limit: 10, offset: 0 } })) as { total: number }).total, 1);
    assert.equal(((parseToolResult(await client.callTool({ name: "steam_find_game", arguments: { query: "Balatro" } })) as { games: unknown[] }).games).length, 1);
    assert.equal(((parseToolResult(await client.callTool({ name: "steam_get_game_install_status", arguments: { query: "Game" } })) as { games: Array<{ needs_update: boolean }> }).games)[0].needs_update, true);
    assert.equal(((parseToolResult(await client.callTool({ name: "steam_get_download_status", arguments: { include_idle: false, limit: 10, offset: 0 } })) as { games: unknown[] }).games).length, 1);
    assert.equal(((parseToolResult(await client.callTool({ name: "steam_get_library_storage", arguments: {} })) as { libraries: unknown[] }).libraries).length, 1);

    assert.match(toolText(await client.callTool({ name: "steam_launch_game", arguments: { query: "Balatro" } })), /Started Steam quietly/);
    toolText(await client.callTool({ name: "steam_open_store_page", arguments: { app_id: 2379780 } }));
    assert.equal(((parseToolResult(await client.callTool({ name: "steam_search_store", arguments: { query: "Balatro", limit: 10 } })) as { results: Array<{ appId: number }> }).results)[0].appId, 2379780);
    toolText(await client.callTool({ name: "steam_install_game", arguments: { app_id: "2379780" } }));
    toolText(await client.callTool({ name: "steam_open_library_page", arguments: { query: "Balatro" } }));
    toolText(await client.callTool({ name: "steam_open_client_page", arguments: { page: "downloads" } }));
    assert.deepEqual(openedUrls, ["steam://run/2379780", "steam://store/2379780", "steam://install/2379780", "steam://nav/games/details/2379780", "steam://open/downloads"]);

    assert.equal((parseToolResult(await client.callTool({ name: "steam_client_status", arguments: {} })) as { discovery_source: string }).discovery_source, "environment");
    assert.equal((parseToolResult(await client.callTool({ name: "steam_get_library", arguments: { unplayed_only: true, limit: 10, offset: 0 } })) as { total: number }).total, 1);
    assert.equal((parseToolResult(await client.callTool({ name: "steam_get_recently_played", arguments: { limit: 10, offset: 0 } })) as { total: number }).total, 1);
    assert.equal((parseToolResult(await client.callTool({ name: "steam_get_game_details", arguments: { app_id: 2379780 } })) as { name: string }).name, "Balatro");
    assert.equal((parseToolResult(await client.callTool({ name: "steam_refresh_cache", arguments: {} })) as { cleared_entries: number }).cleared_entries, 3);
    assert.equal(cacheClears, 1);
    assert.equal((parseToolResult(await client.callTool({ name: "steam_api_status", arguments: {} })) as { configured: boolean }).configured, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("reports local errors without opening Steam", async () => {
  const server = createServer({ local: { findInstalledGames: () => [], openSteamUrl: async () => { throw new Error("must not run"); } } });
  const client = new Client({ name: "steam-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "steam_launch_game", arguments: { query: "missing" } });
    const value = result as { isError?: boolean; content?: unknown };
    assert.equal(value.isError, true);
    assert.ok(Array.isArray(value.content));
    const content = value.content[0] as { type?: unknown; text?: unknown };
    assert.match(content.type === "text" && typeof content.text === "string" ? content.text : "", /No installed Steam game matched/);
  } finally {
    await client.close();
    await server.close();
  }
});
