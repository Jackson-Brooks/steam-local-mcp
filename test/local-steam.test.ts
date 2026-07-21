import assert from "node:assert/strict";
import test from "node:test";
import { installationState, normalizeSteamLocation, numericAppId, vdfValue } from "../src/local-steam.js";

test("reads escaped paths from Steam VDF values", () => {
  const manifest = '"AppState"\n{\n  "name" "Example"\n  "LauncherPath" "C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe"\n}';
  assert.equal(vdfValue(manifest, "name"), "Example");
  assert.equal(vdfValue(manifest, "LauncherPath"), "C:\\Program Files (x86)\\Steam\\steam.exe");
});

test("requires numeric Steam app IDs", () => {
  assert.equal(numericAppId("2379780"), "2379780");
  assert.throws(() => numericAppId("2379780 & anything"), /numeric Steam app ID/);
});

test("normalizes a Steam executable path and quoted directory", () => {
  assert.equal(normalizeSteamLocation("C:\\Games\\Steam\\steam.exe"), "C:\\Games\\Steam");
  assert.equal(normalizeSteamLocation('"C:\\Games\\Steam"'), "C:\\Games\\Steam");
});

test("interprets Steam manifest install and update states", () => {
  assert.equal(installationState(4), "installed");
  assert.equal(installationState(6), "update-pending");
  assert.equal(installationState(258), "downloading");
  assert.equal(installationState(514), "download-paused");
});
