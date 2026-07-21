import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface CacheRecord<T> {
  expiresAt: number;
  value: T;
}

function defaultCacheDirectory(): string {
  if (process.env.STEAM_MCP_CACHE_DIR) return process.env.STEAM_MCP_CACHE_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "steam-local-mcp", "cache");
  }
  return path.join(homedir(), ".cache", "steam-local-mcp");
}

export class FileCache {
  readonly directory: string;

  constructor(directory = defaultCacheDirectory()) {
    this.directory = directory;
  }

  get<T>(key: string, validate?: (value: unknown) => T | undefined): T | null {
    const file = this.fileFor(key);
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheRecord<unknown>>;
      if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) || Date.now() >= record.expiresAt) {
        rmSync(file, { force: true });
        return null;
      }
      const value = validate ? validate(record.value) : record.value as T;
      if (value === undefined) {
        rmSync(file, { force: true });
        return null;
      }
      return value;
    } catch {
      rmSync(file, { force: true });
      return null;
    }
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    mkdirSync(this.directory, { recursive: true });
    const file = this.fileFor(key);
    const temporaryFile = `${file}.${process.pid}.tmp`;
    const record: CacheRecord<T> = { value, expiresAt: Date.now() + ttlMs };
    writeFileSync(temporaryFile, JSON.stringify(record), "utf8");
    renameSync(temporaryFile, file);
  }

  clear(): number {
    if (!existsSync(this.directory)) return 0;
    let cleared = 0;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(this.directory, entry.name);
      try {
        JSON.parse(readFileSync(file, "utf8"));
        rmSync(file, { force: true });
        cleared += 1;
      } catch {
        rmSync(file, { force: true });
        cleared += 1;
      }
    }
    return cleared;
  }

  private fileFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }
}
