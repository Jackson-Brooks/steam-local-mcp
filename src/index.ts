#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  if (process.argv[2] === "print-config") {
    process.stdout.write(`${JSON.stringify({ mcpServers: { steam: { command: "npx", args: ["-y", "steam-local-mcp"] } } }, null, 2)}\n`);
    return;
  }
  if (process.argv[2] === "--help") {
    process.stdout.write("Usage: steam-local-mcp [print-config]\n");
    return;
  }
  const server: McpServer = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("[steam-local-mcp] Server connected over stdio.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`[steam-local-mcp] Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
