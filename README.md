# Steam Local MCP

A free, open-source Windows [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an MCP-capable agent work with the Steam client installed for the current Windows user.

Ask an agent to find an installed game, launch it, open its Steam page, check local download/update status, search the Store, or summarize Steam-library storage. Steam starts quietly in the background when a requested client action needs it.

This is a standard **stdio MCP server**. It is agent-neutral: use it with Codex, Claude, or any other MCP client that can run a local command.

## What it can do

### Local Steam tools — no API key

- `steam_list_games` and `steam_find_game` — inspect locally installed games across all configured Steam libraries.
- `steam_launch_game` — launch one installed game by name or app ID.
- `steam_get_game_install_status` and `steam_get_download_status` — inspect manifest-recorded install, update, download, and paused-download states.
- `steam_get_library_storage` — show installed sizes and free disk space for every local Steam library.
- `steam_open_library_page`, `steam_open_store_page`, and `steam_open_client_page` — navigate the Steam client.
- `steam_install_game` — ask Steam to install an app ID; Steam validates ownership and manages the install flow.
- `steam_client_status` — report the detected Steam installation, discovery source, and whether Steam is running.

### Public Store tools — no API key

- `steam_search_store` — find Store app IDs from a game name.
- `steam_get_game_details` — get public metadata, price, genres, release date, and Metacritic score.

### Optional account tools — Steam Web API key required

Set `STEAM_API_KEY` and `STEAM_ID` to enable:

- `steam_api_status` — verify if API credentials are configured, valid, and connected to Steam's Web API.
- `steam_get_library` — owned games, playtime, last played, filtering, and pagination.
- `steam_get_recently_played` — recently played games, ordered by two-week playtime.

## Requirements

- Windows 10 or newer
- Steam installed for the current Windows user
- Node.js 20 or newer

## Install from npm

To install the published package via npm, add this equivalent configuration to your MCP client:

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "steam-local-mcp"]
    }
  }
}
```

The configuration-file location differs by agent, but the command and arguments above remain the same. Restart or reconnect your MCP client after saving its configuration.

To confirm your install manually, run:

```powershell
npx -y steam-local-mcp print-config
```

## Install from source

Use this when developing, auditing the source, or before an npm release is available:

```powershell
git clone https://github.com/Jackson-Brooks/steam-local-mcp.git
cd steam-local-mcp
npm install
npm run build
```

Then configure your MCP client to run the compiled entry point from the directory you cloned:

```json
{
  "mcpServers": {
    "steam": {
      "command": "node",
      "args": ["C:\\path\\to\\steam-local-mcp\\dist\\src\\index.js"]
    }
  }
}
```

Replace `C:\path\to\steam-local-mcp` with your own clone location. Do not use another user's path.

## Optional Steam Web API configuration

Pass credentials through your MCP client's environment configuration or the operating-system environment:

```json
{
  "mcpServers": {
    "steam": {
      "command": "npx",
      "args": ["-y", "steam-local-mcp"],
      "env": {
        "STEAM_API_KEY": "your_key",
        "STEAM_ID": "your_64_bit_steam_id"
      }
    }
  }
}
```

The server never loads a `.env` file automatically. Never commit credentials. Steam profile and game-details privacy settings can prevent account tools from returning data; local client controls still work for private profiles.

### Getting your Steam API credentials

1. Sign in to Steam in a browser and open the [Steam Web API key page](https://steamcommunity.com/dev/apikey).
2. Create or copy your key, then set it as `STEAM_API_KEY` in your MCP client's environment configuration. Keep it private.
3. Set `STEAM_ID` to your numeric **64-bit Steam ID**, not your account name. It is commonly visible in a profile URL such as `https://steamcommunity.com/profiles/7656119...`.
4. Restart or reconnect your MCP client, then call `steam_api_status` to confirm that the credentials are configured.

With the key configured, an agent can answer requests such as “show my unplayed Steam games” or “what have I played recently?” The key is optional: launching games, local install status, storage, Store search, and Store metadata work without it.

## Steam detection and local status

Steam Local MCP checks, in order:

1. `STEAM_PATH` — either the Steam directory or its `steam.exe`
2. Current-user and machine Valve registry keys
3. Conventional per-user, Program Files, and `C:\Steam` locations
4. `steam.exe` on `PATH`

Use `steam_client_status` to see the selected path and discovery source. For a portable or unusual custom-drive install, set `STEAM_PATH` to the directory containing `steam.exe`.

Installation/download tools read Steam's local app manifests. `needs_update: true` means Steam has already recorded an update as pending. `false` means no pending update is currently recorded locally; it does not force a network update check.

## Privacy and safety

- Local tools read local Steam files and open Steam URIs; they do not require a Steam Web API key.
- `steam_launch_game` only launches games found in a local installed-game manifest.
- Steam starts hidden when required for an action, rather than opening a visible launcher window first.
- There is no purchase or uninstall tool.
- Public Store descriptions are omitted by default. If explicitly requested, descriptions are capped, converted to plain text, and marked as untrusted external content.
- Web API and Store responses are cached locally under `%LOCALAPPDATA%\steam-local-mcp\cache` by default. Set `STEAM_MCP_CACHE_DIR` to override it, and call `steam_refresh_cache` to clear it.

## Development

```powershell
npm install
npm test
npm pack --dry-run
```

The test suite includes local parsing/caching tests, mocked Store and API tests, all-tool MCP protocol tests, and a real stdio handshake for the packaged entry point.

## Contributing

Issues and pull requests are welcome. Please include a regression test for behavior changes, and keep destructive Steam operations out of scope unless they are explicitly designed and documented.

## License

[MIT](LICENSE)
