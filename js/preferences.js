import { readJsonStorage, writeJsonStorage } from "./state.js";

export const UI_PREFERENCES_STORAGE_KEY = "fgr-ui-v2";
export const LEGACY_UI_PREFERENCES_STORAGE_KEY = "fgr-ui-v1";
export const DEFAULT_DARK_ACCENT = "#e3b45c";
export const DEFAULT_MELODY_COLOR = "#3ed38d";
export const DEFAULT_HARMONY_COLOR = "#33a8ff";
export const DEFAULT_PIANO_DOCK_HEIGHT = 336;
export const MIN_PIANO_DOCK_HEIGHT = 240;
export const MAX_PIANO_DOCK_HEIGHT = 520;

// Prazan naziv znači automatski izbor prema taktu iz ritmičke mreže.
export const COMPING_PATTERN_NAMES = ["", "sustained", "downbeats", "backbeat", "arpeggio", "ballad", "rumba", "waltz"];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(value, fallback = DEFAULT_DARK_ACCENT) {
  const normalized = String(value || "").trim().toLowerCase();
  return HEX_COLOR.test(normalized) ? normalized : fallback;
}

export function readUiPreferences() {
  const legacy = readJsonStorage(LEGACY_UI_PREFERENCES_STORAGE_KEY, {});
  const saved = readJsonStorage(UI_PREFERENCES_STORAGE_KEY, {});
  const theme = saved.theme === "light" || saved.theme === "dark"
    ? saved.theme
    : legacy.theme === "light" ? "light" : "dark";

  return {
    theme,
    darkAccent: normalizeHexColor(saved.darkAccent, DEFAULT_DARK_ACCENT),
    melodyColor: normalizeHexColor(saved.melodyColor, DEFAULT_MELODY_COLOR),
    harmonyColor: normalizeHexColor(saved.harmonyColor, DEFAULT_HARMONY_COLOR),
    melodyPianoEnabled: Boolean(saved.melodyPianoEnabled),
    harmonyPianoEnabled: Boolean(saved.harmonyPianoEnabled),
    showFingering: Boolean(saved.showFingering),
    // Mreža se podrazumevano vidi: ona je jedini način da korisnik primeti
    // pogrešno prepoznat tempo pre nego što se na njega osloni.
    showBeatGrid: saved.showBeatGrid !== false,
    compingPattern: COMPING_PATTERN_NAMES.includes(saved.compingPattern) ? saved.compingPattern : "",
    pianoDockHeight: normalizePianoDockHeight(saved.pianoDockHeight),
    metronomeCollapsed: Boolean(saved.metronomeCollapsed),
    // Old builds stored the Demucs stem names "vocals"/"guitar" here. They
    // were live pitch guesses, not a reliable musical line, so migrate both to
    // the analyzed melody track.
    melodyTrackSource: saved.melodyTrackSource === "bass" ? "bass" : "melody",
    processingServiceUrl: normalizeServiceUrl(saved.processingServiceUrl)
  };
}

export function normalizePianoDockHeight(value, fallback = DEFAULT_PIANO_DOCK_HEIGHT) {
  const parsed = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_PIANO_DOCK_HEIGHT;
  const height = Number.isFinite(parsed) ? parsed : safeFallback;
  return Math.round(Math.max(MIN_PIANO_DOCK_HEIGHT, Math.min(MAX_PIANO_DOCK_HEIGHT, height)));
}

export function patchUiPreferences(patch) {
  const current = readJsonStorage(UI_PREFERENCES_STORAGE_KEY, {});
  const next = { ...current, ...patch };
  writeJsonStorage(UI_PREFERENCES_STORAGE_KEY, next);
  return readUiPreferences();
}

export function normalizeServiceUrl(value) {
  const fallback = "http://127.0.0.1:8765";
  const text = String(value || fallback).trim().replace(/\/+$/, "");
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function applyVisualPreferences(root, preferences) {
  if (!root) return;
  const prefs = preferences || readUiPreferences();
  const accent = normalizeHexColor(prefs.darkAccent, DEFAULT_DARK_ACCENT);
  const melody = normalizeHexColor(prefs.melodyColor, DEFAULT_MELODY_COLOR);
  const harmony = normalizeHexColor(prefs.harmonyColor, DEFAULT_HARMONY_COLOR);
  const palette = deriveAccentPalette(accent);

  root.setAttribute("data-theme", prefs.theme === "light" ? "light" : "dark");
  root.style.setProperty("--user-accent", accent);
  root.style.setProperty("--user-accent-strong", palette.strong);
  root.style.setProperty("--user-accent-deep", palette.deep);
  root.style.setProperty("--user-accent-soft", palette.soft);
  root.style.setProperty("--user-accent-contrast", palette.contrast);
  root.style.setProperty("--user-active", palette.active);
  root.style.setProperty("--user-active-deep", palette.activeDeep);
  root.style.setProperty("--user-focus-ring", palette.focusRing);
  root.style.setProperty("--melody-color", melody);
  root.style.setProperty("--harmony-color", harmony);
}

export function deriveAccentPalette(accent) {
  const normalized = normalizeHexColor(accent, DEFAULT_DARK_ACCENT);
  const rgb = hexToRgb(normalized);
  const contrast = relativeLuminance(rgb) > 0.46 ? "#151006" : "#ffffff";
  return {
    strong: mixHex(normalized, "#ffffff", 0.38),
    deep: mixHex(normalized, "#000000", 0.28),
    soft: rgba(rgb, 0.14),
    contrast,
    active: mixHex(normalized, "#ffffff", 0.14),
    activeDeep: mixHex(normalized, "#000000", 0.34),
    focusRing: rgba(rgb, 0.38)
  };
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex).slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function mixHex(first, second, amount) {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  const mix = (start, end) => Math.round(start + (end - start) * amount);
  return rgbToHex(mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b));
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function rgba(rgb, alpha) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
