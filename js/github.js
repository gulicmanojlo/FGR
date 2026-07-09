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
      ...(song.stems ? { stems: song.stems } : {}),
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
  return {
    id: String(song?.id || createSongId()),
    title: String(song?.title || ""),
    key: String(song?.key || ""),
    url,
    videoId,
    chords,
    stems: Boolean(song?.stems)
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
