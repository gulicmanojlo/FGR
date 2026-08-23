import { 
  state, 
  readSessionValue, 
  writeSessionValue, 
  GITHUB_TOKEN_STORAGE_KEY, 
  GITHUB_API_BASE, 
  GITHUB_BRANCH,
  PLAYLIST_FILE_EXTENSION,
  PLAYLISTS_API_URL
} from "./state.js";
import { normalizeNoteTracks } from "./processing-client.js?v=164";

export function getGitHubToken() {
  return readSessionValue(GITHUB_TOKEN_STORAGE_KEY).trim();
}

export function ensureGitHubToken() {
  const existing = getGitHubToken();
  if (existing) {
    return existing;
  }

  const token = window.prompt("GitHub token za cuvanje playlisti");
  const normalized = String(token || "").trim();
  if (!normalized) {
    throw new Error("GitHub token nije unet");
  }
  writeSessionValue(GITHUB_TOKEN_STORAGE_KEY, normalized);
  return normalized;
}

export async function fetchServerPlaylists() {
  const response = await fetch(`${PLAYLISTS_API_URL}&cache=${Date.now()}`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store"
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error("Playlists nisu dostupne");
  }

  const entries = await response.json();
  return entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(PLAYLIST_FILE_EXTENSION))
    .map((entry) => ({
      name: entry.name.slice(0, -PLAYLIST_FILE_EXTENSION.length),
      path: entry.path,
      sha: entry.sha,
      url: entry.download_url
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sr"));
}

export async function putGitHubFile(path, data, options = {}) {
  const token = ensureGitHubToken();
  const body = {
    message: options.message || `Update ${path}`,
    content: encodeBase64Utf8(`${JSON.stringify(data, null, 2)}\n`),
    branch: GITHUB_BRANCH
  };
  if (options.sha) {
    body.sha = options.sha;
  }

  const response = await fetch(githubContentsUrl(path), {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body)
  });
  
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "GitHub upis nije uspeo");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function fetchGitHubFileMetadata(path) {
  const response = await fetch(`${githubContentsUrl(path)}?ref=${GITHUB_BRANCH}&cache=${Date.now()}`, {
    headers: githubHeaders(getGitHubToken()),
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "GitHub fajl nije dostupan");
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function slugifyPlaylistName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "playlist";
}

export function buildRepertoireFileData() {
  return {
    version: 1,
    name: state.activePlaylistName || "Playlist",
    updatedAt: new Date().toISOString(),
    settings: {
      selectedSongId: state.selectedSongId,
      seekSeconds: state.youtubeSeekSeconds
    },
    songs: state.repertoire.map((song) => ({
      id: song.id,
      title: song.title,
      key: song.key,
      url: song.url,
      videoId: song.videoId,
      ...(song.source ? { source: song.source } : {}),
      ...(song.stems ? { stems: song.stems } : {}),
      ...(Array.isArray(song.availableStems) && song.availableStems.length ? { availableStems: song.availableStems } : {}),
      ...(song.assets ? { assets: song.assets } : {}),
      ...(song.noteTracks && Object.keys(song.noteTracks).length ? { noteTracks: song.noteTracks } : {}),
      ...(song.localCapture?.available ? { localCapture: song.localCapture } : {}),
      ...(song.videoId && (
        song.localCapture?.available
        || song.source?.type === "upload"
        || song.stems
        || song.assets?.mix
        || Object.keys(song.assets?.stems || {}).length
      )
        ? { localMixEnabled: song.localMixEnabled !== false }
        : {}),
      ...(Number.isFinite(Number(song.duration)) && Number(song.duration) > 0
        ? { duration: Number(song.duration) }
        : {}),
      ...(song.processing ? { processing: song.processing } : {}),
      ...(Number.isFinite(Number(song.chordTimingOffsetSeconds)) && Number(song.chordTimingOffsetSeconds) !== 0
        ? { chordTimingOffsetSeconds: Number(song.chordTimingOffsetSeconds) }
        : {}),
      ...(Number.isFinite(Number(song.chordEndTime)) && Number(song.chordEndTime) > 0
        ? { chordEndTime: Number(song.chordEndTime) }
        : {}),
      ...(song.chordPatchDirty
        ? { chordPatchDirty: true, chordPatchError: String(song.chordPatchError || "") }
        : {}),
      ...(Number.isInteger(Number(song.chordChartRevision)) && Number(song.chordChartRevision) > 0
        ? { chordChartRevision: Number(song.chordChartRevision) }
        : {}),
      ...(Array.isArray(song.chords) && song.chords.length ? { chords: song.chords } : {})
    }))
  };
}

export function normalizeRepertoireFileData(data) {
  const songsSource = Array.isArray(data) ? data : Array.isArray(data?.songs) ? data.songs : [];
  const songs = songsSource.map(normalizeSong).filter((song) => song.url || song.videoId || song.title);
  const selectedSongId = String(data?.settings?.selectedSongId || data?.selectedSongId || "");
  const seekSeconds = Number(data?.settings?.seekSeconds || data?.seekSeconds || state.youtubeSeekSeconds);

  return {
    name: String(data?.name || ""),
    path: String(data?.path || ""),
    songs,
    selectedSongId,
    seekSeconds: Math.max(1, Math.min(60, seekSeconds || 10))
  };
}

function normalizeSong(song) {
  const url = String(song?.url || "");
  const videoId = String(song?.videoId || parseYouTubeVideoId(url));
  const chords = Array.isArray(song?.chords)
    ? song.chords
        .map((chord) => ({ t: Math.max(0, Number(chord?.t) || 0), n: String(chord?.n || "").trim() }))
        .filter((chord) => chord.n)
        .sort((a, b) => a.t - b.t)
    : [];
  const processing = normalizeProcessing(song?.processing);
  const availableStems = Array.isArray(song?.availableStems)
    ? song.availableStems.map((stem) => String(stem || "").trim()).filter(Boolean)
    : [];
  const source = normalizeSource(song?.source, videoId);
  const assets = normalizeAssets(song?.assets);
  const noteTracks = {
    ...normalizeNoteTracks(assets?.noteTracks || {}),
    ...normalizeNoteTracks(song?.note_tracks || {}),
    ...normalizeNoteTracks(song?.noteTracks || {})
  };
  const rawChordTimingOffset = Number(song?.chordTimingOffsetSeconds);
  const chordTimingOffsetSeconds = Number.isFinite(rawChordTimingOffset)
    ? Math.max(-5, Math.min(5, rawChordTimingOffset))
    : 0;
  const chordChartRevision = Number.isInteger(Number(song?.chordChartRevision))
    ? Math.max(0, Number(song.chordChartRevision))
    : 0;
  const rawCapture = song?.localCapture && typeof song.localCapture === "object"
    ? song.localCapture
    : null;
  const localCapture = rawCapture?.available ? {
    available: true,
    format: String(rawCapture.format || "wav"),
    bitDepth: Math.max(0, Number(rawCapture.bitDepth) || 0),
    sampleRate: Math.max(0, Number(rawCapture.sampleRate) || 0),
    channels: Math.max(0, Number(rawCapture.channels) || 0),
    duration: Math.max(0, Number(rawCapture.duration) || 0),
    videoOffsetSeconds: Math.max(0, Number(rawCapture.videoOffsetSeconds) || 0),
    capturedAt: String(rawCapture.capturedAt || "")
  } : null;
  const hasLocalMedia = Boolean(
    localCapture
    || source?.type === "upload"
    || song?.stems
    || assets?.mix
    || Object.keys(assets?.stems || {}).length
  );
  const duration = Math.max(0, Number(song?.duration) || Number(localCapture?.duration) || 0);
  const lastChordStart = chords.length ? Number(chords[chords.length - 1]?.t) || 0 : 0;
  const rawChordEndTime = Number(song?.chordEndTime);
  const hasChordEndTime = song?.chordEndTime !== null && song?.chordEndTime !== undefined && song?.chordEndTime !== "";
  const chordEndTime = hasChordEndTime && Number.isFinite(rawChordEndTime) && rawChordEndTime > lastChordStart
    ? Math.min(rawChordEndTime, duration > 0 ? Math.max(lastChordStart, duration) : rawChordEndTime)
    : null;
  return {
    id: String(song?.id || createSongId()),
    title: String(song?.title || ""),
    key: String(song?.key || ""),
    url,
    videoId,
    source,
    chords,
    stems: Boolean(song?.stems),
    availableStems,
    assets,
    noteTracks,
    processing,
    chordTimingOffsetSeconds,
    chordEndTime,
    chordPatchDirty: song?.chordPatchDirty === true,
    chordPatchError: song?.chordPatchDirty === true ? String(song?.chordPatchError || "") : "",
    chordChartRevision,
    localCapture,
    localMixEnabled: videoId && hasLocalMedia ? song?.localMixEnabled !== false : false,
    duration
  };
}

function normalizeSource(source, videoId) {
  if (!source || typeof source !== "object") {
    return videoId ? { type: "youtube" } : null;
  }
  const type = source.type === "upload" || source.type === "mp3" ? "upload" : "youtube";
  return {
    type,
    ...(source.name ? { name: String(source.name) } : {}),
    ...(source.mime ? { mime: String(source.mime) } : {}),
    ...(Number.isFinite(Number(source.size)) ? { size: Math.max(0, Number(source.size)) } : {})
  };
}

function normalizeAssets(assets) {
  if (!assets || typeof assets !== "object") return null;
  const normalizeAsset = (asset) => {
    if (!asset) return null;
    if (typeof asset === "string") return { url: asset };
    if (typeof asset !== "object" || !asset.url) return null;
    return {
      url: String(asset.url),
      ...(asset.mime ? { mime: String(asset.mime) } : {}),
      ...(Number.isFinite(Number(asset.size)) ? { size: Math.max(0, Number(asset.size)) } : {})
    };
  };
  const stems = {};
  Object.entries(assets.stems || {}).forEach(([name, asset]) => {
    const normalized = normalizeAsset(asset);
    if (normalized) stems[name] = normalized;
  });
  const mix = normalizeAsset(assets.mix);
  const noteTracks = normalizeNoteTracks(assets.noteTracks || assets.note_tracks || {});
  return mix || Object.keys(stems).length || Object.keys(noteTracks).length
    ? { mix, stems, noteTracks }
    : null;
}

function normalizeProcessing(processing) {
  if (!processing || typeof processing !== "object") return null;
  const state = String(processing.state || "").trim().toLowerCase();
  if (!state) return null;
  return {
    state,
    stage: String(processing.stage || "").trim(),
    message: String(processing.message || "").trim(),
    updatedAt: String(processing.updatedAt || "").trim()
  };
}

function parseYouTubeVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = String(url || "").match(regExp);
  return match && match[2].length === 11 ? match[2] : "";
}

function createSongId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function githubContentsUrl(path) {
  return `${GITHUB_API_BASE}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
