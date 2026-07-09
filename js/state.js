export const NOTE_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
export const WHITE_PITCHES = new Set([0, 2, 4, 5, 7, 9, 11]);

export const REPERTOIRE_STORAGE_KEY = "pwa-klavir-server-playlist-v1";
export const PLAYER_SETTINGS_STORAGE_KEY = "pwa-klavir-player-settings-v1";
export const KEYBOARD_SETTINGS_STORAGE_KEY = "pwa-klavir-keyboard-settings-v1";
export const GITHUB_TOKEN_STORAGE_KEY = "pwa-klavir-github-token-v1";

export const GITHUB_API_BASE = "https://api.github.com/repos/gulicmanojlo/FGR";
export const GITHUB_BRANCH = "main";
export const PLAYLISTS_API_URL = `${GITHUB_API_BASE}/contents/playlists?ref=${GITHUB_BRANCH}`;
export const PLAYLIST_BASE_PATH = "playlists/";
export const PLAYLIST_FILE_EXTENSION = ".json";

export const DEFAULT_YOUTUBE_SEEK_SECONDS = 10;
export const DEFAULT_KEYBOARD_DOUBLE_TAP_SHARP_MS = 90;
export const KEYBOARD_DOUBLE_TAP_SHARP_KEYS = new Set(["KeyC", "KeyD", "KeyF", "KeyG"]);

export const MIN_OCTAVE = 2;
export const MAX_OCTAVE = 6;

// Pomocne funkcije za skladistenje
export function readJsonStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("Local storage error:", e);
  }
}

export function readSessionValue(key) {
  try {
    return window.sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

export function writeSessionValue(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Session storage nedostupan
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Globalno stanje aplikacije
export const state = {
  // Audio
  audioContext: null,
  masterGain: null,
  masterCompressor: null,
  sampleBuffers: new Map(),
  sampleLoadingPromise: null,
  samplesReady: false,
  samplesFailed: false,
  volume: 0.7,
  instrument: "grand-piano",
  sustainEnabled: false,
  sustainedMidiSet: new Set(),
  sustainTimers: new Map(),
  sustainLoopTimers: new Map(),
  sustainLength: 2.5,
  baseOctave: 4,
  activeNotes: new Map(),
  activeMidiSet: new Set(),
  activeChordText: "-",
  
  // UI & Preferences
  theme: "dark",
  tool: "akordi",
  scaleAllOctaves: false,
  octaveLocked: true,
  labelsVisible: true,
  desktopMouseMode: "tone",
  mobileMode: "tone",
  
  // Keyboard mapping
  pianoKeyboardEnabled: false,
  dugmetaraRows: "4",
  doubleTapSharpMs: DEFAULT_KEYBOARD_DOUBLE_TAP_SHARP_MS,
  inputOrder: 0,
  heldBaseKeys: new Map(),
  pendingBaseKeyTaps: new Map(),
  lastBaseKeyTap: {
    code: "",
    time: 0
  },
  heldKeyboardTones: new Map(),
  heldMouseChordRoots: new Map(),
  keyboardFrozenChord: null,
  keyboardReleaseGuardTimer: null,
  keyboardChordSettleTimer: null,
  keyboardMinorKeys: new Map(),
  keyboardInversions: {
    root: new Map(),
    left: new Map(),
    right: new Map()
  },
  keyboardInversionMemory: new Map(),
  keyboardLowerOctaves: new Map(),
  keyboardLowerOctaveLatched: false,
  keyboardLowerOctaveMemoryKeys: new Set(),
  keyboardPitchOffsets: {
    up: new Map(),
    down: new Map()
  },
  keyboardChordColorLatched: {
    seven: false,
    nine: false
  },
  keyboardChordColors: {
    seven: new Map(),
    nine: new Map(),
    maj: new Map(),
    sus: new Map(),
    dim: new Map()
  },
  keyboardVoiceModifiers: {
    raiseRoot: new Map()
  },
  
  // Mouse & Pointer tones
  heldPointerTones: new Map(),
  heldMobileChordRoots: new Map(),
  mobileMinorPointers: new Set(),
  mobileArrowPointers: {
    left: new Map(),
    right: new Map()
  },
  keyElementsByMidi: new Map(),
  keyboardWhiteCount: 0,
  keyboardResizeObserver: null,
  
  // Repertoire & Playlists
  repertoire: [],
  activePlaylistName: "",
  activePlaylistPath: "",
  activePlaylistSha: "",
  availablePlaylists: [],
  playlistBrowserOpen: false,
  playlistSaveTimer: null,
  playlistSaveInFlight: false,
  playlistDirtyAfterSave: false,
  selectedSongId: null,
  songSearchQuery: "",
  
  // YouTube
  youtubeSeekSeconds: DEFAULT_YOUTUBE_SEEK_SECONDS,
  youtubeApiPromise: null,
  youtubePlayerPromise: null,
  youtubePlayer: null,
  youtubePlayerReady: false,
  youtubeLoadedVideoId: "",
  youtubeDesiredPlaying: false,
  youtubePauseGuardUntil: 0,
  youtubePauseRetryTimers: [],
  youtubeCommandToken: 0,
  youtubeResumeTime: 0,
  currentPlaybackChordName: "",
  currentPlaybackChordTime: 0,
  
  // Transposition
  transpose: 0,
  playbackRate: 1.0,

  // Practice playback
  practiceModeActive: false,
  practiceFollowPlayback: false,
  practiceSongChords: null,
  practiceCurrentIndex: -1,
  
  // Mixer
  mixer: {
    bass: { volume: 1.0, mute: false, solo: false },
    mid: { volume: 1.0, mute: false, solo: false },
    high: { volume: 1.0, mute: false, solo: false }
  }
};
