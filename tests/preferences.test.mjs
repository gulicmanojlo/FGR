import assert from "node:assert/strict";
import {
  DEFAULT_PIANO_DOCK_HEIGHT,
  MAX_PIANO_DOCK_HEIGHT,
  MIN_PIANO_DOCK_HEIGHT,
  normalizePianoDockHeight,
  patchUiPreferences,
  readUiPreferences
} from "../js/preferences.js";

assert.equal(normalizePianoDockHeight(undefined), DEFAULT_PIANO_DOCK_HEIGHT);
assert.equal(normalizePianoDockHeight("384"), 384);
assert.equal(normalizePianoDockHeight(100), MIN_PIANO_DOCK_HEIGHT);
assert.equal(normalizePianoDockHeight(900), MAX_PIANO_DOCK_HEIGHT);
assert.equal(normalizePianoDockHeight(337.6), 338);
assert.equal(normalizePianoDockHeight("invalid", 360), 360);

const stored = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value))
  }
};
patchUiPreferences({ pianoDockHeight: 408, metronomeCollapsed: true });
assert.equal(readUiPreferences().pianoDockHeight, 408);
assert.equal(readUiPreferences().metronomeCollapsed, true);
delete globalThis.window;

console.log("preferences tests passed");
