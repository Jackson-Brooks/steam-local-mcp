import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileCache } from "../src/cache.js";

test("rejects malformed cache entries instead of treating them as fresh", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "steam-mcp-cache-test-"));
  try {
    const cache = new FileCache(directory);
    cache.set("library", [{ name: "valid" }], 60_000);
    const cacheFile = path.join(directory, readdirSync(directory)[0]);
    writeFileSync(cacheFile, JSON.stringify({ value: [{ name: "stale" }] }), "utf8");
    assert.equal(cache.get("library", (value) => Array.isArray(value) ? value : undefined), null);
    assert.equal(readdirSync(directory).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
