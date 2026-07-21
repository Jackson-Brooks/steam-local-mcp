import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as fileSystem from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UPDATE_REQUIRED_FLAG = 2;
const INSTALLED_FLAG = 4;
const UPDATE_RUNNING_FLAG = 256;
const UPDATE_PAUSED_FLAG = 512;
const NON_GAME_APP_IDS = new Set(["228980"]);

export interface LocalGame {
  appId: string;
  name: string;
  installDir: string;
  libraryDir: string;
  lastPlayed: number;
  sizeOnDisk: number;
  stateFlags: number;
  installationState: InstallationState;
  needsUpdate: boolean;
  bytesToDownload: number;
  bytesDownloaded: number;
  bytesToStage: number;
  bytesStaged: number;
}

export type InstallationState = "installed" | "install-pending" | "update-pending" | "downloading" | "download-paused" | "unknown";

export interface LibraryStorage {
  libraryDir: string;
  installedGames: number;
  installedBytes: number;
  availableBytes: number | null;
  totalBytes: number | null;
}

export type SteamDiscoverySource = "environment" | "registry-current-user" | "registry-machine" | "standard-path" | "path";

export interface SteamInstallation {
  directory: string;
  source: SteamDiscoverySource;
}

export function vdfValue(source: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escapedKey}"\\s+"((?:\\\\.|[^"\\\\])*)"`));
  return match?.[1]?.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function normalizeSteamLocation(value: string): string {
  const unquoted = value.trim().replace(/^"(.*)"$/, "$1");
  const expanded = unquoted.replace(/%([^%]+)%/g, (match, name: string) => {
    const environmentKey = Object.keys(process.env).find((key) => key.toLocaleLowerCase() === name.toLocaleLowerCase());
    return environmentKey ? process.env[environmentKey] ?? match : match;
  });
  return path.basename(expanded).toLocaleLowerCase() === "steam.exe" ? path.dirname(expanded) : expanded;
}

function registryValue(key: string, valueName: string): string | undefined {
  try {
    const output = execFileSync("reg", ["query", key, "/v", valueName], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\w+\\s+(.+?)\\s*$`, "mi"))?.[1];
  } catch {
    return undefined;
  }
}

