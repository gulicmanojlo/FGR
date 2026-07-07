(() => {
  "use strict";

  const NOTE_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
  const WHITE_PITCHES = new Set([0, 2, 4, 5, 7, 9, 11]);
  const KEYBOARD_MAP = new Map([
    ["KeyC", 0],
    ["KeyD", 2],
    ["KeyE", 4],
    ["KeyF", 5],
    ["KeyG", 7],
    ["KeyA", 9],
    ["KeyB", 10],
    ["KeyH", 11]
  ]);
  const KEYBOARD_INVERSION_MAP = new Map([
    ["ControlLeft", "left"],
    ["ShiftLeft", "right"]
  ]);
  const KEYBOARD_INVERSION_STEP_MAP = new Map([
    ["NumpadAdd", 1],
    ["NumpadSubtract", -1]
  ]);
  const KEYBOARD_MINOR_KEYS = new Set(["Space", "Numpad0"]);
  const KEYBOARD_LOWER_OCTAVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Numpad4"]);
  const KEYBOARD_LOWER_OCTAVE_LATCH_KEYS = new Set(["Numpad4"]);
  const KEYBOARD_UPPER_OCTAVE_MEMORY_KEYS = new Set(["Numpad6"]);
  const KEYBOARD_CHORD_COLOR_LATCHES = new Set(["seven", "nine"]);
  const KEYBOARD_PITCH_OFFSET_MAP = new Map([
    ["ArrowUp", "up"],
    ["Numpad5", "up"],
    ["ArrowDown", "down"],
    ["Numpad2", "down"]
  ]);
  const KEYBOARD_CHORD_COLOR_MAP = new Map([
    ["Digit7", "seven"],
    ["Numpad7", "seven"],
    ["Digit9", "nine"],
    ["Numpad9", "nine"],
    ["KeyJ", "maj"],
    ["Numpad3", "maj"],
    ["KeyS", "sus"],
    ["Numpad1", "sus"],
    ["KeyM", "dim"],
    ["NumpadEnter", "dim"]
  ]);
  const KEYBOARD_VOICE_MODIFIER_MAP = new Map([
    ["ShiftRight", "raiseRoot"],
    ["Numpad8", "raiseRoot"]
  ]);
  const DUGMETARA_KEY_SEQUENCES = {
    "3": [
      "Slash",
      "Quote",
      "BracketRight",
      "Period",
      "Semicolon",
      "BracketLeft",
      "Comma",
      "KeyL",
      "KeyP",
      "KeyM",
      "KeyK",
      "KeyO",
      "KeyN",
      "KeyJ",
      "KeyI",
      "KeyB",
      "KeyH",
      "KeyU",
      "KeyV",
      "KeyG",
      "KeyY",
      "KeyC",
      "KeyF",
      "KeyT",
      "KeyX",
      "KeyR",
      "KeyZ",
      "KeyS",
      "KeyE",
      "KeyA",
      "KeyW",
      "KeyQ"
    ],
    "4": [
      "Slash",
      "Quote",
      "BracketRight",
      "Period",
      "Semicolon",
      "BracketLeft",
      "Equal",
      "Comma",
      "KeyL",
      "KeyP",
      "Minus",
      "KeyM",
      "KeyK",
      "KeyO",
      "Digit0",
      "KeyN",
      "KeyJ",
      "KeyI",
      "Digit9",
      "KeyB",
      "KeyH",
      "KeyU",
      "Digit8",
      "KeyV",
      "KeyG",
      "KeyY",
      "Digit7",
      "KeyC",
      "KeyF",
      "KeyT",
      "Digit6",
      "KeyX",
      "KeyD",
      "KeyR",
      "Digit5",
      "KeyZ",
      "KeyS",
      "KeyE",
      "Digit4",
      "KeyA",
      "KeyW",
      "Digit3"
    ]
  };
  const DUGMETARA_KEYBOARD_MAPS = Object.fromEntries(
    Object.entries(DUGMETARA_KEY_SEQUENCES).map(([rows, sequence]) => [
      rows,
      new Map(sequence.map((code, index) => [code, index]))
    ])
  );
  const RELEASE_GUARD_MS = 140;
  const KEYBOARD_CHORD_SETTLE_MS = 50;
  const DEFAULT_KEYBOARD_DOUBLE_TAP_SHARP_MS = 90;
  const KEYBOARD_DOUBLE_TAP_SHARP_KEYS = new Set(["KeyC", "KeyD", "KeyF", "KeyG"]);
  const CHORD_INTERVALS = {
    major: {
      root: [0, 4, 7],
      left: [-5, 0, 4],
      right: [4, 7, 12]
    },
    minor: {
      root: [0, 3, 7],
      left: [-5, 0, 3],
      right: [3, 7, 12]
    },
    sus: {
      root: [0, 5, 7],
      left: [-5, 0, 5],
      right: [5, 7, 12]
    },
    dim: {
      root: [0, 3, 6],
      left: [-6, 0, 3],
      right: [3, 6, 12]
    }
  };
  const ROOT_ORDER = NOTE_NAMES;
  const MIN_OCTAVE = 2;
  const MAX_OCTAVE = 6;
  const LOWEST_MIDI = noteToMidi(7, 1);
  const HIGHEST_MIDI = noteToMidi(11, 7);
  const REPERTOIRE_STORAGE_KEY = "pwa-klavir-server-playlist-v1";
  const PLAYER_SETTINGS_STORAGE_KEY = "pwa-klavir-player-settings-v1";
  const KEYBOARD_SETTINGS_STORAGE_KEY = "pwa-klavir-keyboard-settings-v1";
  const GITHUB_TOKEN_STORAGE_KEY = "pwa-klavir-github-token-v1";
  const GITHUB_API_BASE = "https://api.github.com/repos/gulicmanojlo/FGR";
  const GITHUB_BRANCH = "main";
  const PLAYLISTS_API_URL = `${GITHUB_API_BASE}/contents/playlists?ref=${GITHUB_BRANCH}`;
  const PLAYLIST_BASE_PATH = "playlists/";
  const PLAYLIST_FILE_EXTENSION = ".json";
  const DEFAULT_YOUTUBE_SEEK_SECONDS = 10;
  const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
  const YOUTUBE_PAUSE_GUARD_MS = 60000;
  const YOUTUBE_PAUSE_RETRY_DELAYS = [0, 120, 360, 900, 1800, 3200];

  const app = document.getElementById("app");
  const keyboard = document.getElementById("keyboard");
  const pianoScroll = document.getElementById("pianoScroll");
  const volumeControl = document.getElementById("volumeControl");
  const octaveDown = document.getElementById("octaveDown");
  const octaveUp = document.getElementById("octaveUp");
  const octaveDisplay = document.getElementById("octaveDisplay");
  const labelsToggle = document.getElementById("labelsToggle");
  const instrumentSelect = document.getElementById("instrumentSelect");
  const sustainToggle = document.getElementById("sustainToggle");
  const sustainLengthControl = document.getElementById("sustainLengthControl");
  const sustainLengthDisplay = document.getElementById("sustainLengthDisplay");
  const pianoKeyboardToggle = document.getElementById("pianoKeyboardToggle");
  const omitExtensionRootToggle = document.getElementById("omitExtensionRootToggle");
  const closeVoicingToggle = document.getElementById("closeVoicingToggle");
  const retriggerChordToggle = document.getElementById("retriggerChordToggle");
  const resetMemoryButton = document.getElementById("resetMemoryButton");
  const doubleTapSharpControl = document.getElementById("doubleTapSharpControl");
  const doubleTapSharpDisplay = document.getElementById("doubleTapSharpDisplay");
  const activeChordDisplay = document.getElementById("activeChordDisplay");
  const desktopMouseModeInputs = [...document.querySelectorAll("input[name='desktopMouseMode']")];
  const extensionVoicingInputs = [...document.querySelectorAll("input[name='extensionVoicing']")];
  const dugmetaraRowInputs = [...document.querySelectorAll("input[name='dugmetaraRows']")];
  const mobileModeInputs = [...document.querySelectorAll("input[name='mobileMode']")];
  const mobileModifierButtons = [...document.querySelectorAll("[data-mobile-modifier]")];
  const songTitleInput = document.getElementById("songTitleInput");
  const songKeyInput = document.getElementById("songKeyInput");
  const songUrlInput = document.getElementById("songUrlInput");
  const addSongButton = document.getElementById("addSongButton");
  const repertoireTableBody = document.getElementById("repertoireTableBody");
  const selectedSongTitle = document.getElementById("selectedSongTitle");
  const selectedSongKeyInput = document.getElementById("selectedSongKeyInput");
  const selectedSongUrl = document.getElementById("selectedSongUrl");
  const youtubeStatus = document.getElementById("youtubeStatus");
  const youtubePlayPause = document.getElementById("youtubePlayPause");
  const youtubeRewind = document.getElementById("youtubeRewind");
  const youtubeForward = document.getElementById("youtubeForward");
  const youtubeSeekSeconds = document.getElementById("youtubeSeekSeconds");
  const playlistStart = document.getElementById("playlistStart");
  const playlistWorkspace = document.getElementById("playlistWorkspace");
  const startLoadPlaylistButton = document.getElementById("startLoadPlaylistButton");
  const startNewPlaylistButton = document.getElementById("startNewPlaylistButton");
  const loadPlaylistButton = document.getElementById("loadPlaylistButton");
  const newPlaylistButton = document.getElementById("newPlaylistButton");
  const playlistDialog = document.getElementById("playlistDialog");
  const playlistDialogTitle = document.getElementById("playlistDialogTitle");
  const playlistDialogClose = document.getElementById("playlistDialogClose");
  const playlistBrowser = document.getElementById("playlistBrowser");

  const PIANO_SAMPLE_BASE_PATH = "samples/piano/";
  const PIANO_SAMPLE_DEFS = [
    { name: "A", pitch: 9, firstOctave: 0, lastOctave: 7 },
    { name: "C", pitch: 0, firstOctave: 1, lastOctave: 8 },
    { name: "D#", pitch: 3, firstOctave: 1, lastOctave: 7 },
    { name: "F#", pitch: 6, firstOctave: 1, lastOctave: 7 }
  ];
  const PIANO_SAMPLES = PIANO_SAMPLE_DEFS.flatMap((definition) => {
    const samples = [];
    for (let octave = definition.firstOctave; octave <= definition.lastOctave; octave += 1) {
      samples.push({
        file: `${definition.name}${octave}v12.mp3`,
        midi: noteToMidi(definition.pitch, octave)
      });
    }
    return samples;
  }).sort((a, b) => a.midi - b.midi);
  const SYNTH_FALLBACK_PARTIALS = [
    { multiple: 1, type: "triangle", level: 0.42, detune: -1.8, attack: 0.004, decay: 0.18, sustain: 0.34, tail: 1.8 },
    { multiple: 2.01, type: "sine", level: 0.16, detune: 2.4, attack: 0.003, decay: 0.14, sustain: 0.18, tail: 1.2 },
    { multiple: 3.01, type: "sine", level: 0.08, detune: -3.2, attack: 0.002, decay: 0.1, sustain: 0.1, tail: 0.85 },
    { multiple: 4.02, type: "sine", level: 0.04, detune: 4.6, attack: 0.002, decay: 0.08, sustain: 0.06, tail: 0.65 }
  ];
  const INSTRUMENT_PRESETS = {
    "warm-synth": {
      partials: [
        { multiple: 1, type: "sawtooth", level: 0.18, detune: -5 },
        { multiple: 1, type: "sawtooth", level: 0.16, detune: 6 },
        { multiple: 2, type: "triangle", level: 0.06, detune: 0 }
      ],
      envelope: { attack: 0.045, decay: 0.18, sustain: 0.72, release: 0.32 },
      filter: { type: "lowpass", frequencyMult: 5, min: 900, max: 4200, q: 0.8 },
      vibrato: { depth: 2, rate: 5.2 }
    },
    choir: {
      partials: [
        { multiple: 1, type: "sine", level: 0.2, detune: -4 },
        { multiple: 1, type: "triangle", level: 0.17, detune: 5 },
        { multiple: 2, type: "sine", level: 0.08, detune: 0 },
        { multiple: 3, type: "sine", level: 0.035, detune: 0 }
      ],
      envelope: { attack: 0.14, decay: 0.22, sustain: 0.78, release: 0.55 },
      filter: { type: "lowpass", frequencyMult: 6, min: 1100, max: 5200, q: 0.45 },
      vibrato: { depth: 5, rate: 4.4 }
    },
    accordion: {
      partials: [
        { multiple: 1, type: "sawtooth", level: 0.2, detune: -7 },
        { multiple: 1, type: "square", level: 0.12, detune: 8 },
        { multiple: 2, type: "sawtooth", level: 0.06, detune: 0 }
      ],
      envelope: { attack: 0.018, decay: 0.1, sustain: 0.82, release: 0.18 },
      filter: { type: "lowpass", frequencyMult: 8, min: 1300, max: 5800, q: 0.9 },
      vibrato: { depth: 6, rate: 5.6 }
    },
    organ: {
      partials: [
        { multiple: 1, type: "sine", level: 0.26, detune: 0 },
        { multiple: 2, type: "sine", level: 0.12, detune: 0 },
        { multiple: 3, type: "sine", level: 0.07, detune: 0 },
        { multiple: 4, type: "sine", level: 0.04, detune: 0 }
      ],
      envelope: { attack: 0.006, decay: 0.04, sustain: 0.96, release: 0.12 },
      filter: { type: "lowpass", frequencyMult: 10, min: 1800, max: 7600, q: 0.25 },
      vibrato: { depth: 1.5, rate: 6.5 }
    },
    guitar: {
      partials: [
        { multiple: 1, type: "triangle", level: 0.34, detune: 0 },
        { multiple: 2, type: "sine", level: 0.1, detune: 0 },
        { multiple: 3, type: "triangle", level: 0.055, detune: 0 },
        { multiple: 4, type: "sine", level: 0.025, detune: 0 }
      ],
      envelope: { attack: 0.004, decay: 0.45, sustain: 0.16, release: 0.2 },
      filter: { type: "lowpass", frequencyMult: 7, min: 1200, max: 5200, q: 0.7 },
      vibrato: { depth: 0.6, rate: 5 }
    },
    trumpet: {
      partials: [
        { multiple: 1, type: "sawtooth", level: 0.2, detune: 0 },
        { multiple: 2, type: "square", level: 0.08, detune: 0 },
        { multiple: 3, type: "sawtooth", level: 0.05, detune: 0 }
      ],
      envelope: { attack: 0.028, decay: 0.12, sustain: 0.72, release: 0.18 },
      filter: { type: "lowpass", frequencyMult: 10, min: 1800, max: 8200, q: 1.1 },
      vibrato: { depth: 4, rate: 5.8 }
    },
    brass: {
      partials: [
        { multiple: 1, type: "sawtooth", level: 0.22, detune: -3 },
        { multiple: 1, type: "sawtooth", level: 0.16, detune: 4 },
        { multiple: 2, type: "square", level: 0.08, detune: 0 },
        { multiple: 3, type: "sawtooth", level: 0.04, detune: 0 }
      ],
      envelope: { attack: 0.055, decay: 0.18, sustain: 0.78, release: 0.26 },
      filter: { type: "lowpass", frequencyMult: 9, min: 1600, max: 7600, q: 0.95 },
      vibrato: { depth: 3, rate: 5.2 }
    }
  };

  const state = {
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
    sustainLength: normalizeSustainLength(2.5),
    baseOctave: 4,
    labelsVisible: true,
    extensionVoicing: "upper",
    closeVoicingEnabled: false,
    closeVoicingReferenceMidis: null,
    omitExtensionRootEnabled: false,
    retriggerChordOnChangeEnabled: true,
    retriggerChordRequested: false,
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
    heldPointerTones: new Map(),
    heldMobileChordRoots: new Map(),
    mobileMode: "tone",
    mobileMinorPointers: new Set(),
    mobileArrowPointers: {
      left: new Map(),
      right: new Map()
    },
    activeNotes: new Map(),
    activeMidiSet: new Set(),
    activeChordText: "-",
    keyElementsByMidi: new Map(),
    keyboardWhiteCount: 0,
    keyboardResizeObserver: null,
    desktopMouseMode: "tone",
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
    youtubeResumeTime: 0
  };

  window.FGRBridge = {
    getSelectedSong() {
      return getSelectedSong();
    },
    getBaseOctave() {
      return state.baseOctave;
    },
    getTime() {
      const player = state.youtubePlayer;
      return player && typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) || 0 : 0;
    },
    seekTo(seconds) {
      ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
        if (player && typeof player.seekTo === "function") {
          player.seekTo(Math.max(0, Number(seconds) || 0), true);
        }
      });
    },
    setRate(rate) {
      const player = state.youtubePlayer;
      if (player && typeof player.setPlaybackRate === "function") {
        player.setPlaybackRate(Number(rate) || 1);
      }
    },
    playFromStart() {
      const song = getSelectedSong();
      if (!song) {
        return false;
      }
      state.youtubeResumeTime = 0;
      ensureSelectedVideoLoaded({ autoplay: true, keepDesired: false }).then((player) => {
        if (!player) {
          return;
        }
        if (typeof player.seekTo === "function") {
          player.seekTo(0, true);
        }
        state.youtubeDesiredPlaying = true;
        if (typeof player.playVideo === "function") {
          player.playVideo();
        }
      });
      return true;
    },
    addChordToSelected(name, atSeconds) {
      const song = getSelectedSong();
      const chordName = String(name || "").trim();
      if (!song || !chordName) {
        return false;
      }
      const t = Math.max(0, Number(atSeconds));
      song.chords = Array.isArray(song.chords) ? song.chords : [];
      song.chords.push({ t: Math.round(t * 10) / 10, n: chordName });
      song.chords.sort((a, b) => a.t - b.t);
      saveRepertoire();
      updateSelectedSongPanel();
      return true;
    },
    setChordsForSelected(chords) {
      const song = getSelectedSong();
      if (!song || !Array.isArray(chords)) {
        return false;
      }
      song.chords = chords
        .map((chord) => ({ t: Math.max(0, Math.round((Number(chord?.t) || 0) * 10) / 10), n: String(chord?.n || "").trim() }))
        .filter((chord) => chord.n)
        .sort((a, b) => a.t - b.t);
      saveRepertoire();
      updateSelectedSongPanel();
      return true;
    },
    removeChordFromSelected(index) {
      const song = getSelectedSong();
      if (!song || !Array.isArray(song.chords) || !song.chords[index]) {
        return false;
      }
      song.chords.splice(index, 1);
      saveRepertoire();
      updateSelectedSongPanel();
      return true;
    }
  };

  init();

  function init() {
    renderKeyboard();
    window.dispatchEvent(new CustomEvent("fgr:keyboardready", {
      detail: { octave: state.baseOctave }
    }));
    loadRepertoireState();
    loadKeyboardSettings();
    renderRepertoire();
    updateSelectedSongPanel();
    updatePlaylistMode();
    bindControls();
    updateOctaveControls();
    updateMobileModifierState();
    updateLabelVisibility();
    updateSustainLengthDisplay();
    updateDoubleTapSharpDisplay();
    recomputeSound();
    try {
      ensureAudio({ resume: false });
    } catch {
      state.audioContext = null;
    }
    focusAppSoon();
    registerServiceWorker();
  }

  function bindControls() {
    app.addEventListener("pointerdown", (event) => {
      if (shouldFocusAppFromPointer(event)) {
        focusAppSoon();
      }
    });

    volumeControl.addEventListener("input", () => {
      state.volume = Number(volumeControl.value) / 100;
      if (state.masterGain) {
        state.masterGain.gain.setTargetAtTime(state.volume, state.audioContext.currentTime, 0.015);
      }
      updateMediaSampleVolumes();
    });

    octaveDown.addEventListener("click", () => changeOctave(-1));
    octaveUp.addEventListener("click", () => changeOctave(1));

    labelsToggle.addEventListener("change", () => {
      state.labelsVisible = labelsToggle.checked;
      updateLabelVisibility();
    });

    instrumentSelect.addEventListener("change", () => {
      state.instrument = instrumentSelect.value;
      stopAllSoundingNotes();
      recomputeSound();
    });

    sustainToggle.addEventListener("change", () => {
      state.sustainEnabled = sustainToggle.checked;
      if (!state.sustainEnabled) {
        releaseSustainedNotes();
      }
    });

    sustainLengthControl.addEventListener("input", () => {
      state.sustainLength = normalizeSustainLength(Number(sustainLengthControl.value));
      updateSustainLengthDisplay();
      rescheduleSustainedNotes();
    });

    doubleTapSharpControl.addEventListener("input", () => {
      state.doubleTapSharpMs = normalizeDoubleTapSharpMs(Number(doubleTapSharpControl.value));
      doubleTapSharpControl.value = String(state.doubleTapSharpMs);
      updateDoubleTapSharpDisplay();
      saveKeyboardSettings();
    });

    pianoKeyboardToggle.addEventListener("change", () => {
      state.pianoKeyboardEnabled = pianoKeyboardToggle.checked;
      clearAllHeldState();
    });

    dugmetaraRowInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        state.dugmetaraRows = input.value === "3" ? "3" : "4";
        saveKeyboardSettings();
        clearAllHeldState();
      });
    });

    omitExtensionRootToggle.addEventListener("change", () => {
      state.omitExtensionRootEnabled = omitExtensionRootToggle.checked;
      clearKeyboardReleaseGuard();
      recomputeSound();
    });

    closeVoicingToggle.addEventListener("change", () => {
      state.closeVoicingEnabled = closeVoicingToggle.checked;
      state.closeVoicingReferenceMidis = state.closeVoicingEnabled && state.activeMidiSet.size
        ? [...state.activeMidiSet]
        : null;
      clearKeyboardReleaseGuard();
      saveKeyboardSettings();
      recomputeSound();
    });

    retriggerChordToggle.addEventListener("change", () => {
      state.retriggerChordOnChangeEnabled = retriggerChordToggle.checked;
      state.retriggerChordRequested = false;
    });

    resetMemoryButton.addEventListener("click", () => {
      resetChordMemory();
    });

    bindRepertoireControls();

    extensionVoicingInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        state.extensionVoicing = input.value;
        clearKeyboardReleaseGuard();
        recomputeSound();
      });
    });

    desktopMouseModeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        state.desktopMouseMode = input.value;
        clearAllHeldState();
        state.heldMouseChordRoots.clear();
        recomputeSound();
      });
    });

    mobileModeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        state.mobileMode = input.value;
        clearMobileGestureState();
        updateMobileModifierState();
        recomputeSound();
      });
    });

    mobileModifierButtons.forEach((button) => {
      button.addEventListener("pointerdown", handleMobileModifierDown);
      button.addEventListener("pointerup", handleMobileModifierUp);
      button.addEventListener("pointercancel", handleMobileModifierUp);
      button.addEventListener("lostpointercapture", handleMobileModifierUp);
      button.addEventListener("contextmenu", (event) => event.preventDefault());
    });

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", clearAllHeldState);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearAllHeldState();
      }
    });
  }


  function bindRepertoireControls() {
    if (!repertoireTableBody) {
      return;
    }

    addSongButton.addEventListener("click", addSongFromInputs);
    [songTitleInput, songKeyInput, songUrlInput].forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addSongFromInputs();
        }
      });
    });

    songSearchInput.addEventListener("input", () => {
      state.songSearchQuery = songSearchInput.value.trim().toLowerCase();
      renderRepertoire();
    });

    songSearchButton.addEventListener("click", () => {
      focusFirstSearchResult();
    });

    startLoadPlaylistButton.addEventListener("click", openPlaylistBrowser);
    startNewPlaylistButton.addEventListener("click", openNewPlaylistDialog);
    loadPlaylistButton.addEventListener("click", openPlaylistBrowser);
    newPlaylistButton.addEventListener("click", openNewPlaylistDialog);
    playlistDialogClose.addEventListener("click", closePlaylistBrowser);
    playlistDialog.addEventListener("click", (event) => {
      if (event.target?.hasAttribute("data-playlist-close")) {
        closePlaylistBrowser();
      }
    });

    youtubePlayPause.addEventListener("click", triggerSelectedSongToggle);
    youtubeRewind.addEventListener("click", () => seekYouTube(-getYouTubeSeekSeconds()));
    youtubeForward.addEventListener("click", () => seekYouTube(getYouTubeSeekSeconds()));
    youtubeSeekSeconds.addEventListener("input", () => {
      state.youtubeSeekSeconds = getYouTubeSeekSeconds();
      savePlayerSettings();
      updateYouTubeSeekButtons();
    });
    updateYouTubeSeekButtons();
  }

  function loadRepertoireState() {
    const playlist = readJsonStorage(REPERTOIRE_STORAGE_KEY, null);
    const data = normalizeRepertoireFileData(playlist || { songs: [] });
    state.activePlaylistName = String(playlist?.name || "");
    state.activePlaylistPath = String(playlist?.path || "");
    state.activePlaylistSha = String(playlist?.sha || "");
    state.repertoire = data.songs;

    const settings = readJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {});
    state.youtubeSeekSeconds = clamp(Number(settings.seekSeconds) || DEFAULT_YOUTUBE_SEEK_SECONDS, 1, 60);
    if (youtubeSeekSeconds) {
      youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);
    }

    const savedSongId = typeof data.selectedSongId === "string" && data.selectedSongId
      ? data.selectedSongId
      : typeof settings.selectedSongId === "string" ? settings.selectedSongId : null;
    state.selectedSongId = state.repertoire.some((song) => song.id === savedSongId)
      ? savedSongId
      : state.repertoire[0]?.id || null;
  }

  function loadKeyboardSettings() {
    const settings = readJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {});
    state.doubleTapSharpMs = normalizeDoubleTapSharpMs(settings.doubleTapSharpMs);
    state.closeVoicingEnabled = Boolean(settings.closeVoicingEnabled);
    state.dugmetaraRows = settings.dugmetaraRows === "3" ? "3" : "4";
    if (doubleTapSharpControl) {
      doubleTapSharpControl.value = String(state.doubleTapSharpMs);
    }
    if (closeVoicingToggle) {
      closeVoicingToggle.checked = state.closeVoicingEnabled;
    }
    dugmetaraRowInputs.forEach((input) => {
      input.checked = input.value === state.dugmetaraRows;
    });
  }

  function saveKeyboardSettings() {
    writeJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {
      doubleTapSharpMs: state.doubleTapSharpMs,
      closeVoicingEnabled: state.closeVoicingEnabled,
      dugmetaraRows: state.dugmetaraRows
    });
  }

  function readJsonStorage(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      setYouTubeStatus("Cuvanje nije dostupno");
    }
  }

  function readSessionValue(key) {
    try {
      return window.sessionStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function writeSessionValue(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // The token can still be entered again if session storage is unavailable.
    }
  }

  function getGitHubToken() {
    return readSessionValue(GITHUB_TOKEN_STORAGE_KEY).trim();
  }

  function ensureGitHubToken() {
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

  function updatePlaylistMode() {
    const hasPlaylist = Boolean(state.activePlaylistName && state.activePlaylistPath);
    playlistStart.hidden = hasPlaylist;
    playlistWorkspace.hidden = !hasPlaylist;
  }

  async function openPlaylistBrowser() {
    state.playlistBrowserOpen = true;
    playlistDialog.hidden = false;
    playlistDialogTitle.textContent = "Load playlist";
    playlistBrowser.innerHTML = '<div class="playlist-browser-state">Ucitavanje...</div>';
    setYouTubeStatus("Ucitavanje playlisti");

    try {
      state.availablePlaylists = await fetchServerPlaylists();
      renderPlaylistBrowser();
      setYouTubeStatus(state.availablePlaylists.length ? "Playlists ucitane" : "Nema playlisti");
    } catch {
      playlistBrowser.innerHTML = '<div class="playlist-browser-state">Playlists nisu dostupne</div>';
      setYouTubeStatus("Playlists nisu dostupne");
    }
  }

  function closePlaylistBrowser() {
    state.playlistBrowserOpen = false;
    playlistDialog.hidden = true;
  }

  async function fetchServerPlaylists() {
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

  function renderPlaylistBrowser() {
    playlistBrowser.innerHTML = "";
    if (!state.availablePlaylists.length) {
      const empty = document.createElement("div");
      empty.className = "playlist-browser-state";
      empty.textContent = "Nema sacuvanih playlisti";
      playlistBrowser.append(empty);
      return;
    }

    state.availablePlaylists.forEach((playlist) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "playlist-browser-item";
      button.setAttribute("role", "listitem");
      button.textContent = playlist.name;
      button.addEventListener("click", () => loadPlaylistFromServer(playlist));
      playlistBrowser.append(button);
    });
  }

  async function loadPlaylistFromServer(playlist) {
    setYouTubeStatus("Ucitavanje playliste");
    try {
      const response = await fetch(`${playlist.url}?cache=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Playlist nije ucitana");
      }
      const data = normalizeRepertoireFileData(await response.json());
      ensureGitHubToken();
      applyRepertoireFileData(data, {
        playlistName: data.name || playlist.name,
        playlistPath: playlist.path,
        playlistSha: playlist.sha,
        skipFileSave: true,
        status: `Playlist: ${data.name || playlist.name}`
      });
      closePlaylistBrowser();
    } catch {
      setYouTubeStatus("Playlist nije ucitana");
    }
  }

  function openNewPlaylistDialog() {
    state.playlistBrowserOpen = true;
    playlistDialog.hidden = false;
    playlistDialogTitle.textContent = "New playlist";
    playlistBrowser.innerHTML = "";

    const form = document.createElement("form");
    form.className = "playlist-new-form";
    form.innerHTML = `
      <label class="stacked-field">
        <span>Ime playliste</span>
        <input id="newPlaylistNameInput" class="sheet-input" type="text" autocomplete="off" required>
      </label>
      <label class="stacked-field">
        <span>GitHub token</span>
        <input id="githubTokenInput" class="sheet-input" type="password" autocomplete="off" placeholder="fine-grained token">
      </label>
      <button class="text-button primary-button" type="submit">Napravi</button>
    `;
    playlistBrowser.append(form);

    const tokenInput = form.querySelector("#githubTokenInput");
    tokenInput.value = getGitHubToken();
    form.querySelector("#newPlaylistNameInput").focus();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createNewPlaylistOnServer(
        form.querySelector("#newPlaylistNameInput").value,
        tokenInput.value
      );
    });
  }

  async function createNewPlaylistOnServer(name, token) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      return;
    }

    const normalizedToken = String(token || "").trim();
    if (!normalizedToken) {
      setYouTubeStatus("GitHub token je potreban");
      return;
    }
    writeSessionValue(GITHUB_TOKEN_STORAGE_KEY, normalizedToken);

    const path = `${PLAYLIST_BASE_PATH}${slugifyPlaylistName(normalizedName)}${PLAYLIST_FILE_EXTENSION}`;
    const data = {
      version: 1,
      name: normalizedName,
      updatedAt: new Date().toISOString(),
      settings: {
        selectedSongId: null,
        seekSeconds: state.youtubeSeekSeconds
      },
      songs: []
    };

    setYouTubeStatus("Pravljenje playliste");
    try {
      const result = await putGitHubFile(path, data, {
        message: `Create playlist ${normalizedName}`
      });
      state.activePlaylistName = normalizedName;
      state.activePlaylistPath = path;
      state.activePlaylistSha = result.content?.sha || "";
      state.repertoire = [];
      state.selectedSongId = null;
      saveRepertoire({ skipServerSave: true });
      renderRepertoire();
      updateSelectedSongPanel();
      updatePlaylistMode();
      closePlaylistBrowser();
      setYouTubeStatus(`Playlist napravljena: ${normalizedName}`);
    } catch (error) {
      setYouTubeStatus(error?.status === 422 ? "Playlist vec postoji" : "Playlist nije napravljena");
    }
  }

  function slugifyPlaylistName(name) {
    return String(name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "playlist";
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
      chords
    };
  }

  function saveRepertoire(options = {}) {
    writeJsonStorage(REPERTOIRE_STORAGE_KEY, {
      name: state.activePlaylistName,
      path: state.activePlaylistPath,
      sha: state.activePlaylistSha,
      ...buildRepertoireFileData()
    });
    savePlayerSettings();
    if (!options.skipFileSave && !options.skipServerSave) {
      scheduleServerPlaylistSave();
    }
  }

  function scheduleServerPlaylistSave(delay = 700) {
    if (!state.activePlaylistPath) {
      return;
    }
    if (!getGitHubToken()) {
      setYouTubeStatus("GitHub token je potreban");
      return;
    }
    if (state.playlistSaveTimer) {
      window.clearTimeout(state.playlistSaveTimer);
    }
    state.playlistSaveTimer = window.setTimeout(() => {
      state.playlistSaveTimer = null;
      saveActivePlaylistToServer();
    }, delay);
  }

  async function saveActivePlaylistToServer(options = {}) {
    if (!state.activePlaylistPath) {
      return;
    }
    if (state.playlistSaveInFlight) {
      state.playlistDirtyAfterSave = true;
      return;
    }

    state.playlistSaveInFlight = true;
    state.playlistDirtyAfterSave = false;
    setYouTubeStatus("Cuvanje playliste");

    try {
      const result = await putGitHubFile(state.activePlaylistPath, buildRepertoireFileData(), {
        message: `Update playlist ${state.activePlaylistName || state.activePlaylistPath}`,
        sha: state.activePlaylistSha
      });
      state.activePlaylistSha = result.content?.sha || state.activePlaylistSha;
      saveRepertoire({ skipServerSave: true });
      setYouTubeStatus("Playlist sacuvana");
    } catch (error) {
      if (!options.retry && (error?.status === 409 || error?.status === 422 || error?.status === 404)) {
        const metadata = await fetchGitHubFileMetadata(state.activePlaylistPath);
        state.activePlaylistSha = metadata.sha || "";
        state.playlistSaveInFlight = false;
        return await saveActivePlaylistToServer({ retry: true });
      }
      setYouTubeStatus(error?.status === 401 ? "GitHub token nije dobar" : "Playlist nije sacuvana");
    } finally {
      state.playlistSaveInFlight = false;
      if (state.playlistDirtyAfterSave) {
        scheduleServerPlaylistSave(150);
      }
    }
  }

  async function putGitHubFile(path, data, options = {}) {
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

  async function fetchGitHubFileMetadata(path) {
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

  function savePlayerSettings() {
    writeJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {
      selectedSongId: state.selectedSongId,
      seekSeconds: state.youtubeSeekSeconds
    });
  }

  function createSongId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildRepertoireFileData() {
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
        ...(Array.isArray(song.chords) && song.chords.length ? { chords: song.chords } : {})
      }))
    };
  }

  function normalizeRepertoireFileData(data) {
    const songsSource = Array.isArray(data) ? data : Array.isArray(data?.songs) ? data.songs : [];
    const songs = songsSource.map(normalizeSong).filter((song) => song.url || song.videoId || song.title);
    const selectedSongId = String(data?.settings?.selectedSongId || data?.selectedSongId || "");
    const seekSeconds = Number(data?.settings?.seekSeconds || data?.seekSeconds || state.youtubeSeekSeconds);

    return {
      name: String(data?.name || ""),
      path: String(data?.path || ""),
      songs,
      selectedSongId,
      seekSeconds: clamp(seekSeconds || DEFAULT_YOUTUBE_SEEK_SECONDS, 1, 60)
    };
  }

  function applyRepertoireFileData(data, options = {}) {
    if (data.name || options.playlistName) {
      state.activePlaylistName = String(options.playlistName || data.name);
    }
    if (data.path || options.playlistPath) {
      state.activePlaylistPath = String(options.playlistPath || data.path);
    }
    if (options.playlistSha) {
      state.activePlaylistSha = String(options.playlistSha);
    }
    state.repertoire = options.merge
      ? mergeRepertoireSongs(state.repertoire, data.songs)
      : data.songs;
    state.selectedSongId = state.repertoire.some((song) => song.id === data.selectedSongId)
      ? data.selectedSongId
      : state.repertoire[0]?.id || null;
    state.youtubeSeekSeconds = data.seekSeconds;
    if (youtubeSeekSeconds) {
      youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);
    }

    saveRepertoire({ skipFileSave: options.skipFileSave });
    renderRepertoire();
    updateSelectedSongPanel();
    updateYouTubeSeekButtons();
    updatePlaylistMode();
    if (options.status) {
      setYouTubeStatus(options.status);
    }
  }

  function mergeRepertoireSongs(currentSongs, importedSongs) {
    const usedKeys = new Set();
    const merged = [];

    [...currentSongs, ...importedSongs].forEach((song) => {
      const normalized = normalizeSong(song);
      const key = getSongIdentityKey(normalized);
      if (usedKeys.has(key)) {
        return;
      }
      usedKeys.add(key);
      merged.push(normalized);
    });

    return merged;
  }

  function getSongIdentityKey(song) {
    return song.videoId || song.url || `${song.title}|${song.key}`.toLowerCase();
  }

  function addSongFromInputs() {
    const title = songTitleInput.value.trim();
    const key = songKeyInput.value.trim();
    const url = songUrlInput.value.trim();
    const videoId = parseYouTubeVideoId(url);

    if (!videoId) {
      setYouTubeStatus("Unesi YouTube link");
      songUrlInput.focus();
      return;
    }

    const song = {
      id: createSongId(),
      title: title || `YouTube ${videoId}`,
      key,
      url,
      videoId
    };

    state.repertoire.push(song);
    state.selectedSongId = song.id;
    songTitleInput.value = "";
    songKeyInput.value = "";
    songUrlInput.value = "";
    saveRepertoire();
    renderRepertoire();
    updateSelectedSongPanel();
    loadSelectedSong({ autoplay: false });
    setYouTubeStatus("Dodato");
  }

  function renderCompactSongList() {
    const listEl = document.getElementById("songList");
    if (!listEl) {
      return;
    }
    listEl.innerHTML = "";
    const visibleSongs = getVisibleRepertoireSongs();
    if (!visibleSongs.length) {
      const empty = document.createElement("div");
      empty.className = "song-list-empty";
      empty.textContent = state.repertoire.length ? "Nema rezultata" : "Prazna playlist — dodaj pesmu";
      listEl.append(empty);
      return;
    }
    visibleSongs.forEach(({ song }) => {
      const item = document.createElement("div");
      item.className = "song-item" + (song.id === state.selectedSongId ? " on" : "");
      item.dataset.songId = song.id;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "song-item-main";
      const chordCount = Array.isArray(song.chords) ? song.chords.length : 0;
      main.innerHTML =
        '<span class="si-title"></span><span class="si-key"></span>' +
        '<span class="si-sub">' + (chordCount ? "chart · " + chordCount + " akorada" : "samo link") + "</span>";
      main.querySelector(".si-title").textContent = song.title || "(bez naziva)";
      main.querySelector(".si-key").textContent = song.key || "";
      main.addEventListener("click", () => selectSong(song.id));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "song-item-del";
      del.textContent = "×";
      del.title = "Obrisi pesmu";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSong(song.id);
      });

      item.append(main, del);
      listEl.append(item);
    });
  }

  function renderRepertoire() {
    if (!repertoireTableBody) {
      return;
    }

    repertoireTableBody.innerHTML = "";
    const visibleSongs = getVisibleRepertoireSongs();

    if (!visibleSongs.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "empty-sheet-cell";
      cell.textContent = state.repertoire.length ? "Nema rezultata" : "Prazna playlist";
      row.append(cell);
      repertoireTableBody.append(row);
      updateSelectedSongPanel();
      return;
    }

    visibleSongs.forEach(({ song, index }) => {
      const row = document.createElement("tr");
      row.classList.toggle("is-selected", song.id === state.selectedSongId);
      row.dataset.songId = song.id;
      row.addEventListener("click", () => selectSong(song.id));
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        moveSongBefore(event.dataTransfer.getData("text/plain"), song.id);
      });

      row.append(createDragHandleCell(song, index));
      row.append(createInputCell(song, "title", "Naziv pesme"));
      row.append(createInputCell(song, "key", "Tonalitet"));
      row.append(createInputCell(song, "url", "YouTube link"));
      row.append(createActionCell(song.id));
      repertoireTableBody.append(row);
    });

    updateSelectedSongPanel();
  }

  function getVisibleRepertoireSongs() {
    const query = state.songSearchQuery;
    return state.repertoire
      .map((song, index) => ({ song, index }))
      .filter(({ song }) => {
        if (!query) {
          return true;
        }
        return [song.title, song.key, song.url]
          .some((value) => String(value || "").toLowerCase().includes(query));
      });
  }

  function focusFirstSearchResult() {
    const firstVisible = getVisibleRepertoireSongs()[0];
    if (!firstVisible) {
      setYouTubeStatus("Nema rezultata");
      return;
    }
    selectSong(firstVisible.song.id);
    requestAnimationFrame(() => {
      repertoireTableBody.querySelector(`[data-song-id="${firstVisible.song.id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }

  function createDragHandleCell(song, index) {
    const cell = document.createElement("td");
    cell.className = "song-index drag-handle-cell";
    cell.textContent = String(index + 1);
    cell.draggable = true;
    cell.title = "Pomeri pesmu";
    cell.setAttribute("aria-label", `Pomeri pesmu ${index + 1}`);
    cell.addEventListener("click", (event) => event.stopPropagation());
    cell.addEventListener("dragstart", (event) => {
      cell.closest("tr")?.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", song.id);
    });
    cell.addEventListener("dragend", () => {
      cell.closest("tr")?.classList.remove("is-dragging");
    });
    return cell;
  }

  function createTextCell(text, className) {
    const cell = document.createElement("td");
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function createInputCell(song, field, label) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.className = "sheet-input sheet-cell-input";
    input.type = field === "url" ? "url" : "text";
    input.value = song[field] || "";
    input.setAttribute("aria-label", label);
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      song[field] = input.value;
      if (field === "url") {
        song.videoId = parseYouTubeVideoId(input.value);
      }
      if (song.id === state.selectedSongId) {
        updateSelectedSongPanel();
      }
      saveRepertoire();
    });
    input.addEventListener("focus", () => selectSong(song.id, { render: false }));
    cell.append(input);
    return cell;
  }

  function createOrderCell(songId, index) {
    const cell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "order-actions";
    const up = createMiniButton("Gore", () => moveSong(songId, -1));
    const down = createMiniButton("Dole", () => moveSong(songId, 1));
    up.disabled = index === 0;
    down.disabled = index === state.repertoire.length - 1;
    actions.append(up, down);
    cell.append(actions);
    return cell;
  }

  function createActionCell(songId) {
    const cell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const toggleButton = createMiniButton(getSongToggleLabel(songId), () => toggleSongPlayback(songId));
    const deleteButton = createMiniButton("X", () => deleteSong(songId));
    toggleButton.dataset.songToggle = songId;
    deleteButton.classList.add("danger-button");
    deleteButton.title = "Obrisi";
    deleteButton.setAttribute("aria-label", "Obrisi pesmu");
    actions.append(toggleButton, deleteButton);
    cell.append(actions);
    return cell;
  }

  function createMiniButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-button";
    button.textContent = text;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function selectSong(songId, options = {}) {
    const song = state.repertoire.find((item) => item.id === songId);
    if (!song) {
      return;
    }

    state.selectedSongId = song.id;
    savePlayerSettings();
    updateSelectedSongPanel();
    if (options.render !== false) {
      renderRepertoire();
    }
    if (options.load) {
      loadSelectedSong({ autoplay: Boolean(options.autoplay) });
    }
  }

  function updateSelectedSong(fields) {
    const song = getSelectedSong();
    if (!song) {
      return;
    }
    Object.assign(song, fields);
    saveRepertoire();
    updateSelectedSongPanel();
  }

  function updateSelectedSongPanel() {
    const song = getSelectedSong();
    selectedSongTitle.value = song?.title || "-";
    selectedSongKeyDisplay.value = song?.key ? `- ${song.key}` : "";
    renderCompactSongList();
    window.dispatchEvent(new CustomEvent("fgr:songchange", { detail: { song: song || null } }));
  }

  function getSelectedSong() {
    return state.repertoire.find((song) => song.id === state.selectedSongId) || null;
  }

  function moveSong(songId, direction) {
    const index = state.repertoire.findIndex((song) => song.id === songId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= state.repertoire.length) {
      return;
    }

    const [song] = state.repertoire.splice(index, 1);
    state.repertoire.splice(nextIndex, 0, song);
    state.selectedSongId = songId;
    saveRepertoire();
    renderRepertoire();
  }

  function moveSongBefore(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) {
      return;
    }

    const sourceIndex = state.repertoire.findIndex((song) => song.id === sourceId);
    const targetIndex = state.repertoire.findIndex((song) => song.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }

    const [song] = state.repertoire.splice(sourceIndex, 1);
    const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    state.repertoire.splice(adjustedTarget, 0, song);
    state.selectedSongId = sourceId;
    saveRepertoire();
    renderRepertoire();
  }

  function deleteSong(songId) {
    const index = state.repertoire.findIndex((song) => song.id === songId);
    if (index < 0) {
      return;
    }

    state.repertoire.splice(index, 1);
    if (state.selectedSongId === songId) {
      state.selectedSongId = state.repertoire[Math.min(index, state.repertoire.length - 1)]?.id || null;
    }
    saveRepertoire();
    renderRepertoire();
    updateSelectedSongPanel();
  }

  function handleYouTubeShortcut(event) {
    const isPlayerShortcut = event.code === "Backquote" || event.code === "Digit1" || event.code === "Digit2";
    if (!isPlayerShortcut) {
      return false;
    }

    event.preventDefault();

    if (event.type !== "keydown") {
      return true;
    }
    if (event.repeat) {
      return true;
    }

    if (event.code === "Backquote") {
      if (event.altKey) {
        seekYouTubeToStart();
      } else {
        triggerSelectedSongToggle();
      }
      return true;
    }
    if (event.code === "Digit1") {
      seekYouTube(-getYouTubeSeekSeconds());
      return true;
    }
    if (event.code === "Digit2") {
      seekYouTube(getYouTubeSeekSeconds());
      return true;
    }

    return true;
  }

  function loadSelectedSong(options = {}) {
    const song = getSelectedSong();
    if (!song?.videoId) {
      setYouTubeStatus("Izaberi pesmu");
      return Promise.resolve(null);
    }

    setYouTubeStatus("YouTube se ucitava");
    if (!options.keepDesired) {
      state.youtubeDesiredPlaying = Boolean(options.autoplay);
    }
    state.youtubePauseGuardUntil = 0;
    return ensureYouTubePlayer()
      .then((player) => {
        if (!player) {
          return null;
        }
        if (options.autoplay) {
          player.loadVideoById(song.videoId);
        } else {
          player.cueVideoById(song.videoId);
        }
        state.youtubeLoadedVideoId = song.videoId;
        setYouTubeStatus(song.title || "Ucitan video");
        return player;
      })
      .catch(() => {
        state.youtubeDesiredPlaying = false;
        updateRepertoirePlaybackButtons();
        setYouTubeStatus("YouTube nije dostupan");
        return null;
      });
  }

  function triggerSelectedSongToggle() {
    const song = getSelectedSong();
    if (!song) {
      setYouTubeStatus("Dodaj pesmu");
      return;
    }

    const toggleButton = [...repertoireTableBody.querySelectorAll("[data-song-toggle]")]
      .find((button) => button.dataset.songToggle === song.id);
    if (toggleButton) {
      toggleButton.click();
      return;
    }

    toggleSongPlayback(song.id);
  }

  function toggleSongPlayback(songId) {
    const song = state.repertoire.find((item) => item.id === songId);
    if (!song) {
      setYouTubeStatus("Dodaj pesmu");
      return;
    }
    if (!song.videoId) {
      setYouTubeStatus("Unesi YouTube link");
      return;
    }

    const wasSelected = state.selectedSongId === song.id;
    const shouldPlay = !(wasSelected && state.youtubeDesiredPlaying);
    const commandToken = state.youtubeCommandToken + 1;
    state.youtubeCommandToken = commandToken;
    state.selectedSongId = song.id;
    state.youtubeDesiredPlaying = shouldPlay;
    savePlayerSettings();
    updateSelectedSongPanel();
    updateRepertoirePlaybackButtons();

    if (!wasSelected) {
      renderRepertoire();
    }

    if (!shouldPlay) {
      setYouTubeStatus("Pauza");
      const player = state.youtubePlayerReady ? state.youtubePlayer : null;
      if (player) {
        pauseYouTubeNow(player);
      }
      updateRepertoirePlaybackButtons();
      return;
    }

    state.youtubePauseGuardUntil = 0;
    clearYouTubePauseRetries();
    setYouTubeStatus(song.title || "Pusti");
    updateRepertoirePlaybackButtons();
    ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
      if (
        !player ||
        commandToken !== state.youtubeCommandToken ||
        !state.youtubeDesiredPlaying ||
        state.selectedSongId !== song.id
      ) {
        return;
      }
      playYouTubeNow(player);
    });
  }

  function getSongToggleLabel(songId) {
    return state.selectedSongId === songId && state.youtubeDesiredPlaying ? "Pauza" : "Pusti";
  }

  function updateRepertoirePlaybackButtons() {
    if (youtubePlayPause) {
      youtubePlayPause.textContent = state.youtubeDesiredPlaying ? "Pauza" : "Pusti";
    }
    if (!repertoireTableBody) {
      return;
    }
    repertoireTableBody.querySelectorAll("[data-song-toggle]").forEach((button) => {
      button.textContent = getSongToggleLabel(button.dataset.songToggle);
    });
  }

  function seekYouTubeToStart() {
    const song = getSelectedSong();
    if (!song) {
      setYouTubeStatus("Dodaj pesmu");
      return;
    }

    state.youtubeResumeTime = 0;
    ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
      if (!player || typeof player.seekTo !== "function") {
        return;
      }
      player.seekTo(0, true);
      if (state.youtubeDesiredPlaying && typeof player.playVideo === "function") {
        player.playVideo();
      }
      setYouTubeStatus("Pocetak");
    });
  }
  function seekYouTube(deltaSeconds) {
    const song = getSelectedSong();
    if (!song) {
      setYouTubeStatus("Dodaj pesmu");
      return;
    }

    ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
      if (!player || typeof player.getCurrentTime !== "function") {
        return;
      }
      const duration = typeof player.getDuration === "function" ? player.getDuration() : 0;
      const current = player.getCurrentTime() || 0;
      const target = duration > 0
        ? clamp(current + deltaSeconds, 0, Math.max(0, duration - 0.2))
        : Math.max(0, current + deltaSeconds);
      player.seekTo(target, true);
      setYouTubeStatus(`${deltaSeconds < 0 ? "Nazad" : "Napred"} ${Math.abs(deltaSeconds)}s`);
    });
  }

  function ensureSelectedVideoLoaded(options = {}) {
    const song = getSelectedSong();
    if (!song?.videoId) {
      setYouTubeStatus("Izaberi pesmu");
      return Promise.resolve(null);
    }

    if (state.youtubePlayer && state.youtubePlayerReady && state.youtubeLoadedVideoId === song.videoId) {
      return Promise.resolve(state.youtubePlayer);
    }

    return loadSelectedSong(options);
  }

  function ensureYouTubePlayer() {
    if (state.youtubePlayer && state.youtubePlayerReady) {
      return Promise.resolve(state.youtubePlayer);
    }
    if (state.youtubePlayerPromise) {
      return state.youtubePlayerPromise;
    }

    state.youtubePlayerPromise = ensureYouTubeApi().then(() => new Promise((resolve) => {
      state.youtubePlayer = new window.YT.Player("youtubePlayer", {
        width: "100%",
        height: "100%",
        playerVars: getYouTubePlayerVars(),
        events: {
          onReady: (event) => {
            state.youtubePlayerReady = true;
            const iframe = event.target.getIframe?.();
            if (iframe) {
              iframe.setAttribute("tabindex", "-1");
            }
            resolve(event.target);
          },
          onStateChange: handleYouTubeStateChange,
          onError: handleYouTubeError
        }
      });
    })).catch((error) => {
      state.youtubePlayerPromise = null;
      throw error;
    });

    return state.youtubePlayerPromise;
  }

  function getYouTubePlayerVars() {
    const vars = {
      playsinline: 1,
      rel: 0,
      modestbranding: 1
    };
    const origin = getYouTubeOrigin();
    if (origin) {
      vars.origin = origin;
      vars.widget_referrer = origin;
    }
    return vars;
  }

  function getYouTubeOrigin() {
    return window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin
      : "";
  }

  function handleYouTubeError(event) {
    state.youtubeDesiredPlaying = false;
    updateRepertoirePlaybackButtons();

    if (event?.data === 153) {
      setYouTubeStatus(
        getYouTubeOrigin()
          ? "YouTube 153 - osvezi stranu ili probaj drugi link"
          : "YouTube trazi localhost; iz index.html fajla ne radi pouzdano"
      );
      return;
    }

    setYouTubeStatus("Embed blokiran - otvori YouTube ili probaj drugi link");
  }

  function handleYouTubeStateChange(event) {
    const states = window.YT?.PlayerState;
    if (!states) {
      return;
    }

    const isPlayingNow = event.data === states.PLAYING || event.data === states.BUFFERING;
    if (isPlayingNow && !state.youtubeDesiredPlaying) {
      pauseYouTubeNow(event.target);
      return;
    }

    if (event.data === states.ENDED) {
      state.youtubeDesiredPlaying = false;
      state.youtubeResumeTime = 0;
      clearYouTubePauseRetries();
      updateRepertoirePlaybackButtons();
      return;
    }

    updateRepertoirePlaybackButtons();
  }

  function playYouTubeNow(player) {
    state.youtubeDesiredPlaying = true;
    state.youtubePauseGuardUntil = 0;
    clearYouTubePauseRetries();
    if (state.youtubeResumeTime > 0 && typeof player.seekTo === "function") {
      player.seekTo(state.youtubeResumeTime, true);
    }
    player.playVideo();
    updateRepertoirePlaybackButtons();
  }

  function pauseYouTubeNow(player) {
    state.youtubeDesiredPlaying = false;
    state.youtubePauseGuardUntil = Date.now() + YOUTUBE_PAUSE_GUARD_MS;
    updateRepertoirePlaybackButtons();

    if (typeof player.getCurrentTime === "function") {
      const currentTime = Number(player.getCurrentTime()) || 0;
      if (currentTime > 0) {
        state.youtubeResumeTime = currentTime;
      }
    }

    clearYouTubePauseRetries();
    YOUTUBE_PAUSE_RETRY_DELAYS.forEach((delay) => {
      const timerId = window.setTimeout(() => {
        if (state.youtubeDesiredPlaying || !player || typeof player.pauseVideo !== "function") {
          return;
        }
        player.pauseVideo();
      }, delay);
      state.youtubePauseRetryTimers.push(timerId);
    });
  }


  function clearYouTubePauseRetries() {
    state.youtubePauseRetryTimers.forEach((timerId) => window.clearTimeout(timerId));
    state.youtubePauseRetryTimers = [];
  }

  function isYouTubePlayingState(playerState) {
    const states = window.YT?.PlayerState;
    return Boolean(states && (playerState === states.PLAYING || playerState === states.BUFFERING));
  }

  function openSelectedSongOnYouTube() {
    const song = getSelectedSong();
    const url = song?.url || (song?.videoId ? `https://www.youtube.com/watch?v=${song.videoId}` : "");
    if (!url) {
      setYouTubeStatus("Dodaj pesmu");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
  function ensureYouTubeApi() {
    if (window.YT?.Player) {
      return Promise.resolve();
    }
    if (state.youtubeApiPromise) {
      return state.youtubeApiPromise;
    }

    state.youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previousReady === "function") {
          previousReady();
        }
        resolve();
      };

      const script = document.createElement("script");
      script.src = YOUTUBE_API_SRC;
      script.async = true;
      script.onerror = () => {
        state.youtubeApiPromise = null;
        reject(new Error("YouTube API nije dostupan"));
      };
      document.head.append(script);
    });

    return state.youtubeApiPromise;
  }

  function getYouTubeSeekSeconds() {
    const value = clamp(Number(youtubeSeekSeconds.value) || DEFAULT_YOUTUBE_SEEK_SECONDS, 1, 60);
    youtubeSeekSeconds.value = String(value);
    return value;
  }

  function updateYouTubeSeekButtons() {
    const seconds = getYouTubeSeekSeconds();
    youtubeRewind.textContent = `-${seconds}s`;
    youtubeForward.textContent = `+${seconds}s`;
  }

  function setYouTubeStatus(text) {
    if (youtubeStatus) {
      youtubeStatus.value = text;
    }
  }

  function parseYouTubeVideoId(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    try {
      const url = new URL(text);
      const host = url.hostname.replace(/^www\./, "");
      if (host === "youtu.be") {
        return sanitizeYouTubeVideoId(url.pathname.split("/").filter(Boolean)[0]);
      }
      if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
        const fromQuery = sanitizeYouTubeVideoId(url.searchParams.get("v"));
        if (fromQuery) {
          return fromQuery;
        }
        const parts = url.pathname.split("/").filter(Boolean);
        if (["embed", "shorts", "live"].includes(parts[0])) {
          return sanitizeYouTubeVideoId(parts[1]);
        }
      }
    } catch {
      return sanitizeYouTubeVideoId(text);
    }

    return sanitizeYouTubeVideoId(text);
  }

  function sanitizeYouTubeVideoId(value) {
    const match = String(value || "").match(/[A-Za-z0-9_-]{11}/);
    return match ? match[0] : "";
  }
  function renderKeyboard() {
    keyboard.innerHTML = "";
    state.keyElementsByMidi.clear();

    let whiteIndex = 0;
    const fragment = document.createDocumentFragment();

    for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi += 1) {
      const pitch = pitchFromMidi(midi);
      const isWhite = WHITE_PITCHES.has(pitch);
      const key = document.createElement("button");
      key.type = "button";
      key.className = `key ${isWhite ? "white" : "black"}`;
      key.dataset.midi = String(midi);
      key.setAttribute("aria-label", noteLabel(midi));
      key.setAttribute("tabindex", "-1");

      if (isWhite) {
        key.style.setProperty("--i", String(whiteIndex));
        whiteIndex += 1;
      } else {
        key.style.setProperty("--x", String(whiteIndex));
      }

      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = noteLabel(midi);
      key.append(label);

      key.addEventListener("pointerdown", handlePianoPointerDown);
      key.addEventListener("pointermove", handlePianoPointerMove);
      key.addEventListener("pointerup", handlePianoPointerUp);
      key.addEventListener("pointercancel", handlePianoPointerUp);
      key.addEventListener("lostpointercapture", handlePianoPointerUp);
      key.addEventListener("contextmenu", (event) => event.preventDefault());

      state.keyElementsByMidi.set(midi, key);
      fragment.append(key);
    }

    state.keyboardWhiteCount = whiteIndex;
    keyboard.style.setProperty("--white-count", String(whiteIndex));
    keyboard.append(fragment);
    fitKeyboardToContainer();
    observeKeyboardResize();
    requestAnimationFrame(() => scrollToBaseOctave(false));
  }

  function fitKeyboardToContainer() {
    if (!state.keyboardWhiteCount || !pianoScroll.clientWidth) {
      return;
    }

    const baseWhiteWidth = getBaseWhiteKeyWidth();
    const baseBlackWidth = getBaseBlackKeyWidth();
    const fittedWhiteWidth = Math.max(baseWhiteWidth, pianoScroll.clientWidth / state.keyboardWhiteCount);
    const fittedBlackWidth = fittedWhiteWidth * (baseBlackWidth / baseWhiteWidth);
    keyboard.style.setProperty("--white-w", `${fittedWhiteWidth}px`);
    keyboard.style.setProperty("--black-w", `${fittedBlackWidth}px`);
  }

  function getBaseWhiteKeyWidth() {
    const rootValue = getComputedStyle(document.documentElement).getPropertyValue("--white-w");
    const parsed = Number.parseFloat(rootValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 48;
  }

  function getBaseBlackKeyWidth() {
    const rootValue = getComputedStyle(document.documentElement).getPropertyValue("--black-w");
    const parsed = Number.parseFloat(rootValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  function observeKeyboardResize() {
    if (state.keyboardResizeObserver || typeof ResizeObserver === "undefined") {
      return;
    }

    state.keyboardResizeObserver = new ResizeObserver(() => {
      fitKeyboardToContainer();
    });
    state.keyboardResizeObserver.observe(pianoScroll);
  }

  function handlePianoPointerDown(event) {
    event.preventDefault();
    focusAppSoon();
    ensureAudio();

    const key = event.currentTarget;
    const midi = Number(key.dataset.midi);
    try {
      key.setPointerCapture(event.pointerId);
    } catch (error) {
      /* sinteticki pointer (npr. Ucenje tab) nema aktivan pointer za capture */
    }

    const isMouse = event.pointerType === "mouse";

    if (isMouse && state.desktopMouseMode === "chord") {
      state.inputOrder += 1;
      state.heldMouseChordRoots.set(event.pointerId, {
        midi,
        order: state.inputOrder
      });
      latchHeldLowerOctaveForCurrentChord();
      rememberHeldInversionForActiveChordRoots();
      latchHeldChordColorsForCurrentChord();
    } else if (!isMouse && state.mobileMode === "chord") {
      state.inputOrder += 1;
      state.heldMobileChordRoots.set(event.pointerId, {
        midi,
        order: state.inputOrder
      });
    } else {
      state.heldPointerTones.set(event.pointerId, midi);
    }

    recomputeSound();
  }

  function handlePianoPointerMove(event) {
    if (
      !state.heldPointerTones.has(event.pointerId) &&
      !state.heldMouseChordRoots.has(event.pointerId) &&
      !state.heldMobileChordRoots.has(event.pointerId)
    ) {
      return;
    }

    const key = getPianoKeyFromPoint(event.clientX, event.clientY);
    if (!key) {
      return;
    }

    const midi = Number(key.dataset.midi);
    let changed = false;

    if (state.heldPointerTones.has(event.pointerId) && state.heldPointerTones.get(event.pointerId) !== midi) {
      state.heldPointerTones.set(event.pointerId, midi);
      changed = true;
    }

    const mouseChordRoot = state.heldMouseChordRoots.get(event.pointerId);
    if (mouseChordRoot && mouseChordRoot.midi !== midi) {
      mouseChordRoot.midi = midi;
      changed = true;
    }

    const mobileChordRoot = state.heldMobileChordRoots.get(event.pointerId);
    if (mobileChordRoot && mobileChordRoot.midi !== midi) {
      mobileChordRoot.midi = midi;
      changed = true;
    }

    if (changed) {
      event.preventDefault();
      recomputeSound();
    }
  }

  function getPianoKeyFromPoint(x, y) {
    const element = document.elementFromPoint(x, y);
    const key = element?.closest?.(".key");
    return key && keyboard.contains(key) ? key : null;
  }

  function handlePianoPointerUp(event) {
    const pointerId = event.pointerId;
    state.heldPointerTones.delete(pointerId);
    state.heldMouseChordRoots.delete(pointerId);
    state.heldMobileChordRoots.delete(pointerId);
    clearLatchedLowerOctaveIfNoChordRoot();
    clearLatchedChordColorsIfNoChordRoot();
    recomputeSound();
  }

  function handleMobileModifierDown(event) {
    if (state.mobileMode !== "chord") {
      return;
    }

    event.preventDefault();
    focusAppSoon();
    ensureAudio();

    const button = event.currentTarget;
    const modifier = button.dataset.mobileModifier;
    button.setPointerCapture(event.pointerId);
    state.inputOrder += 1;

    if (modifier === "minor") {
      state.mobileMinorPointers.add(event.pointerId);
    } else if (modifier === "left" || modifier === "right") {
      state.mobileArrowPointers[modifier].set(event.pointerId, state.inputOrder);
    }

    updateMobileModifierState();
    clearKeyboardChordSettleTimer();
    recomputeSound();
  }

  function handleMobileModifierUp(event) {
    const button = event.currentTarget;
    const modifier = button.dataset.mobileModifier;

    if (modifier === "minor") {
      state.mobileMinorPointers.delete(event.pointerId);
    } else if (modifier === "left" || modifier === "right") {
      state.mobileArrowPointers[modifier].delete(event.pointerId);
    }

    updateMobileModifierState();
    recomputeSound();
  }

  function handleKeyDown(event) {
    if (!shouldHandleKeyboardEvent(event)) {
      return;
    }

    const physicalPianoActive = isPhysicalPianoModeActive();

    if (physicalPianoActive) {
      const midi = getDugmetaraKeyboardMidi(event.code);
      if (midi !== null) {
        event.preventDefault();

        if (event.repeat) {
          return;
        }

        focusAppSoon();
        ensureAudio();
        state.heldKeyboardTones.set(event.code, midi);
        recomputeSound();
      }
      return;
    }

    if (handleYouTubeShortcut(event)) {
      return;
    }

    const isMappedBase = !physicalPianoActive && KEYBOARD_MAP.has(event.code);
    const isMinor = KEYBOARD_MINOR_KEYS.has(event.code);
    const inversion = KEYBOARD_INVERSION_MAP.get(event.code);
    const inversionStep = KEYBOARD_INVERSION_STEP_MAP.get(event.code);
    const hasInversionStep = KEYBOARD_INVERSION_STEP_MAP.has(event.code);
    const lowerOctave = KEYBOARD_LOWER_OCTAVE_KEYS.has(event.code);
    const upperOctaveMemoryReset = KEYBOARD_UPPER_OCTAVE_MEMORY_KEYS.has(event.code);
    const pitchOffset = KEYBOARD_PITCH_OFFSET_MAP.get(event.code);
    const chordColor = KEYBOARD_CHORD_COLOR_MAP.get(event.code);
    const voiceModifier = KEYBOARD_VOICE_MODIFIER_MAP.get(event.code);
    const isModifier =
      isMinor ||
      Boolean(inversion) ||
      hasInversionStep ||
      lowerOctave ||
      upperOctaveMemoryReset ||
      Boolean(pitchOffset) ||
      Boolean(chordColor) ||
      Boolean(voiceModifier);

    if (!isMappedBase && !isModifier) {
      return;
    }

    event.preventDefault();

    if (event.repeat) {
      return;
    }

    focusAppSoon();
    ensureAudio();

    if (isMappedBase) {
      pressKeyboardBaseKey(event.code);
    } else if (isMinor) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardMinorKeys.set(event.code, state.inputOrder);
    } else if (inversion) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardInversions[inversion].set(event.code, state.inputOrder);
      rememberInversionForActiveChordRoots(inversionTypeToStep(inversion));
    } else if (hasInversionStep) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      stepInversionForActiveChordRoots(inversionStep);
    } else if (lowerOctave) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardLowerOctaves.set(event.code, state.inputOrder);
      latchLowerOctaveForCurrentChord(event.code);
    } else if (upperOctaveMemoryReset) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      clearLowerOctaveMemory();
    } else if (pitchOffset) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardPitchOffsets[pitchOffset].set(event.code, state.inputOrder);
    } else if (chordColor) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardChordColors[chordColor].set(event.code, state.inputOrder);
      latchChordColorForCurrentChord(chordColor);
    } else if (voiceModifier) {
      clearKeyboardReleaseGuard();
      requestChordRetrigger();
      state.inputOrder += 1;
      state.keyboardVoiceModifiers[voiceModifier].set(event.code, state.inputOrder);
    }

    if (isMappedBase || isMinor) {
      clearKeyboardChordSettleTimer();
      recomputeSound();
    } else {
      scheduleKeyboardChordRecompute();
    }
  }

  function handleKeyUp(event) {
    if (!shouldHandleKeyboardEvent(event)) {
      return;
    }

    const physicalPianoActive = isPhysicalPianoModeActive();

    if (physicalPianoActive) {
      if (getActiveDugmetaraKeyboardMap().has(event.code)) {
        event.preventDefault();
        state.heldKeyboardTones.delete(event.code);
        recomputeSound();
      }
      return;
    }

    if (handleYouTubeShortcut(event)) {
      return;
    }

    const isMappedBase = !physicalPianoActive && KEYBOARD_MAP.has(event.code);
    const isMinor = KEYBOARD_MINOR_KEYS.has(event.code);
    const inversion = KEYBOARD_INVERSION_MAP.get(event.code);
    const hasInversionStep = KEYBOARD_INVERSION_STEP_MAP.has(event.code);
    const lowerOctave = KEYBOARD_LOWER_OCTAVE_KEYS.has(event.code);
    const upperOctaveMemoryReset = KEYBOARD_UPPER_OCTAVE_MEMORY_KEYS.has(event.code);
    const pitchOffset = KEYBOARD_PITCH_OFFSET_MAP.get(event.code);
    const chordColor = KEYBOARD_CHORD_COLOR_MAP.get(event.code);
    const voiceModifier = KEYBOARD_VOICE_MODIFIER_MAP.get(event.code);
    const isModifier =
      isMinor ||
      Boolean(inversion) ||
      hasInversionStep ||
      lowerOctave ||
      upperOctaveMemoryReset ||
      Boolean(pitchOffset) ||
      Boolean(chordColor) ||
      Boolean(voiceModifier);

    if (!isMappedBase && !isModifier) {
      return;
    }

    event.preventDefault();

    const shouldFreezeChord = !isMappedBase && state.heldBaseKeys.size > 0;
    const chordBeforeRelease = shouldFreezeChord ? getKeyboardChord({ ignoreFreeze: true }) : null;

    if (isMappedBase) {
      releaseKeyboardBaseKey(event.code);
    } else if (isMinor) {
      state.keyboardMinorKeys.delete(event.code);
    } else if (inversion) {
      state.keyboardInversions[inversion].delete(event.code);
    } else if (lowerOctave) {
      state.keyboardLowerOctaves.delete(event.code);
    } else if (upperOctaveMemoryReset) {
      clearLowerOctaveMemory();
    } else if (pitchOffset) {
      state.keyboardPitchOffsets[pitchOffset].delete(event.code);
    } else if (chordColor) {
      state.keyboardChordColors[chordColor].delete(event.code);
    } else if (voiceModifier) {
      state.keyboardVoiceModifiers[voiceModifier].delete(event.code);
    }

    if (shouldFreezeChord && state.heldBaseKeys.size && chordBeforeRelease) {
      holdKeyboardChordBriefly(chordBeforeRelease);
    }

    clearKeyboardChordSettleTimer();
    recomputeSound();
  }

  function shouldHandleKeyboardEvent(event) {
    if (event.defaultPrevented || document.hidden || !document.hasFocus()) {
      return false;
    }

    const target = event.target;
    const tagName = target && target.tagName ? target.tagName.toLowerCase() : "";
    if (tagName === "input" && target.type !== "range" && target.type !== "checkbox" && target.type !== "radio") {
      return false;
    }
    if (tagName === "textarea" || target?.isContentEditable) {
      return false;
    }
    if (tagName === "select") {
      return false;
    }

    return true;
  }

  function recomputeSound() {
    const desired = new Set();
    const restartMidis = new Set();
    const chordDescriptions = [];
    let referenceChord = null;
    const shouldRetriggerChord = state.retriggerChordRequested;

    state.heldPointerTones.forEach((midi) => desired.add(midi));
    state.heldKeyboardTones.forEach((midi) => desired.add(midi));

    const keyboardChord = getKeyboardChord();
    if (keyboardChord) {
      keyboardChord.midis.forEach((midi) => desired.add(midi));
      if (shouldRetriggerChord) {
        keyboardChord.midis.forEach((midi) => restartMidis.add(midi));
      }
      chordDescriptions.push(keyboardChord.description);
      referenceChord = keyboardChord;
    }

    const mouseChord = getMouseChord();
    if (mouseChord) {
      mouseChord.midis.forEach((midi) => desired.add(midi));
      if (shouldRetriggerChord) {
        mouseChord.midis.forEach((midi) => restartMidis.add(midi));
      }
      chordDescriptions.push(mouseChord.description);
      referenceChord = mouseChord;
    }

    const mobileChord = getMobileChord();
    if (mobileChord) {
      mobileChord.midis.forEach((midi) => desired.add(midi));
      chordDescriptions.push(mobileChord.description);
      referenceChord = mobileChord;
    }

    setActiveMidiSet(desired, restartMidis);
    state.retriggerChordRequested = false;
    state.activeChordText = chordDescriptions.length ? chordDescriptions[chordDescriptions.length - 1] : "-";
    updateCloseVoicingReference(referenceChord);
    activeChordDisplay.value = state.activeChordText;
    updateHighlightedKeys();
  }

  function isPhysicalPianoModeActive() {
    return state.pianoKeyboardEnabled && state.desktopMouseMode === "tone";
  }

  function getDugmetaraKeyboardMidi(code) {
    const index = getActiveDugmetaraKeyboardMap().get(code);
    if (index === undefined) {
      return null;
    }

    return noteToMidi(0, state.baseOctave - 2) + index;
  }

  function getActiveDugmetaraKeyboardMap() {
    return DUGMETARA_KEYBOARD_MAPS[state.dugmetaraRows] || DUGMETARA_KEYBOARD_MAPS["4"];
  }

  function isMinorModifierActive() {
    return state.keyboardMinorKeys.size > 0;
  }

  function requestChordRetrigger() {
    if (!state.retriggerChordOnChangeEnabled) {
      return;
    }

    if (state.heldBaseKeys.size || state.heldMouseChordRoots.size) {
      state.retriggerChordRequested = true;
    }
  }

  function scheduleKeyboardChordRecompute() {
    clearKeyboardChordSettleTimer();
    state.keyboardChordSettleTimer = window.setTimeout(() => {
      state.keyboardChordSettleTimer = null;
      recomputeSound();
    }, KEYBOARD_CHORD_SETTLE_MS);
  }

  function pressKeyboardBaseKey(code) {
    clearKeyboardReleaseGuard();
    state.inputOrder += 1;
    flushPendingBaseKeyTapsExcept(code);

    const basePitch = KEYBOARD_MAP.get(code);
    const elapsed = performance.now() - state.lastBaseKeyTap.time;
    const isSharpDoubleTap =
      KEYBOARD_DOUBLE_TAP_SHARP_KEYS.has(code) &&
      state.lastBaseKeyTap.code === code &&
      elapsed >= 0 &&
      elapsed <= state.doubleTapSharpMs;

    if (isSharpDoubleTap) {
      cancelPendingBaseKeyTap(code);
      state.lastBaseKeyTap = { code: "", time: 0 };
      setKeyboardBaseKey(code, mod(basePitch + 1, 12), state.inputOrder);
      return;
    }

    if (KEYBOARD_DOUBLE_TAP_SHARP_KEYS.has(code)) {
      schedulePendingBaseKeyTap(code, basePitch, state.inputOrder);
      return;
    }

    setKeyboardBaseKey(code, basePitch, state.inputOrder);
  }

  function releaseKeyboardBaseKey(code) {
    rememberKeyboardBaseKeyRelease(code);

    const pending = state.pendingBaseKeyTaps.get(code);
    if (pending) {
      pending.released = true;
      return;
    }

    state.heldBaseKeys.delete(code);
    if (!state.heldBaseKeys.size) {
      clearKeyboardReleaseGuard();
    }
    clearLatchedLowerOctaveIfNoChordRoot();
    clearLatchedChordColorsIfNoChordRoot();
  }

  function setKeyboardBaseKey(code, pitch, order) {
    state.heldBaseKeys.set(code, { pitch, order });
    latchHeldLowerOctaveForCurrentChord();
    rememberHeldInversionForActiveChordRoots();
    latchHeldChordColorsForCurrentChord();
  }

  function schedulePendingBaseKeyTap(code, pitch, order) {
    cancelPendingBaseKeyTap(code);
    const pending = {
      pitch,
      order,
      released: false,
      timerId: window.setTimeout(() => {
        state.pendingBaseKeyTaps.delete(code);
        setKeyboardBaseKey(code, pending.pitch, pending.order);
        recomputeSound();
        if (pending.released) {
          releasePendingBaseKeyAfterSound(code, pending.order);
        }
      }, state.doubleTapSharpMs)
    };
    state.pendingBaseKeyTaps.set(code, pending);
  }

  function cancelPendingBaseKeyTap(code) {
    const pending = state.pendingBaseKeyTaps.get(code);
    if (!pending) {
      return;
    }
    window.clearTimeout(pending.timerId);
    state.pendingBaseKeyTaps.delete(code);
  }

  function flushPendingBaseKeyTapsExcept(activeCode) {
    [...state.pendingBaseKeyTaps.keys()].forEach((code) => {
      if (code !== activeCode) {
        flushPendingBaseKeyTap(code);
      }
    });
  }

  function flushPendingBaseKeyTap(code) {
    const pending = state.pendingBaseKeyTaps.get(code);
    if (!pending) {
      return;
    }
    window.clearTimeout(pending.timerId);
    state.pendingBaseKeyTaps.delete(code);
    setKeyboardBaseKey(code, pending.pitch, pending.order);
    if (pending.released) {
      releasePendingBaseKeyAfterSound(code, pending.order);
    }
  }

  function releasePendingBaseKeyAfterSound(code, order) {
    window.setTimeout(() => {
      const held = state.heldBaseKeys.get(code);
      if (!held || held.order !== order) {
        return;
      }
      state.heldBaseKeys.delete(code);
      clearLatchedLowerOctaveIfNoChordRoot();
      clearLatchedChordColorsIfNoChordRoot();
      recomputeSound();
    }, RELEASE_GUARD_MS);
  }

  function rememberKeyboardBaseKeyRelease(code) {
    state.lastBaseKeyTap = {
      code,
      time: performance.now()
    };
  }

  function clearPendingBaseKeyTaps() {
    state.pendingBaseKeyTaps.forEach((pending) => window.clearTimeout(pending.timerId));
    state.pendingBaseKeyTaps.clear();
  }

  function normalizeDoubleTapSharpMs(value) {
    return clamp(Number(value) || DEFAULT_KEYBOARD_DOUBLE_TAP_SHARP_MS, 30, 250);
  }

  function updateDoubleTapSharpDisplay() {
    if (doubleTapSharpDisplay) {
      doubleTapSharpDisplay.value = `${state.doubleTapSharpMs}ms`;
    }
  }

  function getKeyboardChord(options = {}) {
    if (!state.heldBaseKeys.size) {
      return null;
    }

    if (!options.ignoreFreeze && state.keyboardFrozenChord) {
      return state.keyboardFrozenChord;
    }

    const activeBase = maxByOrder([...state.heldBaseKeys.values()]);
    const rootKey = getKeyboardRootMemoryKey(activeBase.pitch);
    const rootMidi = getKeyboardRootMidi(activeBase.pitch);
    const quality = isMinorModifierActive() ? "minor" : "major";
    const inversion = getKeyboardInversion(rootKey);
    const color = getKeyboardChordColor();

    return buildChord(rootMidi, quality, inversion, color);
  }

  function getKeyboardRootMidi(pitch) {
    const rootKey = getKeyboardRootMemoryKey(pitch);
    const octave = isKeyboardLowerOctaveActive(rootKey) ? state.baseOctave - 1 : state.baseOctave;

    return noteToMidi(pitch, octave) + getKeyboardPitchOffset();
  }

  function getKeyboardChordColor() {
    return {
      seven: state.keyboardChordColors.seven.size > 0 || state.keyboardChordColorLatched.seven,
      nine: state.keyboardChordColors.nine.size > 0 || state.keyboardChordColorLatched.nine,
      maj: state.keyboardChordColors.maj.size > 0,
      sus: state.keyboardChordColors.sus.size > 0,
      dim: state.keyboardChordColors.dim.size > 0,
      raiseRoot: state.keyboardVoiceModifiers.raiseRoot.size > 0
    };
  }

  function getMouseChord() {
    if (!state.heldMouseChordRoots.size) {
      return null;
    }

    const activeRoot = maxByOrder([...state.heldMouseChordRoots.values()]);
    const rootKey = getRootMemoryKeyFromMidi(activeRoot.midi);
    const rootMidi = isKeyboardLowerOctaveActive(rootKey)
      ? activeRoot.midi - 12
      : activeRoot.midi;
    const quality = isMinorModifierActive() ? "minor" : "major";
    const inversion = getKeyboardInversion(rootKey);
    const color = getKeyboardChordColor();

    return buildChord(rootMidi, quality, inversion, color);
  }

  function getMobileChord() {
    if (state.mobileMode !== "chord" || !state.heldMobileChordRoots.size) {
      return null;
    }

    const activeRoot = maxByOrder([...state.heldMobileChordRoots.values()]);
    const quality = state.mobileMinorPointers.size ? "minor" : "major";
    const inversion = getMobileInversion();

    return buildChord(activeRoot.midi, quality, inversion);
  }

  function buildChord(rootMidi, quality, inversion, color = {}) {
    const effectiveQuality = color.dim ? "dim" : color.sus ? "sus" : quality;
    const preferredStep = normalizeInversionStep(inversion);
    const shape = getChordShape(rootMidi, effectiveQuality, preferredStep, color);
    const rootName = noteLabel(rootMidi);
    const qualityLabel = getChordQualityLabel(quality, color);
    const inversionLabel = getInversionLabel(shape.inversionStep);
    const closeLabel = state.closeVoicingEnabled ? " bliski" : "";
    const notes = shape.midis.map(noteLabel).join(" ");

    return {
      midis: shape.midis,
      description: `${rootName} ${qualityLabel}${closeLabel} (${inversionLabel}) - ${notes}`
    };
  }

  function getChordShape(rootMidi, quality, preferredStep, color) {
    const defaultIntervals = getChordIntervals(quality, preferredStep, color);
    const defaultShape = {
      inversionStep: preferredStep,
      midis: defaultIntervals.map((interval) => rootMidi + interval)
    };

    if (!state.closeVoicingEnabled || !state.closeVoicingReferenceMidis?.length) {
      return defaultShape;
    }

    return getClosestChordShape(rootMidi, quality, preferredStep, color, defaultShape);
  }

  function getClosestChordShape(rootMidi, quality, preferredStep, color, defaultShape) {
    const candidates = [];
    const seen = new Set();

    for (let offset = -4; offset <= 4; offset += 1) {
      const inversionStep = preferredStep + offset;
      const midis = getChordIntervals(quality, inversionStep, color).map((interval) => rootMidi + interval);
      const key = midis.join(",");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ inversionStep, midis });
    }

    return candidates.reduce((best, candidate) => {
      const candidateScore = scoreCloseVoicing(candidate, preferredStep);
      const bestScore = scoreCloseVoicing(best, preferredStep);
      return candidateScore < bestScore ? candidate : best;
    }, defaultShape);
  }

  function scoreCloseVoicing(candidate, preferredStep) {
    const reference = state.closeVoicingReferenceMidis || [];
    const movement = candidate.midis.reduce((total, midi) => {
      const nearest = reference.reduce(
        (best, referenceMidi) => Math.min(best, Math.abs(midi - referenceMidi)),
        Infinity
      );
      return total + nearest;
    }, 0) / Math.max(1, candidate.midis.length);
    const centerDistance = Math.abs(averageMidi(candidate.midis) - averageMidi(reference));
    const spread = getMidiSpread(candidate.midis);
    const rangePenalty = candidate.midis.reduce((total, midi) => {
      if (midi < LOWEST_MIDI) {
        return total + (LOWEST_MIDI - midi) * 100;
      }
      if (midi > HIGHEST_MIDI) {
        return total + (midi - HIGHEST_MIDI) * 100;
      }
      return total;
    }, 0);

    return movement + centerDistance * 1.2 + spread * 0.15 + Math.abs(candidate.inversionStep - preferredStep) * 0.08 + rangePenalty;
  }

  function averageMidi(midis) {
    if (!midis.length) {
      return 0;
    }
    return midis.reduce((total, midi) => total + midi, 0) / midis.length;
  }

  function getMidiSpread(midis) {
    if (midis.length < 2) {
      return 0;
    }
    return Math.max(...midis) - Math.min(...midis);
  }

  function updateCloseVoicingReference(chord) {
    if (!state.closeVoicingEnabled || !chord) {
      return;
    }
    state.closeVoicingReferenceMidis = [...chord.midis];
  }

  function getChordIntervals(quality, inversion, color) {
    const inversionInfo = getInversionInfo(inversion);
    const intervals = CHORD_INTERVALS[quality][inversionInfo.type].map(
      (interval) => interval + inversionInfo.octaveShift * 12
    );
    const hasNinth = Boolean(color.nine);
    const hasSeventh = Boolean(color.seven || color.maj || hasNinth);
    const extensionShift = state.extensionVoicing === "left" ? -12 : 0;

    if (hasSeventh) {
      const seventhInterval = color.maj ? 11 : color.dim ? 9 : 10;
      intervals.push(seventhInterval + extensionShift);
    }
    if (hasNinth) {
      intervals.push(14 + extensionShift);
    }

    if (state.omitExtensionRootEnabled && hasSeventh) {
      for (let index = intervals.length - 1; index >= 0; index -= 1) {
        if (pitchFromInterval(intervals[index]) === 0) {
          intervals.splice(index, 1);
        }
      }
    }

    if (color.raiseRoot) {
      const rootIndex = intervals.findIndex((interval) => pitchFromInterval(interval) === 0);
      if (rootIndex >= 0) {
        intervals[rootIndex] += 1;
      }
    }

    return [...new Set(intervals)].sort((a, b) => a - b);
  }

  function getInversionInfo(inversion) {
    const step = normalizeInversionStep(inversion);
    const normalized = mod(step, 3);

    if (normalized === 0) {
      return {
        octaveShift: step / 3,
        step,
        type: "root"
      };
    }

    if (normalized === 1) {
      return {
        octaveShift: Math.floor(step / 3),
        step,
        type: "right"
      };
    }

    return {
      octaveShift: Math.floor((step + 1) / 3),
      step,
      type: "left"
    };
  }

  function getInversionLabel(inversion) {
    const info = getInversionInfo(inversion);
    const base =
      info.type === "left" ? "donji" : info.type === "right" ? "gornji" : "normalan";
    if (info.octaveShift === 0) {
      return base;
    }
    return `${base} ${info.octaveShift > 0 ? "+" : ""}${info.octaveShift} okt`;
  }

  function normalizeInversionStep(inversion) {
    if (typeof inversion === "number") {
      return inversion;
    }
    return inversionTypeToStep(inversion);
  }

  function inversionTypeToStep(inversion) {
    if (inversion === "left") {
      return -1;
    }
    if (inversion === "right") {
      return 1;
    }
    return 0;
  }

  function getChordQualityLabel(quality, color) {
    const suffix = color.raiseRoot ? " +root" : "";

    if (color.dim) {
      if (color.nine) {
        return `${color.maj ? "dim maj9" : "dim9"}${suffix}`;
      }
      if (color.maj) {
        return `dim maj7${suffix}`;
      }
      return `${color.seven ? "dim7" : "dim"}${suffix}`;
    }

    if (color.sus) {
      if (color.nine) {
        return `${color.maj ? "sus maj9" : "sus9"}${suffix}`;
      }
      if (color.maj) {
        return `sus maj7${suffix}`;
      }
      return `${color.seven ? "sus7" : "sus"}${suffix}`;
    }

    const base = quality === "minor" ? "mol" : "dur";
    if (color.nine) {
      return `${color.maj ? `${base} maj9` : `${base}9`}${suffix}`;
    }
    if (color.maj) {
      return `${base} maj7${suffix}`;
    }
    if (color.seven) {
      return `${base}7${suffix}`;
    }
    return `${base}${suffix}`;
  }

  function getKeyboardInversion(rootKey = null) {
    const heldInversion = getHeldKeyboardInversionStep();

    if (heldInversion !== null) {
      return heldInversion;
    }
    if (rootKey !== null && state.keyboardInversionMemory.has(rootKey)) {
      return state.keyboardInversionMemory.get(rootKey);
    }

    return "root";
  }

  function getHeldKeyboardInversionStep() {
    const rootOrder = maxMapValue(state.keyboardInversions.root);
    const leftOrder = maxMapValue(state.keyboardInversions.left);
    const rightOrder = maxMapValue(state.keyboardInversions.right);
    const maxOrder = Math.max(rootOrder, leftOrder, rightOrder);

    if (!maxOrder) {
      return null;
    }
    if (rootOrder === maxOrder) {
      return 0;
    }
    if (leftOrder === maxOrder) {
      return -1;
    }
    return 1;
  }

  function rememberInversionForActiveChordRoots(inversionStep) {
    getActiveChordRootMemoryKeys().forEach((rootKey) => {
      if (inversionStep === 0) {
        state.keyboardInversionMemory.delete(rootKey);
      } else {
        state.keyboardInversionMemory.set(rootKey, inversionStep);
      }
    });
  }

  function rememberHeldInversionForActiveChordRoots() {
    const inversionStep = getHeldKeyboardInversionStep();
    if (inversionStep !== null) {
      rememberInversionForActiveChordRoots(inversionStep);
    }
  }

  function stepInversionForActiveChordRoots(stepDelta) {
    getActiveChordRootMemoryKeys().forEach((rootKey) => {
      const currentStep = state.keyboardInversionMemory.get(rootKey) || 0;
      rememberInversionForRoot(rootKey, currentStep + stepDelta);
    });
  }

  function rememberInversionForRoot(rootKey, inversionStep) {
    if (inversionStep === 0) {
      state.keyboardInversionMemory.delete(rootKey);
    } else {
      state.keyboardInversionMemory.set(rootKey, inversionStep);
    }
  }

  function isKeyboardLowerOctaveActive(rootKey = null) {
    return (
      state.keyboardLowerOctaves.size > 0 ||
      state.keyboardLowerOctaveLatched ||
      (rootKey !== null && state.keyboardLowerOctaveMemoryKeys.has(rootKey))
    );
  }

  function hasHeldChordRoot() {
    return state.heldBaseKeys.size > 0 || state.heldMouseChordRoots.size > 0;
  }

  function latchLowerOctaveForCurrentChord(code) {
    if (KEYBOARD_LOWER_OCTAVE_LATCH_KEYS.has(code) && hasHeldChordRoot()) {
      state.keyboardLowerOctaveLatched = true;
      rememberLowerOctaveForActiveChordRoots();
    }
  }

  function latchHeldLowerOctaveForCurrentChord() {
    if (!hasHeldChordRoot()) {
      return;
    }

    KEYBOARD_LOWER_OCTAVE_LATCH_KEYS.forEach((code) => {
      if (state.keyboardLowerOctaves.has(code)) {
        state.keyboardLowerOctaveLatched = true;
        rememberLowerOctaveForActiveChordRoots();
      }
    });
  }

  function clearLatchedLowerOctaveIfNoChordRoot() {
    if (!hasHeldChordRoot()) {
      state.keyboardLowerOctaveLatched = false;
    }
  }

  function clearLowerOctaveMemory() {
    state.keyboardLowerOctaveLatched = false;
    const activeRootKeys = getActiveChordRootMemoryKeys();

    if (activeRootKeys.length) {
      activeRootKeys.forEach((rootKey) => state.keyboardLowerOctaveMemoryKeys.delete(rootKey));
    } else {
      state.keyboardLowerOctaveMemoryKeys.clear();
    }

    KEYBOARD_LOWER_OCTAVE_LATCH_KEYS.forEach((code) => {
      state.keyboardLowerOctaves.delete(code);
    });
  }

  function rememberLowerOctaveForActiveChordRoots() {
    getActiveChordRootMemoryKeys().forEach((rootKey) => {
      state.keyboardLowerOctaveMemoryKeys.add(rootKey);
    });
  }

  function getActiveChordRootMemoryKeys() {
    const keys = [];

    if (state.heldBaseKeys.size) {
      const activeBase = maxByOrder([...state.heldBaseKeys.values()]);
      keys.push(getKeyboardRootMemoryKey(activeBase.pitch));
    }

    if (state.heldMouseChordRoots.size) {
      const activeRoot = maxByOrder([...state.heldMouseChordRoots.values()]);
      keys.push(getRootMemoryKeyFromMidi(activeRoot.midi));
    }

    return [...new Set(keys)];
  }

  function getKeyboardRootMemoryKey(pitch) {
    return getRootMemoryKeyFromMidi(noteToMidi(pitch, state.baseOctave) + getKeyboardPitchOffset());
  }

  function getRootMemoryKeyFromMidi(midi) {
    return pitchFromMidi(midi);
  }

  function latchChordColorForCurrentChord(chordColor) {
    if (KEYBOARD_CHORD_COLOR_LATCHES.has(chordColor) && hasHeldChordRoot()) {
      state.keyboardChordColorLatched[chordColor] = true;
    }
  }

  function latchHeldChordColorsForCurrentChord() {
    if (!hasHeldChordRoot()) {
      return;
    }

    KEYBOARD_CHORD_COLOR_LATCHES.forEach((chordColor) => {
      if (state.keyboardChordColors[chordColor]?.size > 0) {
        state.keyboardChordColorLatched[chordColor] = true;
      }
    });
  }

  function clearLatchedChordColorsIfNoChordRoot() {
    if (hasHeldChordRoot()) {
      return;
    }

    KEYBOARD_CHORD_COLOR_LATCHES.forEach((chordColor) => {
      state.keyboardChordColorLatched[chordColor] = false;
    });
  }

  function getKeyboardPitchOffset() {
    const upOrder = maxMapValue(state.keyboardPitchOffsets.up);
    const downOrder = maxMapValue(state.keyboardPitchOffsets.down);

    if (upOrder && downOrder) {
      return upOrder > downOrder ? 1 : -1;
    }
    if (upOrder) {
      return 1;
    }
    if (downOrder) {
      return -1;
    }
    return 0;
  }

  function holdKeyboardChordBriefly(chord) {
    clearKeyboardReleaseGuard();
    state.keyboardFrozenChord = chord;
    state.keyboardReleaseGuardTimer = window.setTimeout(() => {
      state.keyboardFrozenChord = null;
      state.keyboardReleaseGuardTimer = null;
      if (state.heldBaseKeys.size) {
        recomputeSound();
      }
    }, RELEASE_GUARD_MS);
  }

  function clearKeyboardReleaseGuard() {
    if (state.keyboardReleaseGuardTimer) {
      window.clearTimeout(state.keyboardReleaseGuardTimer);
      state.keyboardReleaseGuardTimer = null;
    }
    state.keyboardFrozenChord = null;
  }

  function clearKeyboardChordSettleTimer() {
    if (state.keyboardChordSettleTimer) {
      window.clearTimeout(state.keyboardChordSettleTimer);
      state.keyboardChordSettleTimer = null;
    }
  }

  function getMobileInversion() {
    const leftOrder = maxMapValue(state.mobileArrowPointers.left);
    const rightOrder = maxMapValue(state.mobileArrowPointers.right);

    if (leftOrder && rightOrder) {
      return leftOrder > rightOrder ? "left" : "right";
    }
    if (leftOrder) {
      return "left";
    }
    if (rightOrder) {
      return "right";
    }
    return "root";
  }

  function setActiveMidiSet(desired, restartMidis = new Set()) {
    const sustainMissingNotes = shouldSustainMissingNotes();

    state.activeMidiSet.forEach((midi) => {
      if (!desired.has(midi)) {
        if (sustainMissingNotes) {
          state.sustainedMidiSet.add(midi);
          scheduleSustainRelease(midi);
        } else {
          stopNote(midi);
          state.sustainedMidiSet.delete(midi);
          clearSustainTimer(midi);
          clearInfiniteSustainLoop(midi);
        }
      }
    });

    restartMidis.forEach((midi) => {
      if (desired.has(midi) && state.activeNotes.has(midi)) {
        stopNote(midi);
        state.activeMidiSet.delete(midi);
        state.sustainedMidiSet.delete(midi);
        clearSustainTimer(midi);
        clearInfiniteSustainLoop(midi);
      }
    });

    desired.forEach((midi) => {
      if (state.sustainedMidiSet.has(midi)) {
        stopNote(midi);
        state.sustainedMidiSet.delete(midi);
        clearSustainTimer(midi);
        clearInfiniteSustainLoop(midi);
      }
      if (!state.activeNotes.has(midi)) {
        startNote(midi);
      }
    });

    state.activeMidiSet = desired;
  }

  function shouldSustainMissingNotes() {
    if (!state.sustainEnabled) {
      return false;
    }

    return (
      state.heldBaseKeys.size === 0 &&
      state.heldKeyboardTones.size === 0 &&
      state.heldPointerTones.size === 0 &&
      state.heldMouseChordRoots.size === 0 &&
      state.heldMobileChordRoots.size === 0 &&
      state.mobileMinorPointers.size === 0 &&
      state.mobileArrowPointers.left.size === 0 &&
      state.mobileArrowPointers.right.size === 0
    );
  }

  function releaseSustainedNotes() {
    state.sustainedMidiSet.forEach((midi) => {
      if (!state.activeMidiSet.has(midi)) {
        stopNote(midi);
      }
      clearSustainTimer(midi);
      clearInfiniteSustainLoop(midi);
    });
    state.sustainedMidiSet.clear();
  }

  function rescheduleSustainedNotes() {
    state.sustainedMidiSet.forEach((midi) => {
      scheduleSustainRelease(midi);
    });
  }

  function stopAllSoundingNotes() {
    [...state.activeNotes.keys()].forEach((midi) => stopNote(midi));
    state.activeMidiSet.clear();
    state.sustainedMidiSet.clear();
    state.sustainTimers.forEach((timerId) => window.clearTimeout(timerId));
    state.sustainTimers.clear();
    state.sustainLoopTimers.forEach((timerId) => window.clearTimeout(timerId));
    state.sustainLoopTimers.clear();
  }

  function scheduleSustainRelease(midi) {
    clearSustainTimer(midi);
    if (!Number.isFinite(state.sustainLength)) {
      scheduleInfiniteSustainLoop(midi);
      return;
    }
    clearInfiniteSustainLoop(midi);
    const timerId = window.setTimeout(() => {
      state.sustainTimers.delete(midi);
      state.sustainedMidiSet.delete(midi);
      clearInfiniteSustainLoop(midi);
      if (!state.activeMidiSet.has(midi)) {
        stopNote(midi);
      }
    }, state.sustainLength * 1000);
    state.sustainTimers.set(midi, timerId);
  }

  function clearSustainTimer(midi) {
    const timerId = state.sustainTimers.get(midi);
    if (timerId) {
      window.clearTimeout(timerId);
      state.sustainTimers.delete(midi);
    }
  }

  function scheduleInfiniteSustainLoop(midi) {
    clearInfiniteSustainLoop(midi);
    const intervalMs = state.instrument === "grand-piano" ? 1800 : 6000;
    const timerId = window.setInterval(() => {
      if (
        !state.sustainedMidiSet.has(midi) ||
        state.activeMidiSet.has(midi) ||
        shouldBlockSustainLoop()
      ) {
        return;
      }

      if (state.activeNotes.has(midi)) {
        stopNote(midi);
      }
      startNote(midi);
    }, intervalMs);
    state.sustainLoopTimers.set(midi, timerId);
  }

  function clearInfiniteSustainLoop(midi) {
    const timerId = state.sustainLoopTimers.get(midi);
    if (timerId) {
      window.clearInterval(timerId);
      state.sustainLoopTimers.delete(midi);
    }
  }

  function shouldBlockSustainLoop() {
    return (
      state.heldBaseKeys.size > 0 ||
      state.heldKeyboardTones.size > 0 ||
      state.heldPointerTones.size > 0 ||
      state.heldMouseChordRoots.size > 0 ||
      state.heldMobileChordRoots.size > 0
    );
  }

  function ensureAudio(options = {}) {
    const shouldResume = options.resume !== false;

    if (!state.audioContext) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        activeChordDisplay.value = "Web Audio nije podrzan";
        return null;
      }

      state.audioContext = new AudioContext();
      state.masterGain = state.audioContext.createGain();
      state.masterCompressor = state.audioContext.createDynamicsCompressor();
      state.masterGain.gain.value = state.volume;
      state.masterCompressor.threshold.value = -18;
      state.masterCompressor.knee.value = 22;
      state.masterCompressor.ratio.value = 3.2;
      state.masterCompressor.attack.value = 0.004;
      state.masterCompressor.release.value = 0.18;
      state.masterGain.connect(state.masterCompressor);
      state.masterCompressor.connect(state.audioContext.destination);
    }

    if (!state.sampleLoadingPromise && !state.samplesFailed) {
      loadPianoSamples();
    }

    if (shouldResume && state.audioContext.state === "suspended") {
      state.audioContext.resume();
    }

    return state.audioContext;
  }

  function loadPianoSamples() {
    const ctx = state.audioContext;
    if (!ctx || state.sampleLoadingPromise) {
      return state.sampleLoadingPromise;
    }

    state.sampleLoadingPromise = Promise.all(
      PIANO_SAMPLES.map(async (sample) => {
        const url = getPianoSampleUrl(sample);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Sample nije ucitan: ${sample.file}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        state.sampleBuffers.set(sample.midi, audioBuffer);
      })
    )
      .then(() => {
        state.samplesReady = true;
        restartFallbackNotesWithSamples();
      })
      .catch(() => {
        state.samplesFailed = true;
      });

    return state.sampleLoadingPromise;
  }

  function startNote(midi) {
    const ctx = ensureAudio();
    if (!ctx || state.activeNotes.has(midi)) {
      return;
    }

    if (state.instrument === "grand-piano") {
      const sample = findNearestSample(midi);
      const buffer = sample ? state.sampleBuffers.get(sample.midi) : null;
      if (ctx && buffer) {
        startSampleNote(ctx, midi, sample.midi, buffer);
        return;
      }

      if (sample && shouldUseMediaPianoSamples()) {
        startMediaSampleNote(ctx, midi, sample);
        return;
      }

      if (ctx) {
        startFallbackNote(ctx, midi);
      }
      return;
    }

    if (ctx) {
      startPresetNote(ctx, midi, state.instrument);
    }
  }

  function startSampleNote(ctx, midi, sampleMidi, buffer) {
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const playbackRate = 2 ** ((midi - sampleMidi) / 12);

    source.buffer = buffer;
    source.playbackRate.setValueAtTime(playbackRate, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.92, now + 0.008);

    source.connect(gain);
    gain.connect(state.masterGain);
    source.start(now);

    state.activeNotes.set(midi, {
      kind: "sample",
      source,
      gain
    });
  }

  function startMediaSampleNote(ctx, midi, sample) {
    const audio = new Audio(getPianoSampleUrl(sample));
    const note = {
      kind: "media-sample",
      audio,
      fadeTimer: null
    };

    const useFallback = () => {
      if (state.activeNotes.get(midi) !== note) {
        return;
      }
      state.activeNotes.delete(midi);
      if (ctx && state.instrument === "grand-piano") {
        startFallbackNote(ctx, midi);
      }
    };

    audio.preload = "auto";
    disableMediaPitchCorrection(audio);
    audio.playbackRate = 2 ** ((midi - sample.midi) / 12);
    audio.volume = mediaSampleVolume();
    audio.addEventListener("error", useFallback, { once: true });
    state.activeNotes.set(midi, note);

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(useFallback);
    }
  }

  function getPianoSampleUrl(sample) {
    return `${PIANO_SAMPLE_BASE_PATH}${encodeURIComponent(sample.file)}`;
  }

  function disableMediaPitchCorrection(audio) {
    audio.preservesPitch = false;
    audio.mozPreservesPitch = false;
    audio.webkitPreservesPitch = false;
  }

  function shouldUseMediaPianoSamples() {
    return window.location.protocol === "file:" || state.samplesFailed;
  }

  function mediaSampleVolume() {
    return clamp(state.volume * 0.92, 0, 1);
  }

  function updateMediaSampleVolumes() {
    const volume = mediaSampleVolume();
    state.activeNotes.forEach((note) => {
      if (note.kind === "media-sample") {
        note.audio.volume = volume;
      }
    });
  }

  function startFallbackNote(ctx, midi) {
    const now = ctx.currentTime;
    const frequency = frequencyFromMidi(midi);
    const output = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const decayScale = clamp(1.15 - frequency / 5200, 0.46, 1.15);

    output.gain.value = 0.95;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(clamp(frequency * 9, 1700, 8200), now);
    filter.Q.setValueAtTime(0.55, now);
    filter.connect(output);
    output.connect(state.masterGain);

    const partials = SYNTH_FALLBACK_PARTIALS.map((partial) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const attackEnd = now + partial.attack;
      const decayEnd = now + partial.decay * decayScale;

      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(frequency * partial.multiple, now);
      oscillator.detune.setValueAtTime(partial.detune, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(partial.level, attackEnd);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, partial.level * partial.sustain), decayEnd);
      gain.gain.setTargetAtTime(0.0001, decayEnd, partial.tail * decayScale);

      oscillator.connect(gain);
      gain.connect(filter);
      oscillator.start(now);

      return { oscillator, gain };
    });

    addHammerNoise(ctx, now, frequency, output);

    state.activeNotes.set(midi, {
      kind: "fallback",
      partials,
      output,
      filter,
      release: 0.18
    });
  }

  function startPresetNote(ctx, midi, presetName) {
    const preset = INSTRUMENT_PRESETS[presetName] || INSTRUMENT_PRESETS["warm-synth"];
    const env = preset.envelope;
    const now = ctx.currentTime;
    const frequency = frequencyFromMidi(midi);
    const output = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    output.gain.value = 0.9;
    filter.type = preset.filter.type;
    filter.frequency.setValueAtTime(
      clamp(frequency * preset.filter.frequencyMult, preset.filter.min, preset.filter.max),
      now
    );
    filter.Q.setValueAtTime(preset.filter.q, now);
    filter.connect(output);
    output.connect(state.masterGain);

    let lfo = null;
    let lfoGain = null;
    if (preset.vibrato && preset.vibrato.depth > 0) {
      lfo = ctx.createOscillator();
      lfoGain = ctx.createGain();
      lfo.frequency.setValueAtTime(preset.vibrato.rate, now);
      lfoGain.gain.setValueAtTime(preset.vibrato.depth, now);
      lfo.connect(lfoGain);
      lfo.start(now);
    }

    const partials = preset.partials.map((partial) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const attackEnd = now + env.attack;
      const decayEnd = attackEnd + env.decay;

      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(frequency * partial.multiple, now);
      oscillator.detune.setValueAtTime(partial.detune || 0, now);

      if (lfoGain) {
        lfoGain.connect(oscillator.detune);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, partial.level), attackEnd);
      gain.gain.setTargetAtTime(Math.max(0.0001, partial.level * env.sustain), decayEnd, Math.max(0.015, env.decay));

      oscillator.connect(gain);
      gain.connect(filter);
      oscillator.start(now);

      return { oscillator, gain };
    });

    state.activeNotes.set(midi, {
      kind: "preset",
      partials,
      output,
      filter,
      lfo,
      lfoGain,
      release: env.release
    });
  }

  function stopNote(midi) {
    const note = state.activeNotes.get(midi);
    if (!note) {
      return;
    }

    if (note.kind === "media-sample") {
      fadeOutMediaSample(note);
      state.activeNotes.delete(midi);
      return;
    }

    if (!state.audioContext) {
      return;
    }

    const now = state.audioContext.currentTime;
    if (note.kind === "sample") {
      note.gain.gain.cancelScheduledValues(now);
      note.gain.gain.setTargetAtTime(0.0001, now, 0.045);
      try {
        note.source.stop(now + 0.22);
      } catch {
        // A BufferSource can only be stopped once.
      }
      window.setTimeout(() => {
        note.source.disconnect();
        note.gain.disconnect();
      }, 280);
    } else {
      const release = note.release || 0.18;
      note.partials.forEach(({ oscillator, gain }) => {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0.0001, now, Math.max(0.025, release / 3));
        oscillator.stop(now + release + 0.08);
      });
      if (note.lfo) {
        note.lfo.stop(now + release + 0.08);
      }
      window.setTimeout(() => {
        note.output.disconnect();
        note.filter.disconnect();
        if (note.lfo) {
          note.lfo.disconnect();
        }
        if (note.lfoGain) {
          note.lfoGain.disconnect();
        }
      }, Math.max(220, (release + 0.14) * 1000));
    }
    state.activeNotes.delete(midi);
  }

  function fadeOutMediaSample(note) {
    if (note.fadeTimer) {
      window.clearInterval(note.fadeTimer);
    }

    const audio = note.audio;
    const startVolume = audio.volume || 0;
    const startedAt = performance.now();
    const fadeMs = 180;
    note.fadeTimer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startedAt) / fadeMs);
      audio.volume = startVolume * (1 - progress);
      if (progress >= 1) {
        window.clearInterval(note.fadeTimer);
        audio.pause();
        audio.currentTime = 0;
      }
    }, 16);
  }

  function restartFallbackNotesWithSamples() {
    const fallbackMidis = [];
    state.activeNotes.forEach((note, midi) => {
      if (note.kind === "fallback" && state.activeMidiSet.has(midi)) {
        fallbackMidis.push(midi);
      }
    });

    fallbackMidis.forEach((midi) => {
      stopNote(midi);
      startNote(midi);
    });
  }

  function findNearestSample(midi) {
    let nearest = PIANO_SAMPLES[0];
    let nearestDistance = Math.abs(midi - nearest.midi);

    for (const sample of PIANO_SAMPLES) {
      const distance = Math.abs(midi - sample.midi);
      if (distance < nearestDistance) {
        nearest = sample;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  function addHammerNoise(ctx, now, frequency, destination) {
    const duration = 0.028;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let index = 0; index < length; index += 1) {
      const fade = 1 - index / length;
      data[index] = (Math.random() * 2 - 1) * fade * fade;
    }

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const bandpass = ctx.createBiquadFilter();

    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(clamp(frequency * 5, 1500, 6200), now);
    bandpass.Q.setValueAtTime(0.8, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.018, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.buffer = buffer;
    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(destination);
    source.start(now);
    source.stop(now + duration + 0.006);
  }

  function updateHighlightedKeys() {
    state.keyElementsByMidi.forEach((element, midi) => {
      element.classList.toggle("is-active", state.activeMidiSet.has(midi));
    });
  }

  function updateOctaveControls() {
    octaveDisplay.value = `Oktava: ${state.baseOctave}`;
    octaveDown.disabled = state.baseOctave <= MIN_OCTAVE;
    octaveUp.disabled = state.baseOctave >= MAX_OCTAVE;
  }

  function changeOctave(direction) {
    const next = clamp(state.baseOctave + direction, MIN_OCTAVE, MAX_OCTAVE);
    if (next === state.baseOctave) {
      return;
    }

    state.baseOctave = next;
    state.closeVoicingReferenceMidis = null;
    updateOctaveControls();
    window.dispatchEvent(new CustomEvent("fgr:octavechange", {
      detail: { octave: state.baseOctave }
    }));
    scrollToBaseOctave(true);
    recomputeSound();
  }

  function scrollToBaseOctave(smooth) {
    const targetMidi = noteToMidi(0, Math.max(MIN_OCTAVE, state.baseOctave - 1));
    const targetKey = state.keyElementsByMidi.get(targetMidi);

    if (!targetKey) {
      return;
    }

    const left = Math.max(0, targetKey.offsetLeft - 12);
    pianoScroll.scrollTo({
      left,
      behavior: smooth ? "smooth" : "auto"
    });
  }

  function updateLabelVisibility() {
    app.classList.toggle("hide-labels", !state.labelsVisible);
  }

  function updateSustainLengthDisplay() {
    sustainLengthDisplay.value = Number.isFinite(state.sustainLength)
      ? `${state.sustainLength.toFixed(1)}s`
      : "âˆž";
  }

  function normalizeSustainLength(value) {
    return value >= 8.1 ? Infinity : value;
  }

  function updateMobileModifierState() {
    const chordMode = state.mobileMode === "chord";

    mobileModifierButtons.forEach((button) => {
      const modifier = button.dataset.mobileModifier;
      button.disabled = !chordMode;

      let held = false;
      if (modifier === "minor") {
        held = state.mobileMinorPointers.size > 0;
      } else if (modifier === "left" || modifier === "right") {
        held = state.mobileArrowPointers[modifier].size > 0;
      }
      button.classList.toggle("is-held", held);
    });
  }

  function clearMobileGestureState() {
    state.heldMobileChordRoots.clear();
    state.mobileMinorPointers.clear();
    state.mobileArrowPointers.left.clear();
    state.mobileArrowPointers.right.clear();
  }

  function clearAllHeldState() {
    state.heldBaseKeys.clear();
    clearPendingBaseKeyTaps();
    state.lastBaseKeyTap = { code: "", time: 0 };
    state.heldKeyboardTones.clear();
    state.heldMouseChordRoots.clear();
    clearKeyboardReleaseGuard();
    clearKeyboardChordSettleTimer();
    state.retriggerChordRequested = false;
    state.keyboardMinorKeys.clear();
    state.keyboardInversions.root.clear();
    state.keyboardInversions.left.clear();
    state.keyboardInversions.right.clear();
    state.keyboardLowerOctaves.clear();
    state.keyboardLowerOctaveLatched = false;
    state.keyboardPitchOffsets.up.clear();
    state.keyboardPitchOffsets.down.clear();
    state.keyboardChordColorLatched.seven = false;
    state.keyboardChordColorLatched.nine = false;
    state.keyboardChordColors.seven.clear();
    state.keyboardChordColors.nine.clear();
    state.keyboardChordColors.maj.clear();
    state.keyboardChordColors.sus.clear();
    state.keyboardChordColors.dim.clear();
    state.keyboardVoiceModifiers.raiseRoot.clear();
    state.heldPointerTones.clear();
    clearMobileGestureState();
    updateMobileModifierState();
    stopAllSoundingNotes();
    recomputeSound();
  }

  function resetChordMemory() {
    state.keyboardLowerOctaveMemoryKeys.clear();
    state.keyboardInversionMemory.clear();
    state.keyboardLowerOctaveLatched = false;
    state.closeVoicingReferenceMidis = null;
    clearKeyboardReleaseGuard();
    clearKeyboardChordSettleTimer();
    requestChordRetrigger();
    recomputeSound();
  }

  function focusAppSoon() {
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }

  function shouldFocusAppFromPointer(event) {
    const target = event.target;
    return !target.closest("select, option, input, button, label");
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("service-worker.js").catch(() => {});
      });
    }
  }

  function noteToMidi(pitch, octave) {
    return (octave + 1) * 12 + pitch;
  }

  function pitchFromMidi(midi) {
    return ((midi % 12) + 12) % 12;
  }

  function mod(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function pitchFromInterval(interval) {
    return ((interval % 12) + 12) % 12;
  }

  function octaveFromMidi(midi) {
    return Math.floor(midi / 12) - 1;
  }

  function noteLabel(midi) {
    return `${NOTE_NAMES[pitchFromMidi(midi)]}${octaveFromMidi(midi)}`;
  }

  function frequencyFromMidi(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  function maxByOrder(items) {
    return items.reduce((best, item) => (item.order > best.order ? item : best), items[0]);
  }

  function maxMapValue(map) {
    let max = 0;
    map.forEach((value) => {
      if (value > max) {
        max = value;
      }
    });
    return max;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
