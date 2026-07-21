import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("CLI prints portable configuration and help", async () => {
  const config = await execFileAsync(process.execPath, [serverEntry, "print-config"]);
  assert.deepEqual(JSON.parse(config.stdout), { mcpServers: { steam: { command: "npx", args: ["-y", "steam-local-mcp"] } } });
  const help = await execFileAsync(process.execPath, [serverEntry, "--help"]);
  assert.match(help.stdout, /Usage: steam-local-mcp/);
});

test("packaged executable completes a real stdio MCP handshake", { timeout: 10_000 }, async () => {
  const client = new Client({ name: "steam-mcp-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], stderr: "pipe" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 17);
    const status = await client.callTool({ name: "steam_client_status", arguments: {} });
    assert.ok("content" in status);
    const content = (status as { content: Array<{ type: string; text?: string }> }).content[0];
    assert.equal(content.type, "text");
    const data = JSON.parse(content.text ?? "{}") as { steam_installation?: string | null; discovery_source?: string | null; client_running?: boolean };
    assert.ok(data.steam_installation === null || typeof data.steam_installation === "string");
    assert.ok(data.discovery_source === null || typeof data.discovery_source === "string");
    assert.equal(typeof data.client_running, "boolean");
  } finally {
    await client.close();
  }
});