function steamOnPath(): string[] {
  try {
    return execFileSync("where", ["steam.exe"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function steamInstallation(): SteamInstallation | null {
  const currentUserRegistry = registryValue("HKCU\\Software\\Valve\\Steam", "SteamPath");
  const machineRegistry = [
    registryValue("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
    registryValue("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
  ];
  const standardPaths = [
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Steam"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Steam"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Steam"),
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "C:\\Steam",
  ];
  const candidates: Array<{ value: string | undefined; source: SteamDiscoverySource }> = [
    { value: process.env.STEAM_PATH, source: "environment" },
    { value: currentUserRegistry, source: "registry-current-user" },
    ...machineRegistry.map((value) => ({ value, source: "registry-machine" as const })),
    ...standardPaths.map((value) => ({ value, source: "standard-path" as const })),
    ...steamOnPath().map((value) => ({ value, source: "path" as const })),
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const directory = normalizeSteamLocation(candidate.value);
    if (existsSync(path.join(directory, "steam.exe"))) return { directory, source: candidate.source };
  }
  return null;
}

export function steamDirectory(): string | null {
  return steamInstallation()?.directory ?? null;
}

export function libraryDirectories(steamDir: string): string[] {
  const directories = new Map<string, string>();
  const addDirectory = (directory: string) => directories.set(path.resolve(directory).toLocaleLowerCase(), directory);
  addDirectory(steamDir);
  const libraryFile = path.join(steamDir, "steamapps", "libraryfolders.vdf");
  if (existsSync(libraryFile)) {
    const source = readFileSync(libraryFile, "utf8");
    for (const match of source.matchAll(/"path"\s+"((?:\\.|[^"\\])*)"/g)) addDirectory(match[1].replace(/\\\\/g, "\\"));
  }
  return [...directories.values()].filter((directory) => existsSync(path.join(directory, "steamapps")));
}

export function localGameStatuses(): LocalGame[] {
  const steamDir = steamDirectory();
  if (!steamDir) throw new Error("Steam was not found. Set STEAM_PATH to the folder containing steam.exe.");
  const games = new Map<string, LocalGame>();
  for (const libraryDir of libraryDirectories(steamDir)) {
    const steamAppsDir = path.join(libraryDir, "steamapps");
    let manifestFiles;
    try { manifestFiles = readdirSync(steamAppsDir, { withFileTypes: true }); } catch { continue; }
    for (const file of manifestFiles) {
      try {
        if (!file.isFile() || !/^appmanifest_\d+\.acf$/i.test(file.name)) continue;
        const manifest = readFileSync(path.join(steamAppsDir, file.name), "utf8");
        const appId = vdfValue(manifest, "appid");
        const name = vdfValue(manifest, "name");
        const stateFlags = Number(vdfValue(manifest, "StateFlags") ?? 0);
        if (!appId || !name || NON_GAME_APP_IDS.has(appId)) continue;
        games.set(appId, {
          appId, name, installDir: vdfValue(manifest, "installdir") ?? "", libraryDir,
          lastPlayed: Number(vdfValue(manifest, "LastPlayed") ?? 0), sizeOnDisk: Number(vdfValue(manifest, "SizeOnDisk") ?? 0), stateFlags,
          installationState: installationState(stateFlags), needsUpdate: (stateFlags & UPDATE_REQUIRED_FLAG) !== 0,
          bytesToDownload: Number(vdfValue(manifest, "BytesToDownload") ?? 0), bytesDownloaded: Number(vdfValue(manifest, "BytesDownloaded") ?? 0),
          bytesToStage: Number(vdfValue(manifest, "BytesToStage") ?? 0), bytesStaged: Number(vdfValue(manifest, "BytesStaged") ?? 0),
        });
      } catch {
        // Steam can update a manifest while it is being read; it will be retried next request.
      }
    }
  }
  return [...games.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function installationState(stateFlags: number): InstallationState {
  if ((stateFlags & UPDATE_RUNNING_FLAG) !== 0) return "downloading";
  if ((stateFlags & UPDATE_PAUSED_FLAG) !== 0) return "download-paused";
  if ((stateFlags & UPDATE_REQUIRED_FLAG) !== 0) return (stateFlags & INSTALLED_FLAG) !== 0 ? "update-pending" : "install-pending";
  return (stateFlags & INSTALLED_FLAG) !== 0 ? "installed" : "unknown";
}

export function installedGames(): LocalGame[] {
  return localGameStatuses().filter((game) => (game.stateFlags & INSTALLED_FLAG) !== 0);
}

export function libraryStorage(): LibraryStorage[] {
  const steamDir = steamDirectory();
  if (!steamDir) throw new Error("Steam was not found. Set STEAM_PATH to the folder containing steam.exe.");
  const games = installedGames();
  return libraryDirectories(steamDir).map((libraryDir) => {
    const libraryGames = games.filter((game) => path.resolve(game.libraryDir).toLocaleLowerCase() === path.resolve(libraryDir).toLocaleLowerCase());
    try {
      if (!fileSystem.statfsSync) throw new Error("This Node.js version does not provide filesystem capacity information.");
      const stats = fileSystem.statfsSync(libraryDir);
      return {
        libraryDir, installedGames: libraryGames.length, installedBytes: libraryGames.reduce((total, game) => total + game.sizeOnDisk, 0),
        availableBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return { libraryDir, installedGames: libraryGames.length, installedBytes: libraryGames.reduce((total, game) => total + game.sizeOnDisk, 0), availableBytes: null, totalBytes: null };
    }
  });
}

export function findInstalledGames(query: string): LocalGame[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) throw new Error("Provide a game name or Steam app ID.");
  const games = installedGames();
  const exact = games.filter((game) => game.appId === normalized || game.name.toLocaleLowerCase() === normalized);
  return exact.length ? exact : games.filter((game) => game.name.toLocaleLowerCase().includes(normalized));
}

export async function steamRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/FO", "CSV", "/NH"], { windowsHide: true });
    return stdout.toLocaleLowerCase().includes("steam.exe");
  } catch { return false; }
}

export async function ensureSteamRunning(): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("This server currently supports Windows Steam installations only.");
  if (await steamRunning()) return false;
  const directory = steamDirectory();
  if (!directory) throw new Error("Steam was not found. Set STEAM_PATH to the folder containing steam.exe.");
  const executable = path.join(directory, "steam.exe");
  await new Promise<void>((resolve, reject) => {
    const process = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true });
    process.once("error", reject);
    process.once("spawn", () => {
      process.unref();
      resolve();
    });
  });
  return true;
}

export async function openSteamUrl(url: string): Promise<boolean> {
  const clientStarted = await ensureSteamRunning();
  await execFileAsync("cmd", ["/c", "start", "", url], { windowsHide: true });
  return clientStarted;
}

export function numericAppId(value: string | number): string {
  const appId = String(value ?? "");
  if (!/^\d+$/.test(appId)) throw new Error("app_id must be a numeric Steam app ID.");
  return appId;
}
