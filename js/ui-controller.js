import { 
  state, 
  NOTE_NAMES, 
  WHITE_PITCHES, 
  readJsonStorage, 
  writeJsonStorage, 
  PLAYER_SETTINGS_STORAGE_KEY,
  REPERTOIRE_STORAGE_KEY,
  KEYBOARD_SETTINGS_STORAGE_KEY,
  clamp
} from "./state.js";

import { 
  ensureAudio, 
  startNote, 
  stopNote, 
  stopAllSoundingNotes, 
  updateMediaSampleVolumes, 
  recomputeSound,
  rec,
  recLoad,
  recPlayFrom,
  recStop,
  recTime,
  recSeek,
  recRetune,
  invalidateRecLoad,
  updateMixerGains,
  extractFallbackNoteTracks,
  assistedMidiFromEvent,
  analyzeBuffer,
  setAssistedMidiSet,
  clearAssistedNotes,
  scheduleAssistedNote,
  dbGet,
  dbPut,
  dbGetAll,
  dbDelete,
  recId,
  noteToMidi,
  pitchFromMidi,
  octaveFromMidi
} from "./audio.js?v=174";

import {
  beginProcessingRun,
  createProcessingClient,
  createYouTubeCaptureMetadata,
  getActiveNoteEvents,
  getNoteEventsStartingBetween,
  normalizeNoteTracks,
  reusableProcessingSource
} from "./processing-client.js?v=174";
import {
  chordChartFingerprint,
  findActiveChordIndex
} from "./chord-analysis.js?v=174";
import {
  computeTimelineFollowScroll,
  resolveChordInsertionTime,
  timelineTickSeconds
} from "./practice-timing.js?v=174";
import {
  applyVisualPreferences,
  DEFAULT_DARK_ACCENT,
  DEFAULT_HARMONY_COLOR,
  DEFAULT_MELODY_COLOR,
  normalizePianoDockHeight,
  normalizeHexColor,
  patchUiPreferences,
  readUiPreferences
} from "./preferences.js?v=174";
import { extractEmbeddedArtwork, parseImportedAudioFilename } from "./mp3-metadata.js?v=174";
import { buildWaveformPath, createWaveformPath } from "./waveform.js?v=174";
import { createPcmWavFile } from "./pcm-wav.js?v=174";
import { buildAnalysisProgressView, isProcessingActive, mergeProcessingProgress } from "./analysis-progress.js?v=174";
import { resolveMixerControls } from "./mixer-routing.js?v=174";
import { applyGridOverride, isDownbeatIndex, normalizeBeatGrid } from "./beat-grid.js?v=174";
import { createScorePlayer } from "./score-player.js?v=174";
import {
  deleteLocalPlaylist,
  fetchLocalPlaylists,
  loadLocalPlaylist,
  playlistSlug,
  saveLocalPlaylist
} from "./playlists.js?v=174";
import { renderHarmonyEvents } from "./voicing.js?v=174";
import {
  AUDIO_IMPORT_ACCEPT,
  importedAudioBadge,
  validateImportedAudioFile
} from "./audio-import.js?v=174";
import {
  createPcmTabRecorder,
  audioBufferSignalStats
} from "./pcm-capture.js?v=174";

import { 
  handleKeyDown, 
  handleKeyUp, 
  handleMobileModifierDown, 
  handleMobileModifierUp, 
  clearAllHeldState, 
  resetChordMemory,
  isMinorModifierActive,
  isKeyboardLowerOctaveActive
} from "./keyboard.js";

import { connectMidi, detectMidiChord, midiHeld } from "./midi.js";

import { 
  slugifyPlaylistName, 
  buildRepertoireFileData, 
  normalizeRepertoireFileData,
  getGitHubToken
} from "./github.js";

import { 
  fmtTime,
  fmtChordTime,
  parseKey, 
  formatKey, 
  renderTool, 
  selectTool, 
  clearScale, 
  renderHint, 
  paintChordName, 
  initMetronome,
  shownKey,
  transposeChordName,
  parseChordName,
  getActiveHint,
  openTimelineChordPicker
} from "./ui-tools.js?v=174";
import { chordSegmentGeometry, editChordSegment, resolveChordEndTime, upsertChordAtTime } from "./chord-editor.js?v=174";
import { computeMelodyFingering } from "./melody-fingering.js?v=174";
import { detectMelodyPhrases, phraseIndexAtTime } from "./melody-phrases.js?v=174";

// Cache DOM Elements
const $ = (id) => document.getElementById(id);

let app, keyboard, pianoScroll, midiBadge, volumeControl, octaveDown, octaveUp, octaveDisplay, labelsToggle;
let instrumentSelect, sustainToggle, sustainLengthControl, sustainLengthDisplay, pianoKeyboardToggle;
let omitExtensionRootToggle, closeVoicingToggle, retriggerChordToggle, resetMemoryButton;
let manualInversionDown, manualInversionUp, manualInversionDisplay;
let doubleTapSharpControl, doubleTapSharpDisplay, activeChordDisplay, selectedSongTitle;
let selectedSongKeyDisplay, youtubeStatus, youtubePlayPause, youtubeRewind, youtubeForward, youtubeSeekSeconds;
let playlistStart, playlistWorkspace, startLoadPlaylistButton, startNewPlaylistButton;
let loadPlaylistButton, newPlaylistButton, playlistDialog, playlistDialogTitle, playlistDialogClose, playlistBrowser;
let songTitleInput, songKeyInput, songUrlInput, addSongButton, songSearchInput, songSearchButton;
let mobileModifierButtons;
let recSeeker, recSpeedSelect, sideTransDown, sideTransUp, sideTransVal;
let showFingeringToggle, trackMelodyToggle, melodySourceSelect;
let showBeatGridToggle, beatGridInfo;
let pianoHeightControl, pianoHeightDisplay, metronomePanelToggle;
let abA = null, abB = null, abTimer = null;
let activePhraseLoop = null;
// Vežbanje melodije ton-po-ton: cilj, poslednje pritisnute dirke i vizuali.
let melodyPractice = null;
let melodyPracticeLastPressed = new Set();
let melodyPracticeVisualMidis = new Set();
// Najava sledećih tonova tokom praćenja melodije.
let lastUpcomingMidis = new Set();
let selectedSongFile = null;
let songSourceMode = "youtube";
let processingClient = null;
const processingTasks = new Map();
const processingPolls = new Map();
const noteTrackTasks = new Map();
const noteTrackGenerations = new Map();
let resolvedNoteTrackSongId = "";
let resolvedNoteTracks = { melody: [], bass: [] };
let resolvedNoteTrackOffsets = { melody: 0, bass: 0 };
// Prstored po eventu, keširan po referenci niza eventova i transpoziciji.
let noteFingeringCache = { melody: null, bass: null };
let songChangeListenerReady = false;
let lastSongChangeSelectionKey = null;
let heroWaveformGeneration = 0;
const heroWaveformPathCache = new WeakMap();
const heroWaveformSongPathCache = new Map();
const heroWaveformBufferTaskCache = new Map();
const RETRY_ANALYSIS_FIELDS = Object.freeze([
  "stems",
  "availableStems",
  "assets",
  "noteTracks",
  "chords",
  "chordProvenance",
  "chordSourceSha256",
  "chordTimingOffsetSeconds",
  "chordTimeBase",
  "chordEndTime",
  "chordPatchDirty",
  "chordPatchError",
  "serviceChordRevision",
  "serviceJobId",
  "chordChartRevision"
]);
let pendingRemoteSeek = null;
const REMOTE_SEEK_PREVIEW_TTL_MS = 3000;
let hybridSourceSwitchGeneration = 0;
let hybridSourceSwitchPending = false;

// New elements for context menu, selection mode, and edit dialog
let songContextMenu, ctxSelectSong, ctxRenameSong, ctxEditSong;
let songSelectionActions, deleteSelectedSongsButton, cancelSelectionButton;
let editSongDialog, editSongDialogTitle, editSongDialogClose, editSongForm, editSongTitleInput, editSongKeyInput, editSongUrlInput, editSongCancelButton, editSongSaveButton;
let addChordDialog, addChordDialogClose, addChordDialogBackdrop, addChordForm, addChordNameInput, addChordTimeOutput, addChordCancelButton;
let pendingChordInsertion = null;
let addChordDialogReturnFocus = null;

function cloneAnalysisSnapshotValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof globalThis.structuredClone === "function") {
    try { return globalThis.structuredClone(value); } catch (_error) {}
  }
  return JSON.parse(JSON.stringify(value));
}

function snapshotSongAnalysis(song) {
  const snapshot = {};
  RETRY_ANALYSIS_FIELDS.forEach((field) => {
    snapshot[field] = {
      present: Object.prototype.hasOwnProperty.call(song, field),
      value: cloneAnalysisSnapshotValue(song[field])
    };
  });
  return snapshot;
}

function restoreSongAnalysis(song, snapshot) {
  RETRY_ANALYSIS_FIELDS.forEach((field) => {
    const entry = snapshot?.[field];
    if (entry?.present) song[field] = cloneAnalysisSnapshotValue(entry.value);
    else delete song[field];
  });
}

function invalidateHeroWaveformCache(songOrId) {
  const songId = String(typeof songOrId === "object" ? songOrId?.id : songOrId || "");
  if (!songId) return;
  const prefix = `${songId}::`;
  for (const key of heroWaveformSongPathCache.keys()) {
    if (String(key).startsWith(prefix)) heroWaveformSongPathCache.delete(key);
  }
  for (const key of heroWaveformBufferTaskCache.keys()) {
    if (String(key).startsWith(prefix)) heroWaveformBufferTaskCache.delete(key);
  }
  heroWaveformGeneration += 1;
}

function cacheDom() {
  app = $("app");
  keyboard = $("keyboard");
  pianoScroll = $("pianoScroll");
  midiBadge = $("midiBadge");
  volumeControl = $("volumeControl");
  octaveDown = $("octaveDown");
  octaveUp = $("octaveUp");
  octaveDisplay = $("octaveDisplay");
  labelsToggle = $("labelsToggle");
  instrumentSelect = $("instrumentSelect");
  sustainToggle = $("sustainToggle");
  sustainLengthControl = $("sustainLengthControl");
  sustainLengthDisplay = $("sustainLengthDisplay");
  pianoKeyboardToggle = $("pianoKeyboardToggle");
  omitExtensionRootToggle = $("omitExtensionRootToggle");
  closeVoicingToggle = $("closeVoicingToggle");
  retriggerChordToggle = $("retriggerChordToggle");
  resetMemoryButton = $("resetMemoryButton");
  manualInversionDown = $("manualInversionDown");
  manualInversionUp = $("manualInversionUp");
  manualInversionDisplay = $("manualInversionDisplay");
  doubleTapSharpControl = $("doubleTapSharpControl");
  doubleTapSharpDisplay = $("doubleTapSharpDisplay");
  activeChordDisplay = $("activeChordDisplay");
  selectedSongTitle = $("selectedSongTitle");
  selectedSongKeyDisplay = $("selectedSongKeyDisplay");
  youtubeStatus = $("youtubeStatus");
  youtubePlayPause = $("youtubePlayPause");
  youtubeRewind = $("youtubeRewind");
  youtubeForward = $("youtubeForward");
  youtubeSeekSeconds = $("youtubeSeekSeconds");
  playlistStart = $("playlistStart");
  playlistWorkspace = $("playlistWorkspace");
  startLoadPlaylistButton = $("startLoadPlaylistButton");
  startNewPlaylistButton = $("startNewPlaylistButton");
  loadPlaylistButton = $("loadPlaylistButton");
  newPlaylistButton = $("newPlaylistButton");
  playlistDialog = $("playlistDialog");
  playlistDialogTitle = $("playlistDialogTitle");
  playlistDialogClose = $("playlistDialogClose");
  playlistBrowser = $("playlistBrowser");
  songTitleInput = $("songTitleInput");
  songKeyInput = $("songKeyInput");
  songUrlInput = $("songUrlInput");
  addSongButton = $("addSongButton");
  songSearchInput = $("songSearchInput");
  songSearchButton = $("songSearchButton");
  mobileModifierButtons = [...document.querySelectorAll("[data-mobile-modifier]")];
  recSeeker = $("recSeeker");
  recSpeedSelect = $("recSpeedSelect");
  sideTransDown = $("sideTransDown");
  sideTransUp = $("sideTransUp");
  sideTransVal = $("sideTransVal");
  showFingeringToggle = $("showFingeringToggle");
  showBeatGridToggle = $("showBeatGridToggle");
  beatGridInfo = $("beatGridInfo");
  trackMelodyToggle = $("trackMelodyToggle");
  melodySourceSelect = $("melodySourceSelect");
  pianoHeightControl = $("pianoHeightControl");
  pianoHeightDisplay = $("pianoHeightDisplay");
  metronomePanelToggle = $("metronomePanelToggle");

  songContextMenu = $("songContextMenu");
  ctxSelectSong = $("ctxSelectSong");
  ctxRenameSong = $("ctxRenameSong");
  ctxEditSong = $("ctxEditSong");

  songSelectionActions = $("songSelectionActions");
  deleteSelectedSongsButton = $("deleteSelectedSongsButton");
  cancelSelectionButton = $("cancelSelectionButton");

  editSongDialog = $("editSongDialog");
  editSongDialogTitle = $("editSongDialogTitle");
  editSongDialogClose = $("editSongDialogClose");
  editSongForm = $("editSongForm");
  editSongTitleInput = $("editSongTitleInput");
  editSongKeyInput = $("editSongKeyInput");
  editSongUrlInput = $("editSongUrlInput");
  editSongCancelButton = $("editSongCancelButton");
  editSongSaveButton = $("editSongSaveButton");
  addChordDialog = $("addChordDialog");
  addChordDialogClose = $("addChordDialogClose");
  addChordDialogBackdrop = $("addChordDialogBackdrop");
  addChordForm = $("addChordForm");
  addChordNameInput = $("addChordNameInput");
  addChordTimeOutput = $("addChordTimeOutput");
  addChordCancelButton = $("addChordCancelButton");
}

// Build the studio workbench from the existing functional controls. Keeping the
// original IDs means the audio, MIDI and processing code can continue to own the
// same elements while the visual hierarchy matches the agreed desktop design.
function prepareWorkbenchLayout() {
  const shell = $("app");
  if (!shell || shell.classList.contains("workbench-v2")) return;
  shell.classList.add("workbench-v2");

  const header = shell.querySelector(".hdr");
  const brandTitle = header?.querySelector("h1");
  const playlistPill = header?.querySelector(".song-pill");
  if (header && brandTitle && playlistPill && !$("layoutMenuButton")) {
    const menuButton = document.createElement("button");
    menuButton.id = "layoutMenuButton";
    menuButton.className = "layout-menu-button";
    menuButton.type = "button";
    menuButton.setAttribute("aria-label", "Glavni meni");
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.innerHTML = '<span></span><span></span><span></span>';
    menuButton.addEventListener("click", () => {
      const workbench = shell.querySelector(".work");
      const hidden = workbench?.classList.toggle("hide-lcol") || false;
      menuButton.setAttribute("aria-expanded", hidden ? "false" : "true");
    });
    brandTitle.after(menuButton);
    const chevron = document.createElement("span");
    chevron.className = "playlist-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "⌄";
    playlistPill.append(chevron);
  }

  const leftBody = shell.querySelector(".lcol-body");
  const searchRow = shell.querySelector(".search-row");
  const leftActions = shell.querySelector(".lcol-actions");
  const addForm = $("addSongForm");
  if (leftBody && searchRow && leftActions) {
    leftBody.insertBefore(searchRow, leftActions);
    const addToggle = $("addSongToggle");
    if (addToggle) addToggle.textContent = "+  Uvezi pesmu";
    if (!$("quickSongSources")) {
      const launchers = document.createElement("div");
      launchers.id = "quickSongSources";
      launchers.className = "quick-song-sources";
      launchers.innerHTML =
        '<button type="button" data-open-song-source="youtube"><span class="source-youtube">▶</span>YouTube link</button>' +
        '<button type="button" data-open-song-source="mp3"><span aria-hidden="true">♫</span>Audio fajl</button>';
      leftActions.after(launchers);
      launchers.addEventListener("click", (event) => {
        const button = event.target.closest("[data-open-song-source]");
        if (!button) return;
        setSongSourceMode(button.dataset.openSongSource);
        if (addForm) addForm.hidden = false;
      });
    }
  }

  const middle = shell.querySelector(".mcol");
  const topRow = shell.querySelector(".toprow");
  const playerCard = shell.querySelector(".yt-card");
  const playerSide = shell.querySelector(".yt-side");
  const titleRow = shell.querySelector(".yt-title-row");
  const titleKey = $("selectedSongKeyDisplay");
  const toneCard = shell.querySelector(".tone-card");
  const transport = shell.querySelector(".yt-buttons");
  const seekField = shell.querySelector(".seek-field");
  const recordedControls = $("recPlayerRow");
  if (playerCard && playerSide && titleRow) {
    playerCard.classList.add("studio-player");
    if (!$("heroSourceBadge")) {
      const meta = document.createElement("div");
      meta.className = "hero-song-meta";
      if (titleKey) meta.append(titleKey);
      const sourceBadge = document.createElement("span");
      sourceBadge.id = "heroSourceBadge";
      sourceBadge.className = "hero-source-badge";
      sourceBadge.textContent = "MP3";
      meta.append(sourceBadge);

      const mixToggle = document.createElement("button");
      mixToggle.id = "localMixToggle";
      mixToggle.className = "local-mix-toggle";
      mixToggle.type = "button";
      mixToggle.setAttribute("role", "switch");
      mixToggle.setAttribute("aria-checked", "true");
      mixToggle.title = "Biraj zvuk: naš AI miks ili originalni YouTube";
      mixToggle.innerHTML = '<i aria-hidden="true"></i><span>Naš miks</span>';
      mixToggle.hidden = true;
      mixToggle.addEventListener("click", toggleHybridPlaybackSource);
      meta.append(mixToggle);

      const waveform = document.createElement("div");
      waveform.id = "heroWaveform";
      waveform.className = "hero-waveform";
      waveform.setAttribute("role", "slider");
      waveform.setAttribute("tabindex", "0");
      waveform.setAttribute("aria-label", "Pozicija u pesmi");
      waveform.dataset.waveformState = "loading";
      const emptyWaveformPath = buildWaveformPath([]);
      waveform.innerHTML =
        '<svg viewBox="0 0 1000 96" preserveAspectRatio="none" aria-hidden="true">' +
          '<defs><clipPath id="heroWaveClip"><rect id="waveformProgress" x="0" y="0" width="0" height="96"></rect></clipPath></defs>' +
          '<path class="hero-wave-base" d="' + emptyWaveformPath + '"></path>' +
          '<path class="hero-wave-played" clip-path="url(#heroWaveClip)" d="' + emptyWaveformPath + '"></path>' +
        '</svg>' +
        '<i id="waveformPlayhead" aria-hidden="true"></i>' +
        '<div class="hero-wave-times"><output id="waveformElapsed">0:00</output><output id="waveformDuration">0:00</output></div>';

      titleRow.after(meta);
      meta.after(waveform);
      bindHeroWaveformInteractions(waveform);
    }
    if (transport) playerSide.append(transport);
    if (seekField) playerSide.append(seekField);
    if (recordedControls) {
      recordedControls.classList.add("legacy-rec-controls");
      playerSide.append(recordedControls);
    }
    if (toneCard) {
      const toneHeading = toneCard.querySelector(".tc-head");
      if (toneHeading) toneHeading.textContent = "Transpozicija";
      playerCard.append(toneCard);
    }
  }

  const strip = shell.querySelector(".strip");
  const tool = shell.querySelector(".tool");
  if (middle && topRow && strip && tool) middle.append(topRow, strip, tool);

  const toolChips = $("toolChips");
  const toolHead = tool?.querySelector(".tool-head");
  if (toolChips && !toolChips.querySelector('[data-m="chart"]')) {
    const chartChip = document.createElement("button");
    chartChip.className = "chip";
    chartChip.type = "button";
    chartChip.dataset.m = "chart";
    chartChip.textContent = "Chart";
    toolChips.prepend(chartChip);
  }
  const toolLabels = {
    akordi: "Akordi tonaliteta",
    skale: "Skale",
    krug: "Krug kvinti",
    vezba: "Vežbe"
  };
  if (toolChips) {
    toolChips.querySelectorAll("[data-m]").forEach((chip) => {
      if (toolLabels[chip.dataset.m]) chip.textContent = toolLabels[chip.dataset.m];
    });
  }
  const addChord = $("learnAddChord");
  if (toolHead && addChord) {
    addChord.textContent = "+  Akord";
    addChord.classList.add("chart-add-button");
    toolHead.append(addChord);
  }

  const rail = shell.querySelector(".rcol");
  const oldRailHead = rail?.querySelector(".rc-head");
  const oldRailBody = rail?.querySelector(".rc-body");
  const mixer = $("recMixerPanel");
  const metronome = shell.querySelector(".metronome-panel");
  const practiceButton = $("practiceSongButton");
  if (rail && oldRailBody && mixer && metronome && practiceButton) {
    rail.classList.remove("panel");
    rail.classList.add("studio-rail");

    const channelOrder = ["Vokal", "Bas", "Bubnjevi", "Gitara", "Melodija / solo", "Harmonija / pratnja"];
    const channelMap = new Map(
      [...mixer.querySelectorAll(".mixer-channel")].map((channel) => [channel.querySelector(".chan-label")?.textContent.trim(), channel])
    );
    channelOrder.forEach((name) => {
      const channel = channelMap.get(name);
      if (!channel) return;
      const input = channel.querySelector(".mixer-vol");
      let output = channel.querySelector(".chan-value");
      if (!output) {
        output = document.createElement("output");
        output.className = "chan-value";
        input?.after(output);
      }
      output.value = input?.value || "100";
      input?.addEventListener("input", () => { output.value = input.value; });
      mixer.append(channel);
    });
    const mixerLearning = mixer.querySelector(".mixer-learning");
    if (mixerLearning) mixer.append(mixerLearning);
    mixer.hidden = false;

    const stemsCard = document.createElement("section");
    stemsCard.className = "panel studio-stems-card";
    stemsCard.innerHTML = '<div class="studio-panel-title"><span>AI stemovi</span><small>6 kanala</small></div>';
    stemsCard.append(mixer);

    metronome.classList.add("panel", "studio-metronome-card");
    practiceButton.classList.add("studio-practice-cta");
    practiceButton.textContent = "◉  Vežbaj uz pesmu";

    const legacy = document.createElement("div");
    legacy.className = "legacy-learning-state";
    if (oldRailHead) legacy.append(oldRailHead);
    legacy.append(oldRailBody);
    rail.replaceChildren(stemsCard, metronome, practiceButton, legacy);
  }
}

function migrateWorkbenchDefaults() {
  const migrationKey = "fgr-workbench-layout-version";
  const version = Number(readJsonStorage(migrationKey, 0)) || 0;
  if (version >= 103) return;
  state.tool = "chart";
  const legacy = readJsonStorage("fgr-ui-v1", {});
  legacy.tool = "chart";
  writeJsonStorage("fgr-ui-v1", legacy);
  writeJsonStorage(migrationKey, 103);
}

function getHeroDuration() {
  const song = getSelectedSong();
  if (isLocalSong(song) && rec.buffer?.duration && rec.bufferId === recId()) {
    return Number(rec.buffer.duration) || 0;
  }
  const player = state.youtubePlayer;
  if (!isLocalSong(song) && song?.videoId && state.youtubeLoadedVideoId === song.videoId && player && typeof player.getDuration === "function") {
    const duration = Number(player.getDuration()) || 0;
    if (duration > 0) return duration;
  }
  const explicit = Number(song?.duration || song?.source?.duration || 0);
  if (explicit > 0) return explicit;
  const chords = Array.isArray(song?.chords) ? song.chords : [];
  const lastChord = chords.length ? Number(chords[chords.length - 1].t) || 0 : 0;
  return lastChord > 0 ? lastChord + 12 : 204;
}

function autoFollowChartTimeline(chart, playheadPixels) {
  const scroll = chart?.closest(".chart-timeline-scroll");
  if (!scroll || chart.classList.contains("is-scrubbing")) return;
  if (!isSongPlaybackRunning(getSelectedSong())) return;
  const now = performance.now();
  if (now < (Number(scroll.dataset.userScrollUntil) || 0)) return;
  const follow = computeTimelineFollowScroll({
    playheadPx: playheadPixels,
    viewportWidth: scroll.clientWidth,
    scrollWidth: scroll.scrollWidth,
    currentScrollLeft: scroll.scrollLeft,
    anchorRatio: 0.12,
    easing: 0.34
  });
  if (Math.abs(follow.nextScrollLeft - scroll.scrollLeft) < 0.5) return;
  scroll.dataset.autoScrollUntil = String(now + 250);
  scroll.scrollLeft = follow.nextScrollLeft;
}

function setChartEditCursorTime(time) {
  const chart = $("ccStrip");
  if (!chart) return Math.max(0, Number(time) || 0);
  const cursorTime = resolveChordInsertionTime({
    chartCursorTime: time,
    duration: Number(chart.dataset.duration) || getHeroDuration()
  });
  chart.dataset.chartCursorTime = String(cursorTime);
  return cursorTime;
}

function getChartEditCursorTime() {
  const value = $("ccStrip")?.dataset.chartCursorTime;
  if (value === undefined || value === null || value === "") return null;
  const time = Number(value);
  return Number.isFinite(time) ? time : null;
}

function getChordInsertionTime(song) {
  const player = state.youtubePlayer;
  const playbackTime = isLocalSong(song)
    ? recTime()
    : (player && typeof player.getCurrentTime === "function"
      ? Number(player.getCurrentTime()) || 0
      : getLivePlaybackTime());
  return resolveChordInsertionTime({
    playbackTime,
    chartCursorTime: getChartEditCursorTime(),
    playbackRunning: isSongPlaybackRunning(song),
    duration: getHeroDuration()
  });
}

function reconcileSongChordEndTime(song) {
  const chords = Array.isArray(song?.chords) ? song.chords : [];
  if (!chords.length) {
    if (song) delete song.chordEndTime;
    return;
  }
  const lastStart = Number(chords[chords.length - 1]?.t) || 0;
  if (Number.isFinite(Number(song.chordEndTime)) && Number(song.chordEndTime) <= lastStart + 0.049) {
    delete song.chordEndTime;
  }
}

function commitChordInsertion(song, name, atSeconds) {
  const chordName = String(name || "").trim();
  const timeValue = Number(atSeconds);
  if (!song || !chordName || !Number.isFinite(timeValue)) return false;
  const time = Math.max(0, Math.round(timeValue * 1000) / 1000);

  song.chords = Array.isArray(song.chords) ? song.chords : [];
  const insertion = upsertChordAtTime(song.chords, chordName, time, 0.05);
  const replaced = insertion.replaced;
  song.chords = insertion.chords;
  reconcileSongChordEndTime(song);
  saveRepertoire();
  patchSongChordsOnService(song);
  updateSelectedSongPanel();
  renderMiniChart();
  if (state.tool === "chart") renderTool();

  const playbackRunning = isSongPlaybackRunning(song);
  const chart = $("ccStrip");
  if (chart && !playbackRunning) setChartEditCursorTime(time);
  const displayTime = playbackRunning ? getLivePlaybackTime() : time;
  updateHeroPlaybackVisuals(displayTime);
  syncLearningChartAtTime(displayTime, { force: true, scroll: false, allowBeforeFirst: true });
  setPipeStatus(replaced
    ? `Akord na ${fmtChordTime(insertion.time)} zamenjen je sa ${chordName} i sacuvan.`
    : `Akord ${chordName} dodat na ${fmtChordTime(time)} i sacuvan.`);
  return true;
}

function closeAddChordDialog(options = {}) {
  if (!addChordDialog || addChordDialog.hidden) return;
  addChordDialog.hidden = true;
  pendingChordInsertion = null;
  if (addChordNameInput) {
    addChordNameInput.value = "";
    addChordNameInput.setCustomValidity("");
  }
  const returnFocus = addChordDialogReturnFocus;
  addChordDialogReturnFocus = null;
  if (options.restoreFocus === false) return;
  const fallback = $("learnAddChord");
  const target = returnFocus?.isConnected ? returnFocus : fallback;
  if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
}

function openAddChordDialog(song, time) {
  if (!addChordDialog || !addChordNameInput || !addChordTimeOutput || !song) return false;
  const resolvedTime = resolveChordInsertionTime({
    chartCursorTime: time,
    duration: getHeroDuration()
  });
  pendingChordInsertion = { songId: song.id, time: resolvedTime };
  addChordDialogReturnFocus = document.activeElement;
  addChordTimeOutput.value = fmtChordTime(resolvedTime);
  addChordTimeOutput.textContent = fmtChordTime(resolvedTime);
  addChordNameInput.value = "";
  addChordNameInput.setCustomValidity("");
  addChordDialog.hidden = false;
  requestAnimationFrame(() => {
    if (!addChordDialog.hidden) addChordNameInput.focus({ preventScroll: true });
  });
  return true;
}

function submitAddChordDialog() {
  if (!pendingChordInsertion || !addChordNameInput) return false;
  const chordName = addChordNameInput.value.trim();
  if (!chordName) {
    addChordNameInput.setCustomValidity("Unesi naziv akorda.");
    addChordNameInput.reportValidity();
    return false;
  }
  addChordNameInput.setCustomValidity("");
  const song = state.repertoire.find((item) => item.id === pendingChordInsertion.songId);
  if (!song) {
    closeAddChordDialog();
    return false;
  }
  const committed = commitChordInsertion(song, chordName, pendingChordInsertion.time);
  if (committed) closeAddChordDialog();
  return committed;
}

function handleAddChordDialogKeydown(event) {
  if (!addChordDialog || addChordDialog.hidden) return;
  if (event.key === "Enter" && event.target === addChordNameInput && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    submitAddChordDialog();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAddChordDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...addChordDialog.querySelectorAll(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !addChordDialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateHeroPlaybackVisuals(time = 0) {
  const duration = getHeroDuration();
  const current = clamp(Number(time) || 0, 0, duration || 0);
  const ratio = duration > 0 ? current / duration : 0;
  const progress = $("waveformProgress");
  const playhead = $("waveformPlayhead");
  const elapsed = $("waveformElapsed");
  const total = $("waveformDuration");
  const waveform = $("heroWaveform");
  const chart = $("ccStrip");
  const chartPlayhead = $("chartPlayhead");
  if (chart) ensureChartTimelineDuration(chart, duration);
  if (progress) progress.setAttribute("width", String(Math.round(ratio * 1000)));
  if (playhead) playhead.style.left = `${ratio * 100}%`;
  if (elapsed) elapsed.value = fmtTime(current);
  if (total) total.value = fmtTime(duration);
  if (waveform) waveform.setAttribute("aria-valuenow", String(Math.round(current)));
  if (waveform) {
    waveform.setAttribute("aria-valuemin", "0");
    waveform.setAttribute("aria-valuemax", String(Math.round(duration)));
    waveform.setAttribute("aria-valuetext", `${fmtTime(current)} od ${fmtTime(duration)}`);
  }
  if (chart && chartPlayhead) {
    const pixelsPerSecond = Number(chart.dataset.pixelsPerSecond) || 23;
    const chartDuration = Number(chart.dataset.duration) || duration;
    const playbackRunning = isSongPlaybackRunning(getSelectedSong());
    const chartScrubbing = chart.classList.contains("is-scrubbing");
    const waveformScrubbing = waveform?.classList.contains("is-scrubbing");
    if (playbackRunning && !chartScrubbing && !waveformScrubbing) {
      delete chart.dataset.chartCursorTime;
    }
    const chartTime = resolveChordInsertionTime({
      playbackTime: current,
      chartCursorTime: chart.dataset.chartCursorTime,
      playbackRunning,
      duration: chartDuration
    });
    const playheadPixels = chartTime * pixelsPerSecond;
    if (!chartScrubbing) {
      chartPlayhead.style.left = `${playheadPixels}px`;
      chartPlayhead.setAttribute("aria-valuenow", String(Math.round(chartTime * 10) / 10));
      chartPlayhead.setAttribute("aria-valuemax", String(chartDuration));
      chartPlayhead.setAttribute("aria-label", `Pozicija ${fmtChordTime(chartTime)}`);
    }
    if (!waveformScrubbing) autoFollowChartTimeline(chart, playheadPixels);
  }
}

function setHeroWaveformPath(path, waveformState = "ready") {
  const waveform = $("heroWaveform");
  if (!waveform) return;
  const safePath = typeof path === "string" && path ? path : buildWaveformPath([]);
  waveform.querySelectorAll(".hero-wave-base, .hero-wave-played").forEach((element) => {
    element.setAttribute("d", safePath);
  });
  waveform.dataset.waveformState = waveformState;
}

function getHeroWaveformSource(song) {
  const mixAsset = song?.assets?.mix;
  const mixUrl = typeof mixAsset === "string"
    ? mixAsset
    : mixAsset && typeof mixAsset.url === "string" ? mixAsset.url : "";
  const sourceName = String(song?.source?.name || song?.source?.fileName || "");
  const sourceIdentity = [
    typeof mixAsset === "object" ? mixAsset?.id : "",
    typeof mixAsset === "object" ? mixAsset?.sha256 || mixAsset?.sourceSha256 : "",
    song?.chordSourceSha256,
    song?.source?.sha256,
    song?.localCapture?.capturedAt,
    typeof mixAsset === "object" ? mixAsset?.revision || mixAsset?.updatedAt : "",
    song?.source?.lastModified,
    song?.source?.size
  ].map((value) => String(value ?? "")).join("|");
  return {
    mixUrl,
    cacheKey: `${String(song?.id || "")}::${mixUrl}::${sourceName}::${sourceIdentity}`
  };
}

async function decodeHeroWaveformSource(song, expectedBufferId) {
  const ctx = ensureAudio({ resume: false });
  if (!ctx) return null;
  const { mixUrl } = getHeroWaveformSource(song);
  if (mixUrl) {
    try {
      const response = await fetch(mixUrl);
      if (!response.ok) throw new Error(`Waveform source HTTP ${response.status}`);
      return await ctx.decodeAudioData(await response.arrayBuffer());
    } catch {
      // A processed remote asset may have expired. The original upload below
      // is the authoritative local fallback and still produces the real wave.
    }
  }
  try {
    const item = await dbGet(expectedBufferId);
    if (item?.blob) return await ctx.decodeAudioData(await item.blob.arrayBuffer());
  } catch {
    // Keep the UI responsive when IndexedDB is unavailable or the upload was
    // removed; the normal recording loader remains the final fallback.
  }
  const loaded = await recLoad().catch(() => false);
  return loaded && rec.bufferId === expectedBufferId ? rec.buffer : null;
}

function getHeroWaveformBuffer(song, expectedBufferId, cacheKey) {
  if (rec.buffer && rec.bufferId === expectedBufferId) return Promise.resolve(rec.buffer);
  const existing = heroWaveformBufferTaskCache.get(cacheKey);
  if (existing) return existing;
  let task;
  task = decodeHeroWaveformSource(song, expectedBufferId).finally(() => {
    if (heroWaveformBufferTaskCache.get(cacheKey) === task) heroWaveformBufferTaskCache.delete(cacheKey);
  });
  heroWaveformBufferTaskCache.set(cacheKey, task);
  return task;
}

async function refreshHeroWaveform(song = getSelectedSong()) {
  const generation = ++heroWaveformGeneration;
  const selectedId = String(song?.id || "");
  const expectedBufferId = selectedId ? `song-${selectedId}` : "";
  const { cacheKey } = getHeroWaveformSource(song);
  const hasWaveformAudio = hasLocalSongAudio(song);
  const cachedSongPath = heroWaveformSongPathCache.get(cacheKey);
  if (cachedSongPath && song && hasWaveformAudio) {
    setHeroWaveformPath(cachedSongPath, "ready");
    updateHeroPlaybackVisuals(getLivePlaybackTime());
    return;
  }
  setHeroWaveformPath(buildWaveformPath([]), song && hasWaveformAudio ? "loading" : "unavailable");
  if (!song || !hasWaveformAudio) return;

  const waveformBuffer = await getHeroWaveformBuffer(song, expectedBufferId, cacheKey);
  if (
    !waveformBuffer ||
    generation !== heroWaveformGeneration ||
    state.selectedSongId !== selectedId
  ) {
    if (generation === heroWaveformGeneration) setHeroWaveformPath(buildWaveformPath([]), "unavailable");
    return;
  }

  let path = heroWaveformPathCache.get(waveformBuffer);
  if (!path) {
    path = createWaveformPath(waveformBuffer, { bins: 360, samplesPerBin: 224 });
    heroWaveformPathCache.set(waveformBuffer, path);
  }
  heroWaveformSongPathCache.set(cacheKey, path);
  if (generation !== heroWaveformGeneration || state.selectedSongId !== selectedId) return;
  setHeroWaveformPath(path, "ready");
  updateHeroPlaybackVisuals(getLivePlaybackTime());
}

function ensureChartTimelineDuration(chart, duration) {
  const previousDuration = Number(chart.dataset.duration) || 0;
  const nextDuration = Math.max(0, Number(duration) || 0);
  if (!nextDuration || Math.abs(nextDuration - previousDuration) < 0.05) {
    // Trajanje se nije promenilo, ali je ritmička mreža mogla da stigne tek
    // sada — analiza je asinhrona. Bez ove provere bi taktovne crte izostale
    // sve dok korisnik ručno ponovo ne izabere pesmu.
    redrawBeatGridIfStale(chart);
    return;
  }
  const displayDuration = Math.max(40, Math.ceil(nextDuration / 5) * 5);
  const pixelsPerSecond = Number(chart.dataset.pixelsPerSecond) || 23;
  chart.dataset.duration = String(nextDuration);
  chart.style.width = `${Math.max(840, Math.round(displayDuration * pixelsPerSecond))}px`;
  const song = getSelectedSong();
  const chords = Array.isArray(song?.chords) ? song.chords : [];
  const chordEndTime = resolveChordEndTime(chords, nextDuration, song?.chordEndTime);
  chart.dataset.chordEndTime = String(chordEndTime);
  chords.forEach((chord, index) => {
    const cell = chart.querySelector(`.cc[data-index="${index}"]`);
    if (!cell) return;
    const geometry = chordSegmentGeometry(chords, index, nextDuration, pixelsPerSecond, chordEndTime);
    cell.style.left = `${geometry.left}px`;
    cell.style.width = `${geometry.width}px`;
    const durationLabel = cell.querySelector(".cc-duration");
    if (durationLabel) durationLabel.textContent = `${geometry.duration.toFixed(1)} s`;
    cell.setAttribute("aria-label", `${transposeChordName(chord.n)}, od ${fmtChordTime(geometry.start)} do ${fmtChordTime(geometry.end)}`);
  });
  const ruler = chart.querySelector(".chart-ruler");
  const grid = chart.querySelector(".chart-grid");
  if (!ruler || !grid) return;
  ruler.replaceChildren();
  grid.replaceChildren();
  const tickSeconds = timelineTickSeconds(pixelsPerSecond);
  for (let second = 0; second <= displayDuration; second += tickSeconds) {
    const left = second * pixelsPerSecond;
    const tick = document.createElement("span");
    tick.style.left = `${left}px`;
    tick.textContent = fmtTime(second);
    ruler.append(tick);
    const line = document.createElement("i");
    line.style.left = `${left}px`;
    grid.append(line);
  }
  renderBeatGridLines(grid, song, displayDuration, pixelsPerSecond);
}

/**
 * Iscrtaj ritmičku mrežu preko vremenske mreže u sekundama. Korisnik odmah
 * vidi da li je tempo ili prva doba promašena, umesto da to otkrije tek kada
 * kvantizovani akordi zazvuče pomereno.
 */
function renderBeatGridLines(grid, song, displayDuration, pixelsPerSecond) {
  // Idempotentno: mreža se ponovo crta i kada se pesma nije promenila
  // (prekidač, novi rezultat analize), pa stare linije moraju prvo da odu.
  grid.querySelectorAll("i.beat-line").forEach((line) => line.remove());
  const beatGrid = songBeatGrid(song);
  grid.classList.toggle("has-beat-grid", Boolean(beatGrid && state.showBeatGrid !== false));
  if (!beatGrid || state.showBeatGrid === false) return;

  // Samo taktovne crte. One su deo notnog pisma i pomažu da se harta čita u
  // taktovima; pojedinačni bitovi su dijagnostika, ne informacija za nekoga
  // ko uči pesmu.
  beatGrid.beats.forEach((time, index) => {
    if (time > displayDuration || !isDownbeatIndex(beatGrid, index)) return;
    const line = document.createElement("i");
    line.className = "beat-line is-downbeat";
    line.style.left = `${time * pixelsPerSecond}px`;
    grid.append(line);
  });
  grid.dataset.gridSignature = beatGridSignature(beatGrid, pixelsPerSecond);
}

/** Otisak nacrtane mreže: menja se tačno kada crte treba ponovo iscrtati. */
function beatGridSignature(beatGrid, pixelsPerSecond) {
  if (!beatGrid || state.showBeatGrid === false) return "none";
  return [
    beatGrid.beats.length,
    beatGrid.beatsPerBar,
    beatGrid.downbeatIndex,
    Math.round(beatGrid.bpm * 100),
    pixelsPerSecond
  ].join(":");
}

function redrawBeatGridIfStale(chart) {
  const grid = chart?.querySelector(".chart-grid");
  if (!grid) return;
  const song = getSelectedSong();
  const pixelsPerSecond = Number(chart.dataset.pixelsPerSecond) || 23;
  if (grid.dataset.gridSignature === beatGridSignature(songBeatGrid(song), pixelsPerSecond)) return;
  const duration = Number(chart.dataset.duration) || 0;
  if (!duration) return;
  renderBeatGridLines(grid, song, Math.max(40, Math.ceil(duration / 5) * 5), pixelsPerSecond);
  updateBeatGridInfo();
}

/**
 * Mreža pesme sa primenjenim korisnikovim podešavanjem. Sve što crta ili
 * svira mora da ide kroz ovo, inače bi timeline i klavir gledali u različite
 * taktove.
 */
function songBeatGrid(song = getSelectedSong()) {
  const grid = normalizeBeatGrid(song?.beatGrid || song?.assets?.beatGrid);
  return grid ? applyGridOverride(grid, song?.gridOverride) : null;
}

function patchGridOverride(changes) {
  const song = getSelectedSong();
  if (!song) return;
  song.gridOverride = { ...(song.gridOverride || {}), ...changes };
  saveRepertoire();
  refreshBeatGridOverlay();
  refreshGuidedPlayback({ force: true });
}

/** Ponovo iscrtaj samo ritmičku mrežu, bez preračunavanja celog timeline-a. */
function refreshBeatGridOverlay() {
  const chart = $("ccStrip");
  const grid = chart?.querySelector(".chart-grid");
  updateBeatGridInfo();
  if (!chart || !grid) return;
  const duration = Number(chart.dataset.duration) || 0;
  if (!duration) return;
  renderBeatGridLines(
    grid,
    getSelectedSong(),
    Math.max(40, Math.ceil(duration / 5) * 5),
    Number(chart.dataset.pixelsPerSecond) || 23
  );
}

/**
 * Prikaži šta je mreža zapravo prepoznala. Nesiguran takt se izgovara
 * naglas, umesto da korisnik pretpostavi da je prva doba tačna.
 */
function updateBeatGridInfo() {
  if (!beatGridInfo) return;
  const beatGrid = songBeatGrid();
  if (!beatGrid || state.showBeatGrid === false) {
    beatGridInfo.hidden = true;
    beatGridInfo.textContent = "";
    return;
  }
  // Samo tempo i takt. Koliko je merenje bilo sigurno je podatak za mene, ne
  // za nekoga ko uči pesmu — to ide u tooltip, ne u traku.
  beatGridInfo.textContent = `${Math.round(beatGrid.bpm)} BPM · ${beatGrid.beatsPerBar}/4`;
  beatGridInfo.classList.toggle("is-uncertain", beatGrid.status === "low-confidence");
  beatGridInfo.title = [
    `Tempo ${Math.round(beatGrid.bpm)} BPM, takt ${beatGrid.beatsPerBar}/4`,
    beatGrid.meterStatus === "ready" ? "prva doba pouzdano izmerena" : "prva doba procenjena",
    beatGrid.feel ? `osećaj ritma: ${beatGrid.feel}` : ""
  ].filter(Boolean).join(" · ");
  beatGridInfo.hidden = false;
}

function getHeroWaveformTimeAtPointer(waveform, event) {
  const rect = waveform.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  return ratio * getHeroDuration();
}

function syncSeekUi(time, options = {}) {
  const target = clamp(Number(time) || 0, 0, getHeroDuration() || 0);
  if (options.rememberCursor !== false) setChartEditCursorTime(target);
  updateHeroPlaybackVisuals(target);
  updateRecordedPlaybackControls();
  syncLearningChartAtTime(target, {
    force: true,
    scroll: false,
    allowBeforeFirst: state.practiceModeActive
  });
  return target;
}

function setPendingRemoteSeek(song, time) {
  pendingRemoteSeek = song ? {
    songId: String(song.id || ""),
    time: Math.max(0, Number(time) || 0),
    createdAt: performance.now()
  } : null;
}

function getPendingRemoteSeekTime(song, actualTime) {
  if (!pendingRemoteSeek) return null;
  if (!song || pendingRemoteSeek.songId !== String(song.id || "")) {
    pendingRemoteSeek = null;
    return null;
  }
  const age = performance.now() - pendingRemoteSeek.createdAt;
  const actual = Number(actualTime);
  if (
    age > REMOTE_SEEK_PREVIEW_TTL_MS ||
    (Number.isFinite(actual) && Math.abs(actual - pendingRemoteSeek.time) <= 0.75)
  ) {
    pendingRemoteSeek = null;
    return null;
  }
  return pendingRemoteSeek.time;
}

function seekSelectedPlaybackTo(seconds) {
  const song = getSelectedSong();
  if (!song) return 0;
  const target = syncSeekUi(setChartEditCursorTime(seconds));
  if (isLocalSong(song)) {
    pendingRemoteSeek = null;
    recSeek(target);
    if (isHybridYouTubeSong(song)) {
      ensureHybridVideoLoaded(song, { autoplay: false }).then((player) => {
        if (state.selectedSongId === song.id && player && typeof player.seekTo === "function") {
          player.seekTo(localTimeToHybridVideoTime(song, target), true);
        }
      }).catch(() => {});
    }
    return target;
  }

  setPendingRemoteSeek(song, target);
  ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
    if (state.selectedSongId !== song.id) return;
    if (player && typeof player.seekTo === "function") player.seekTo(target, true);
  }).catch(() => {});
  return target;
}

function bindHeroWaveformInteractions(waveform) {
  if (!waveform || waveform.dataset.seekBound === "true") return;
  waveform.dataset.seekBound = "true";
  let pointerId = null;
  let previewTime = 0;

  const preview = (event) => {
    previewTime = getHeroWaveformTimeAtPointer(waveform, event);
    syncSeekUi(previewTime);
  };
  const removeWindowListeners = () => {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
  };
  const finish = (event, commit) => {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    if (event) preview(event);
    const capturedPointerId = pointerId;
    pointerId = null;
    waveform.classList.remove("is-scrubbing");
    waveform.setAttribute("aria-grabbed", "false");
    removeWindowListeners();
    try { waveform.releasePointerCapture(capturedPointerId); } catch (_error) {}
    if (commit) seekSelectedPlaybackTo(previewTime);
    else syncSeekUi(getLivePlaybackTime(), { rememberCursor: false });
  };
  const onPointerMove = (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    preview(event);
  };
  const onPointerUp = (event) => finish(event, true);
  const onPointerCancel = (event) => finish(event, false);

  waveform.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    waveform.classList.add("is-scrubbing");
    waveform.setAttribute("aria-grabbed", "true");
    try { waveform.setPointerCapture(pointerId); } catch (_error) {}
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    preview(event);
  });

  waveform.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -5 : 5;
    seekSelectedPlaybackTo(Math.max(0, getLivePlaybackTime() + delta));
  });
}

// Inicijalizacija aplikacije
async function init() {
  prepareWorkbenchLayout();
  cacheDom();

  // Primenjivanje sacuvane teme na pocetku
  applySavedTheme();
  migrateWorkbenchDefaults();
  processingClient = createProcessingClient({ baseUrl: state.processingServiceUrl });
  
  // Renderovanje virtuelne klavijature
  renderKeyboard();
  window.dispatchEvent(new CustomEvent("fgr:keyboardready", {
    detail: { octave: state.baseOctave }
  }));
  
  const needsBundledFirstRun = loadRepertoireState();
  loadKeyboardSettings();
  renderRepertoire();
  updatePlaylistMode();
  bindEvents();
  // The song-change listener must already be bound so the initial title,
  // tonalitet, chart and pipeline are painted after a reload.
  const bundledLoaded = needsBundledFirstRun
    ? await loadBundledFirstRunRepertoire()
    : false;
  if (!bundledLoaded) updateSelectedSongPanel();
  adoptServiceLibrary();
  updateOctaveControls();
  updateMobileModifierState();
  updateLabelVisibility();
  updateSustainLengthDisplay();
  updateDoubleTapSharpDisplay();
  
  // Ucitavanje metronoma
  initMetronome();
  
  // Ucitavanje alata
  renderTool();
  checkBackendReachable();
  window.setTimeout(() => reportRenderState("startup"), 6000);
  
  // Probno inicijalizovanje zvuka
  try {
    ensureAudio({ resume: false });
  } catch {
    state.audioContext = null;
  }
  
  focusAppSoon();
  registerServiceWorker();
  
  // Inicijalno osvezavanje statusa IndexedDB snimka
  refreshPipe();
  await restoreBundledLuisChartIfNeeded();
}

// ---------------- DOGADJAJI & BINDINGS ----------------
function bindEvents() {
  // Globalni klik za fokus
  app.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("select, option, input, button, label")) {
      focusAppSoon();
    }
  });

  // Jacina zvuka
  volumeControl.addEventListener("input", () => {
    state.volume = Number(volumeControl.value) / 100;
    if (state.masterGain) {
      state.masterGain.gain.setTargetAtTime(state.volume, state.audioContext.currentTime, 0.015);
    }
    updateMediaSampleVolumes();
  });

  // Oktave
  octaveDown.addEventListener("click", () => changeOctave(-1));
  octaveUp.addEventListener("click", () => changeOctave(1));

  // Prikaz naziva tonova
  labelsToggle.addEventListener("change", () => {
    state.labelsVisible = labelsToggle.checked;
    updateLabelVisibility();
    saveKeyboardSettings();
  });

  // Promena instrumenta
  instrumentSelect.addEventListener("change", () => {
    state.instrument = instrumentSelect.value;
    stopAllSoundingNotes({ preserveAssisted: true });
    recomputeSound();
    if (state.harmonyPianoEnabled) updateHarmonyPiano(state.currentPlaybackChordName);
  });

  if (pianoHeightControl) {
    pianoHeightControl.addEventListener("input", () => {
      state.pianoDockHeight = normalizePianoDockHeight(pianoHeightControl.value);
      applyWorkbenchLayoutPreferences();
    });
    pianoHeightControl.addEventListener("change", () => {
      patchUiPreferences({ pianoDockHeight: state.pianoDockHeight });
    });
  }

  if (metronomePanelToggle) {
    metronomePanelToggle.addEventListener("click", () => {
      state.metronomeCollapsed = !state.metronomeCollapsed;
      patchUiPreferences({ metronomeCollapsed: state.metronomeCollapsed });
      applyWorkbenchLayoutPreferences();
    });
  }

  // Sustain
  sustainToggle.addEventListener("change", () => {
    state.sustainEnabled = sustainToggle.checked;
    if (!state.sustainEnabled) {
      releaseSustainedNotes();
    }
  });

  sustainLengthControl.addEventListener("input", () => {
    const val = Number(sustainLengthControl.value);
    state.sustainLength = val >= 8.1 ? Infinity : val;
    updateSustainLengthDisplay();
    rescheduleSustainedNotes();
  });

  // Keyboard settings
  doubleTapSharpControl.addEventListener("input", () => {
    const val = Number(doubleTapSharpControl.value);
    state.doubleTapSharpMs = clamp(val, 30, 250);
    doubleTapSharpControl.value = String(state.doubleTapSharpMs);
    updateDoubleTapSharpDisplay();
    saveKeyboardSettings();
  });

  pianoKeyboardToggle.addEventListener("change", () => {
    state.pianoKeyboardEnabled = pianoKeyboardToggle.checked;
    clearAllHeldState();
  });

  if (manualInversionDown) {
    manualInversionDown.addEventListener("click", () => {
      setManualInversionStep(state.manualInversionStep - 1);
    });
  }
  if (manualInversionUp) {
    manualInversionUp.addEventListener("click", () => {
      setManualInversionStep(state.manualInversionStep + 1);
    });
  }

  document.querySelectorAll("input[name='dugmetaraRows']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.dugmetaraRows = input.value === "3" ? "3" : "4";
        saveKeyboardSettings();
        clearAllHeldState();
      }
    });
  });

  omitExtensionRootToggle.addEventListener("change", () => {
    state.omitExtensionRootEnabled = omitExtensionRootToggle.checked;
    saveKeyboardSettings();
    recomputeSound();
  });

  closeVoicingToggle.addEventListener("change", () => {
    state.closeVoicingEnabled = closeVoicingToggle.checked;
    state.closeVoicingReferenceMidis = state.closeVoicingEnabled && state.activeMidiSet.size
      ? [...state.activeMidiSet]
      : null;
    saveKeyboardSettings();
    recomputeSound();
  });

  retriggerChordToggle.addEventListener("change", () => {
    state.retriggerChordOnChangeEnabled = retriggerChordToggle.checked;
    state.retriggerChordRequested = false;
    saveKeyboardSettings();
  });

  resetMemoryButton.addEventListener("click", () => {
    resetChordMemory();
  });

  document.querySelectorAll("input[name='extensionVoicing']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.extensionVoicing = input.value;
        saveKeyboardSettings();
        recomputeSound();
      }
    });
  });


  document.querySelectorAll("input[name='manualChordExtension']").forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      state.manualChordExtension = ["seven", "nine"].includes(input.value) ? input.value : "none";
      state.retriggerChordRequested = true;
      saveKeyboardSettings();
      recomputeSound();
    });
  });

  document.querySelectorAll("input[name='desktopMouseMode']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.desktopMouseMode = input.value;
        clearAllHeldState();
        state.heldMouseChordRoots.clear();
        recomputeSound();
      }
    });
  });

  // Mobilni mod sviranja i modifikatori
  document.querySelectorAll("input[name='mobileMode']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.mobileMode = input.value;
        clearAllHeldState();
        updateMobileModifierState();
        recomputeSound();
      }
    });
  });

  mobileModifierButtons.forEach((button) => {
    button.addEventListener("pointerdown", handleMobileModifierDown);
    button.addEventListener("pointerup", handleMobileModifierUp);
    button.addEventListener("pointercancel", handleMobileModifierUp);
    button.addEventListener("lostpointercapture", handleMobileModifierUp);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  });

  // Tastatura unosi (keydown/keyup)
  window.addEventListener("keydown", (e) => {
    // Provera precica za YouTube plejer pre prosledjivanja klavijaturi
    if (handleYouTubeShortcut(e)) {
      return;
    }
    handleKeyDown(e);
  }, { capture: true });
  
  window.addEventListener("keyup", (e) => {
    handleKeyUp(e);
  }, { capture: true });
  
  window.addEventListener("blur", clearAllHeldState);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearAllHeldState();
    }
  });

  // Repertoar kontrole unosa i pretrage
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

  // Plejliste i GitHub sinhronizacija
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

  // Global click to close context menu
  document.addEventListener("click", () => {
    hideSongContextMenu();
  });

  // Context menu actions
  if (ctxSelectSong) {
    ctxSelectSong.addEventListener("click", (event) => {
      event.stopPropagation();
      const songId = state.contextMenuSongId;
      hideSongContextMenu();
      if (songId) {
        state.selectionModeActive = true;
        state.selectedSongsForAction.clear();
        state.selectedSongsForAction.add(songId);
        renderCompactSongList();
        updatePlaylistSelectionActionsVisibility();
      }
    });
  }

  if (ctxRenameSong) {
    ctxRenameSong.addEventListener("click", (event) => {
      event.stopPropagation();
      const songId = state.contextMenuSongId;
      hideSongContextMenu();
      if (songId) {
        state.inlineEditingSongId = songId;
        renderCompactSongList();
      }
    });
  }

  if (ctxEditSong) {
    ctxEditSong.addEventListener("click", (event) => {
      event.stopPropagation();
      const songId = state.contextMenuSongId;
      hideSongContextMenu();
      if (songId) {
        openEditSongDialog(songId);
      }
    });
  }

  // Selection Actions
  if (deleteSelectedSongsButton) {
    deleteSelectedSongsButton.addEventListener("click", () => {
      deleteSelectedSongs();
    });
  }

  if (cancelSelectionButton) {
    cancelSelectionButton.addEventListener("click", () => {
      cancelSelectionMode();
    });
  }

  // Edit Song Dialog
  if (editSongDialogClose) editSongDialogClose.addEventListener("click", closeEditSongDialog);
  if (editSongCancelButton) editSongCancelButton.addEventListener("click", closeEditSongDialog);
  const editSongDialogBackdrop = $("editSongDialogBackdrop");
  if (editSongDialogBackdrop) {
    editSongDialogBackdrop.addEventListener("click", closeEditSongDialog);
  }
  if (editSongForm) {
    editSongForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveEditedSong();
    });
  }

  if (addChordDialogClose) addChordDialogClose.addEventListener("click", closeAddChordDialog);
  if (addChordCancelButton) addChordCancelButton.addEventListener("click", closeAddChordDialog);
  if (addChordDialogBackdrop) addChordDialogBackdrop.addEventListener("click", closeAddChordDialog);
  if (addChordDialog) addChordDialog.addEventListener("keydown", handleAddChordDialogKeydown);
  if (addChordNameInput) {
    addChordNameInput.addEventListener("input", () => addChordNameInput.setCustomValidity(""));
  }
  if (addChordForm) {
    addChordForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAddChordDialog();
    });
  }

  // YouTube plejer kontrole
  youtubePlayPause.addEventListener("click", triggerSelectedSongToggle);
  youtubeRewind.addEventListener("click", () => seekSelectedPlaybackBy(-getYouTubeSeekSeconds()));
  youtubeForward.addEventListener("click", () => seekSelectedPlaybackBy(getYouTubeSeekSeconds()));
  youtubeSeekSeconds.addEventListener("input", () => {
    state.youtubeSeekSeconds = getYouTubeSeekSeconds();
    savePlayerSettings();
    updateYouTubeSeekButtons();
  });

  // Zasebne precice na vrhu Plejera
  const youtubeOpenExternal = $("youtubeOpenExternal");
  if (youtubeOpenExternal) youtubeOpenExternal.addEventListener("click", openSelectedSongOnYouTube);
  
  const speedButton = $("speedButton");
  const RATES = [1.0, 0.75, 0.5, 0.25];
  let rateIndex = Math.max(0, RATES.indexOf(state.playbackRate));
  if (speedButton) {
    speedButton.addEventListener("click", () => {
      rateIndex = (rateIndex + 1) % RATES.length;
      const rate = RATES[rateIndex];
      window.FGRBridge.setRate(rate);
      speedButton.textContent = rate === 1 ? "1×" : `${rate.toFixed(2).replace(/0$/, "")}×`;
      speedButton.classList.toggle("primary-button", rate !== 1);
    });
  }

  const abLoopButton = $("abLoopButton");
  const abLoopStatus = $("abLoopStatus");
  function updateAbStatus(text) {
    if (abLoopStatus) abLoopStatus.textContent = text || "";
  }

  if (abLoopButton) {
    abLoopButton.addEventListener("click", () => {
      const bridge = window.FGRBridge;
      if (!bridge) return;
      if (abA === null) {
        abA = bridge.getTime();
        updateAbStatus(`A ${fmtTime(abA)} — klikni opet za B`);
        abLoopButton.classList.add("primary-button");
      } else if (abB === null) {
        abB = bridge.getTime();
        if (abB <= abA + 1) {
          abB = null;
          updateAbStatus("B mora biti posle A");
          return;
        }
        updateAbStatus(`↻ ${fmtTime(abA)} – ${fmtTime(abB)}`);
        abTimer = window.setInterval(() => {
          const t = bridge.getTime();
          if (t > abB || t < abA - 2) {
            bridge.seekTo(abA);
          }
        }, 400);
      } else {
        abA = null;
        abB = null;
        activePhraseLoop = null;
        if (abTimer) {
          window.clearInterval(abTimer);
          abTimer = null;
        }
        updateAbStatus("");
        abLoopButton.classList.remove("primary-button");
      }
    });
  }

  const phraseLoopButton = $("phraseLoopButton");
  if (phraseLoopButton) {
    phraseLoopButton.addEventListener("click", () => {
      const bridge = window.FGRBridge;
      if (!bridge) return;
      const source = state.melodyTrackSource === "bass" ? "bass" : "melody";
      const events = resolvedNoteTracks[source];
      if (!events?.length) {
        updateAbStatus(noteTrackUnavailableMessage(source));
        return;
      }
      const offset = Number(resolvedNoteTrackOffsets[source]) || 0;
      const phrases = detectMelodyPhrases(events);
      if (!phrases.length) {
        updateAbStatus("U ovoj liniji nema prepoznatih fraza.");
        return;
      }
      let phraseIndex = phraseIndexAtTime(phrases, Math.max(0, bridge.getTime() - offset));
      // Loop drži plejhed unutar fraze, pa ponovni klik znači "sledeća fraza".
      if (abTimer && activePhraseLoop?.source === source && activePhraseLoop.index === phraseIndex) {
        phraseIndex = (phraseIndex + 1) % phrases.length;
      }
      const phrase = phrases[phraseIndex];
      const start = Math.max(0, phrase.startTime + offset - 0.3);
      const end = phrase.endTime + offset + 0.35;
      abA = start;
      abB = end;
      activePhraseLoop = { source, index: phraseIndex };
      if (abTimer) window.clearInterval(abTimer);
      abTimer = window.setInterval(() => {
        const t = bridge.getTime();
        if (t > abB || t < abA - 2) bridge.seekTo(abA);
      }, 250);
      abLoopButton?.classList.add("primary-button");
      updateAbStatus(`↻ Fraza ${phraseIndex + 1}/${phrases.length} · ${fmtTime(start)}–${fmtTime(end)} · ${phrase.noteCount} tonova`);
      const song = getSelectedSong();
      if (isLocalSong(song) && !rec.playing) {
        ensureAudio();
        recLoad().then((ok) => {
          if (!ok) return;
          state.youtubeDesiredPlaying = true;
          recPlayFrom(start);
        });
      } else {
        bridge.seekTo(start);
      }
    });
  }

  bindAppearanceSettings();
  bindPianoFollowControls();

  if (midiBadge) {
    midiBadge.addEventListener("click", () => connectMidi(false));
  }
  const sidebarToggle = $("sidebarToggle");
  const workArea = document.querySelector(".work");
  if (sidebarToggle && workArea) {
    sidebarToggle.addEventListener("click", () => {
      const isHidden = workArea.classList.toggle("hide-rcol");
      sidebarToggle.setAttribute("aria-expanded", isHidden ? "false" : "true");
      sidebarToggle.classList.toggle("off", isHidden);
      try {
        const uiPrefs = readJsonStorage("fgr-ui-v1", {});
        uiPrefs.hideRcol = isHidden;
        writeJsonStorage("fgr-ui-v1", uiPrefs);
      } catch (e) {}
    });

    try {
      const uiPrefs = readJsonStorage("fgr-ui-v1", {});
      if (uiPrefs.hideRcol) {
        workArea.classList.add("hide-rcol");
        sidebarToggle.setAttribute("aria-expanded", "false");
        sidebarToggle.classList.add("off");
      }
    } catch (e) {}
  }

  const addSongToggle = $("addSongToggle");
  const addSongForm = $("addSongForm");
  if (addSongToggle && addSongForm) {
    addSongToggle.addEventListener("click", () => {
      addSongForm.hidden = !addSongForm.hidden;
    });
  }
  bindSongSourceControls();

  // ---------------- EVENT HANDLERI IZ DRUGIH MODULA ----------------
  window.addEventListener("fgr:songchange", (e) => {
    const song = e.detail && e.detail.song ? e.detail.song : null;
    const pillTitle = $("pillTitle");
    const pillKey = $("pillKey");

    // A selected song owns its transport and practice clock. Never allow a
    // previous YouTube player or practice session to keep driving the newly
    // selected song's chord and note guidance.
    state.youtubeDesiredPlaying = false;
    state.youtubeResumeTime = 0;
    state.youtubePauseGuardUntil = Date.now() + 1000;
    if (state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
      try { state.youtubePlayer.pauseVideo(); } catch (_error) {}
    }
    stopPracticeMode({ pauseRecording: false });
    
    if (pillTitle) pillTitle.textContent = state.activePlaylistName || "Repertoar";
    if (pillKey) {
      pillKey.hidden = true;
      pillKey.textContent = "";
    }
    
    updateToneCard();
    renderMiniChart();
    refreshPipe();
    
    // Zaustavljanje lokalnog snimka pri promeni pesme
    recStop(false);
    clearAssistedNotes();
    clearTimedNoteTracking();
    clearHarmonyHints();
    lastFollowedChord = null;
    state.currentPlaybackChordName = "";
    state.currentPlaybackChordTime = 0;
    invalidateRecLoad();
    rec.buffer = null;
    rec.bufferId = null;
    rec.mixBuffer = null;
    rec.stems = null;
    rec.hasStems = false;
    updateRecRow();
    if (song && isLocalSong(song)) {
      const requestedSongId = song.id;
      recLoad().then((loaded) => {
        if (!loaded || state.selectedSongId !== requestedSongId) return;
        updateRecRow();
        updateHeroPlaybackVisuals(getLivePlaybackTime());
      }).catch(() => {});
    }
    prepareSongNoteTracks(song);
    if (state.tool === "chart") renderTool();
    
    // Zaustavljanje A-B petlje i vežbe melodije pri promeni pesme
    stopMelodyPractice({ silent: true });
    abA = null;
    abB = null;
    activePhraseLoop = null;
    if (abTimer) {
      window.clearInterval(abTimer);
      abTimer = null;
    }
    updateAbStatus("");
    if (abLoopButton) {
      abLoopButton.classList.remove("primary-button");
    }

    const processingState = String(song?.processing?.state || "");
    const analysisIsIncomplete = !song?.stems || !song?.assets?.mix || !(song?.chords || []).length;
    if (
      hasLocalSongAudio(song) &&
      (
        ["queued", "downloading", "separating", "analyzing"].includes(processingState)
        || (processingState === "ready" && (!song?.stems || !song?.assets?.mix))
      )
    ) {
      window.setTimeout(() => resumeImportedProcessing(song, { autoAnalyze: false }), 0);
    } else if (
      !song?.chordPatchDirty
      && (processingState === "ready" || analysisIsIncomplete)
    ) {
      // Ask the service on every selection where something is missing, not only
      // when the local record already looks finished. A song can be left
      // half-written by a reload in the middle of a job, and then only the
      // service knows that its stems, chords and note tracks are ready.
      window.setTimeout(() => syncCompletedImportedProcessing(song), 0);
    }
    if (hasLocalSongAudio(song) && song?.chordPatchDirty) {
      window.setTimeout(() => patchSongChordsOnService(song), 0);
    }
    updateRepertoirePlaybackButtons();
  });
  songChangeListenerReady = true;
  
  window.addEventListener("fgr:octavechange", () => {
    if (["akordi", "skale", "vezba"].indexOf(state.tool) !== -1) {
      clearScale();
      renderTool();
    } else {
      const hint = getActiveHint();
      if (hint && !hint.autoClear) renderHint(hint);
      else clearScale();
    }
    if (state.harmonyPianoEnabled) updateHarmonyPiano(state.currentPlaybackChordName);
  });

  window.addEventListener("fgr:playchange", (event) => {
    const midis = event.detail.midis;
    const pcs = event.detail.pcs;
    
    // Azuriranje virtuelnih dirki na ekranu
    state.keyElementsByMidi.forEach((element, midi) => {
      element.classList.toggle("is-active", midis.includes(midi));
    });
    
    if (state.practiceModeActive) {
      checkPracticeChord();
    }
    checkMelodyPractice();
  });

  window.addEventListener("fgr:midichange", () => {
    syncStage();
    if (state.practiceModeActive) {
      checkPracticeChord();
    }
    checkMelodyPractice();
  });

  window.addEventListener("fgr:recupdate", () => {
    const song = getSelectedSong();
    if (isLocalSong(song)) syncSeekUi(recTime());
    else updateRecordedPlaybackControls();
    if (isLocalSong(song) && !rec.playing) state.youtubeDesiredPlaying = false;
    syncMixerControls();
    updateRepertoirePlaybackButtons();
  });

  // Dodavanje, izmena i brisanje akorada u chartu preko dogadjaja
  window.addEventListener("fgr:seekrequest", (e) => {
    seekSelectedPlaybackTo(e.detail.time);
  });

  window.addEventListener("fgr:movechordrequest", (e) => {
    const song = getSelectedSong();
    const index = Number(e.detail?.index);
    const mode = ["move", "left", "right"].includes(e.detail?.mode) ? e.detail.mode : "move";
    const deltaSeconds = Number(e.detail?.deltaSeconds);
    if (!song || !Number.isInteger(index) || !Number.isFinite(deltaSeconds) || !Array.isArray(song.chords) || !song.chords[index]) return;
    const songDuration = Math.max(Number(e.detail?.duration) || 0, getHeroDuration());
    const hasStoredChordEnd = song.chordEndTime !== null && song.chordEndTime !== undefined && song.chordEndTime !== "";
    const edit = editChordSegment(song.chords, index, mode, deltaSeconds, {
      duration: songDuration,
      chordEndTime: hasStoredChordEnd && Number.isFinite(Number(song.chordEndTime))
        ? Number(song.chordEndTime)
        : Number(e.detail?.chordEndTime),
      minimumGap: 0.05
    });
    if (!edit.changed) return;
    song.chords.splice(0, song.chords.length, ...edit.chords);
    const defaultEnd = resolveChordEndTime(song.chords, songDuration);
    if (Math.abs(edit.chordEndTime - defaultEnd) < 0.005) delete song.chordEndTime;
    else song.chordEndTime = edit.chordEndTime;
    saveRepertoire();
    patchSongChordsOnService(song);
    const strip = $("ccStrip");
    if (strip) strip.dataset.chordEndTime = String(edit.chordEndTime);
    renderMiniChart();
    syncLearningChartAtTime(getLivePlaybackTime(), { force: true });
    const geometryEnd = index + 1 < song.chords.length
      ? Number(song.chords[index + 1]?.t) || edit.chordEndTime
      : edit.chordEndTime;
    const action = mode === "move" ? "pomeren" : "promenjenog trajanja";
    setPipeStatus(`Akord ${song.chords[index].n} je ${action}: ${fmtChordTime(song.chords[index].t)}–${fmtChordTime(geometryEnd)}. Sacuvano.`);
  });

  window.addEventListener("fgr:removechordrequest", (e) => {
    const index = e.detail.index;
    const song = getSelectedSong();
    if (song && Array.isArray(song.chords) && song.chords[index]) {
      song.chords.splice(index, 1);
      reconcileSongChordEndTime(song);
      saveRepertoire();
      patchSongChordsOnService(song);
      updateSelectedSongPanel();
      renderMiniChart();
      if (state.tool === "chart") renderTool();
    }
  });

  window.addEventListener("fgr:addchordrequest", () => {
    const song = getSelectedSong();
    if (!song) return;
    const time = getChordInsertionTime(song);
    openTimelineChordPicker(song, time);
  });

  // ---------------- LOKALNO SNIMANJE I ANALIZA (Skidanje pesme) ----------------
  const pipeRecBtn = $("pipeRec");
  if (pipeRecBtn) {
    pipeRecBtn.addEventListener("click", () => {
      const song = getSelectedSong();
      if (capStarting || capStopping) {
        setPipeStatus("Sacekaj da se trenutna operacija snimanja zavrsi.");
        return;
      }
      if (song?.source?.type === "upload") {
        setPipeStatus("Lokalni audio je spreman i obrada se pokreće automatski.");
        return;
      }
      if (capRec && capRec.state === "recording") {
        stopCapture();
      } else {
        startCapture();
      }
    });
  }

  const analysisRetryButton = $("analysisRetryButton");
  if (analysisRetryButton) {
    analysisRetryButton.addEventListener("click", async () => {
      const song = getSelectedSong();
      if (!song || !hasLocalSongAudio(song) || isProcessingActive(song.processing)) return;
      const previousAnalysis = snapshotSongAnalysis(song);
      invalidateHeroWaveformCache(song);
      song.processing = createProcessingStatus("queued", "source", "Ponovna automatska obrada je pokrenuta.");
      persistProcessingUpdate(song);
      let succeeded = false;
      try {
        succeeded = await processImportedSong(song, null, {
          autoAnalyze: false,
          replaceWithAiCandidate: true,
          reuseExistingSource: true
        });
      } catch (error) {
        song.processing = createProcessingStatus(
          "failed",
          "source",
          error?.message || "Ponovna AI obrada nije uspela."
        );
      }
      if (succeeded) return;

      const failedProcessing = song.processing;
      restoreSongAnalysis(song, previousAnalysis);
      song.processing = failedProcessing;
      invalidateNoteTrackTask(song.id);
      invalidateHeroWaveformCache(song);
      persistProcessingUpdate(song);
      if (state.selectedSongId === song.id) {
        invalidateRecLoad();
        rec.buffer = null;
        rec.bufferId = null;
        rec.mixBuffer = null;
        rec.stems = null;
        rec.hasStems = false;
        await recLoad().catch(() => false);
        await prepareSongNoteTracks(song, { force: true }).catch(() => {});
        updateSelectedSongPanel();
      }
    });
  }

  // Menjanje aktivnog alata klikom na tab čipove
  const toolChips = $("toolChips");
  if (toolChips) {
    toolChips.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (chip) {
        selectTool(chip.dataset.m);
      }
    });
  }

  // Dugmad za transpoziciju (+ i - tasteri tonaliteta)
  const transUp = $("transUp");
  const transDown = $("transDown");
  
  if (transUp) {
    transUp.addEventListener("click", () => {
      state.transpose = Math.min(11, state.transpose + 1);
      afterTranspose();
    });
  }
  if (transDown) {
    transDown.addEventListener("click", () => {
      state.transpose = Math.max(-11, state.transpose - 1);
      afterTranspose();
    });
  }

  function afterTranspose() {
    updateToneCard();
    if (["akordi", "chart", "skale", "vezba", "krug"].includes(state.tool)) {
      renderTool();
    }
    renderMiniChart();
    recRetune();
  }

  const updateSideTransDisplay = () => {
    if (sideTransVal) {
      sideTransVal.textContent = state.transpose > 0 ? "+" + state.transpose : (state.transpose < 0 ? String(state.transpose) : "+/-0");
    }
  };

  const changeSideTranspose = (delta) => {
    state.transpose = clamp(state.transpose + delta, -11, 11);
    afterTranspose();
    updateSideTransDisplay();
  };

  if (sideTransUp) sideTransUp.addEventListener("click", () => changeSideTranspose(1));
  if (sideTransDown) sideTransDown.addEventListener("click", () => changeSideTranspose(-1));

  if (recSpeedSelect) {
    recSpeedSelect.value = String(state.playbackRate);
    recSpeedSelect.addEventListener("change", () => {
      state.playbackRate = clamp(Number(recSpeedSelect.value) || 1, 0.25, 1.5);
      savePlayerSettings();
      recRetune();
      updateRecordedPlaybackControls();
    });
  }

  if (recSeeker) {
    recSeeker.addEventListener("input", () => {
      const t = setChartEditCursorTime(recSeeker.value);
      syncSeekUi(t);
    });
    recSeeker.addEventListener("change", () => {
      seekSelectedPlaybackTo(recSeeker.value);
    });
  }

  if (showFingeringToggle) {
    showFingeringToggle.checked = state.showFingering;
    showFingeringToggle.addEventListener("change", () => {
      state.showFingering = showFingeringToggle.checked;
      patchUiPreferences({ showFingering: state.showFingering });
      if (!state.showFingering) clearMelodyFingeringBadges();
      if (state.practiceModeActive) highlightPracticeChord();
    });
  }

  const compingPatternSelect = $("compingPatternSelect");
  if (compingPatternSelect) {
    compingPatternSelect.value = state.compingPattern || "";
    compingPatternSelect.addEventListener("change", () => {
      state.compingPattern = compingPatternSelect.value || "";
      patchUiPreferences({ compingPattern: state.compingPattern });
      refreshGuidedPlayback({ force: true });
    });
  }

  if (showBeatGridToggle) {
    showBeatGridToggle.checked = state.showBeatGrid !== false;
    showBeatGridToggle.addEventListener("change", () => {
      state.showBeatGrid = showBeatGridToggle.checked;
      patchUiPreferences({ showBeatGrid: state.showBeatGrid });
      refreshBeatGridOverlay();
    });
  }

  if (trackMelodyToggle) {
    trackMelodyToggle.checked = state.trackMelody;
    trackMelodyToggle.addEventListener("change", () => {
      state.trackMelody = trackMelodyToggle.checked;
      state.melodyPianoEnabled = state.trackMelody;
      const pianoToggle = $("melodyPianoToggle");
      if (pianoToggle) pianoToggle.checked = state.melodyPianoEnabled;
      patchUiPreferences({ melodyPianoEnabled: state.melodyPianoEnabled });
      if (!state.trackMelody) {
        clearTimedNoteTracking();
      } else {
        ensureAudio();
        prepareSongNoteTracks(getSelectedSong()).then((tracks) => {
          if (!tracks[state.melodyTrackSource]?.length) {
            setPipeStatus(noteTrackUnavailableMessage(state.melodyTrackSource));
          }
        });
      }
    });
  }

  const melodyPracticeButton = $("melodyPracticeButton");
  if (melodyPracticeButton) {
    melodyPracticeButton.addEventListener("click", toggleMelodyPractice);
  }

  if (melodySourceSelect) {
    melodySourceSelect.value = state.melodyTrackSource;
    melodySourceSelect.addEventListener("change", () => {
      stopMelodyPractice({ silent: true });
      state.melodyTrackSource = melodySourceSelect.value === "bass" ? "bass" : "melody";
      const pianoSource = $("melodyPianoSource");
      if (pianoSource) pianoSource.value = state.melodyTrackSource;
      patchUiPreferences({ melodyTrackSource: state.melodyTrackSource });
      clearTimedNoteTracking();
      if (state.melodyPianoEnabled) ensureAudio();
      const song = getSelectedSong();
      prepareSongNoteTracks(song).then((tracks) => {
        if (!tracks[state.melodyTrackSource]?.length) {
          setPipeStatus(noteTrackUnavailableMessage(state.melodyTrackSource));
        }
      });
    });
  }
  bindMixerEvents();

  const learnAddChord = $("learnAddChord");
  if (learnAddChord) {
    learnAddChord.addEventListener("click", () => {
      const song = getSelectedSong();
      if (song) openTimelineChordPicker(song, getChordInsertionTime(song));
    });
  }

  const practiceSongButton = $("practiceSongButton");
  if (practiceSongButton) {
    practiceSongButton.addEventListener("click", togglePracticeMode);
  }

  // Render loop za pracenje pesme i bojenje akorda na klavijaturi
  function animLoop() {
    trackPlaybackAndHighlight();
    requestAnimationFrame(animLoop);
  }
  requestAnimationFrame(animLoop);
}

const MIXER_CONTROL_SUFFIXES = ["Bass", "Drums", "Guitar", "Piano", "Vocals", "Other"];

function syncMixerControls() {
  const panel = $("recMixerPanel");
  if (!panel) return;

  const song = getSelectedSong();
  const expectedBufferId = recId();
  const runtimeKnown = Boolean(expectedBufferId && rec.buffer && rec.bufferId === expectedBufferId);
  const available = new Set(
    runtimeKnown && rec.hasStems && rec.stems
      ? Object.entries(rec.stems).filter(([, buffer]) => Boolean(buffer)).map(([name]) => name)
      : []
  );
  const mixerControls = resolveMixerControls(
    normalizedSongNoteTracks(song),
    available.size ? [...available] : (song?.availableStems || [])
  );
  const hasCoreStems = ["bass", "drums", "vocals", "other"].every((name) => available.has(name));
  const localMixSelected = !isHybridYouTubeSong(song) || isLocalSong(song);
  const isLoading = Boolean(localMixSelected && song?.stems && !runtimeKnown);
  const hasRealMixer = localMixSelected && runtimeKnown && hasCoreStems;
  const status = !localMixSelected
    ? "YouTube zvuk"
    : isLoading
    ? "u\u010ditavanje kanala"
    : hasRealMixer
      ? `${available.size} pravih kanala`
      : "originalni master";

  panel.classList.toggle("is-unavailable", !hasRealMixer);
  panel.classList.toggle("is-loading", isLoading);
  panel.dataset.mixerMode = isLoading ? "loading" : hasRealMixer ? "stems" : "master";

  const card = panel.closest(".studio-stems-card");
  const statusElement = card?.querySelector(".studio-panel-title small");
  if (statusElement) statusElement.textContent = status;
  const title = panel.querySelector(".mixer-title");
  if (title) {
    title.textContent = !localMixSelected
      ? "Uključi Naš miks za AI kanale"
      : hasRealMixer
      ? "AI stem mikser"
      : isLoading
        ? "U\u010ditavam AI kanale\u2026"
        : "Kanali nisu dostupni \u2014 svira originalni master";
  }

  mixerControls.forEach(({ suffix, key, label, role, confirmed }) => {
    const channel = state.mixer[key] || { volume: 1, mute: false, solo: false };
    const channelAvailable = hasRealMixer && available.has(key);
    const volInput = $(`mix${suffix}Vol`);
    const muteBtn = $(`mix${suffix}Mute`);
    const soloBtn = $(`mix${suffix}Solo`);
    const row = volInput?.closest(".mixer-channel") || muteBtn?.closest(".mixer-channel");
    if (row) {
      row.dataset.stemKey = key;
      row.dataset.semanticRole = role;
      const labelElement = row.querySelector(".chan-label");
      if (labelElement) labelElement.textContent = label;
      row.title = role === "melody"
        ? confirmed
          ? `${label}: analiza je izabrala odvojeni ${key} stem.`
          : `${label}: izvor nije pouzdano potvrđen; koristi se konzervativni instrumentalni stem.`
        : role === "accompaniment"
          ? `${label}: odvojeni ${key} stem može sadržati i druge instrumentalne delove.`
          : "";
    }
    const unavailableMessage = !localMixSelected
      ? `${label}: uključi Naš miks iznad plejera`
      : isLoading
      ? `${label}: kanal se u\u010ditava`
      : `${label}: odvojeni AI kanal nije dostupan; originalni master ostaje neizmenjen`;

    if (volInput) {
      if (document.activeElement !== volInput) {
        volInput.value = String(Math.round(clamp(Number(channel.volume) || 0, 0, 2) * 100));
      }
      volInput.disabled = !channelAvailable;
      volInput.title = channelAvailable ? `${label} \u2014 ja\u010dina` : unavailableMessage;
      const output = volInput.parentElement?.querySelector(".chan-value");
      if (output) output.value = volInput.value;
    }
    if (muteBtn) {
      muteBtn.disabled = !channelAvailable;
      muteBtn.classList.toggle("on-mute", channelAvailable && Boolean(channel.mute));
      muteBtn.setAttribute("aria-pressed", String(channelAvailable && Boolean(channel.mute)));
      muteBtn.setAttribute("aria-label", `Uti\u0161aj ${label}`);
      muteBtn.title = channelAvailable ? `Uti\u0161aj ${label}` : unavailableMessage;
    }
    if (soloBtn) {
      soloBtn.disabled = !channelAvailable;
      soloBtn.classList.toggle("on-solo", channelAvailable && Boolean(channel.solo));
      soloBtn.setAttribute("aria-pressed", String(channelAvailable && Boolean(channel.solo)));
      soloBtn.setAttribute("aria-label", `Solo ${label}`);
      soloBtn.title = channelAvailable ? `Solo ${label}` : unavailableMessage;
    }
    row?.classList.toggle("is-channel-unavailable", !channelAvailable);
  });
}

function bindMixerEvents() {
  MIXER_CONTROL_SUFFIXES.forEach((chan) => {
    const volInput = $(`mix${chan}Vol`);
    const muteBtn = $(`mix${chan}Mute`);
    const soloBtn = $(`mix${chan}Solo`);
    const resolveKey = () => (
      volInput?.closest(".mixer-channel")
      || muteBtn?.closest(".mixer-channel")
      || soloBtn?.closest(".mixer-channel")
    )?.dataset.stemKey;

    if (volInput) {
      volInput.addEventListener("input", () => {
        const key = resolveKey();
        if (!key || !state.mixer[key]) return;
        state.mixer[key].volume = Number(volInput.value) / 100;
        updateMixerGains();
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener("click", () => {
        if (muteBtn.disabled) return;
        const key = resolveKey();
        if (!key || !state.mixer[key]) return;
        state.mixer[key].mute = !state.mixer[key].mute;
        syncMixerControls();
        updateMixerGains();
      });
    }

    if (soloBtn) {
      soloBtn.addEventListener("click", () => {
        if (soloBtn.disabled) return;
        const key = resolveKey();
        if (!key || !state.mixer[key]) return;
        state.mixer[key].solo = !state.mixer[key].solo;
        syncMixerControls();
        updateMixerGains();
      });
    }
  });

  syncMixerControls();
}

// ---------------- VIRTUELNA KLAVIJATURA ----------------
function renderKeyboard() {
  keyboard.innerHTML = "";
  state.keyElementsByMidi.clear();

  // Full 88-key range: analyzed melody/bass is shown in its detected register
  // instead of being folded into whichever teaching octave happens to fit.
  const LOWEST_MIDI = noteToMidi(9, 0);  // A0 / MIDI 21
  const HIGHEST_MIDI = noteToMidi(0, 8); // C8 / MIDI 108

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

    // Pointer dogadjaji za dirke (tastatura i mis)
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

function noteLabel(midi) {
  return `${NOTE_NAMES[pitchFromMidi(midi)]}${octaveFromMidi(midi)}`;
}

function fitKeyboardToContainer() {
  if (!state.keyboardWhiteCount || !pianoScroll.clientWidth) {
    return;
  }

  const baseWhiteWidth = getBaseWhiteKeyWidth();
  const baseBlackWidth = getBaseBlackKeyWidth();
  const workbenchLayout = app?.classList.contains("workbench-v2");
  const scrollStyle = getComputedStyle(pianoScroll);
  const horizontalPadding = (Number.parseFloat(scrollStyle.paddingLeft) || 0) + (Number.parseFloat(scrollStyle.paddingRight) || 0);
  const availableWidth = Math.max(1, pianoScroll.clientWidth - horizontalPadding);
  const fittedWhiteWidth = workbenchLayout
    ? Math.max(16, availableWidth / state.keyboardWhiteCount)
    : Math.max(baseWhiteWidth, availableWidth / state.keyboardWhiteCount);
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

function scrollToBaseOctave(smooth) {
  const targetMidi = noteToMidi(0, Math.max(2, state.baseOctave - 1));
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

function changeOctave(direction) {
  const next = clamp(state.baseOctave + direction, 2, 6);
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

function updateOctaveControls() {
  octaveDisplay.value = `Oktava: ${state.baseOctave}`;
  octaveDown.disabled = state.baseOctave <= 2;
  octaveUp.disabled = state.baseOctave >= 6;
}

function focusAppSoon() {
  requestAnimationFrame(() => app.focus({ preventScroll: true }));
}

// Pointer event handleri na virtuelnom klaviru
function handlePianoPointerDown(event) {
  event.preventDefault();
  focusAppSoon();
  ensureAudio();

  const key = event.currentTarget;
  const midi = Number(key.dataset.midi);
  try {
    key.setPointerCapture(event.pointerId);
  } catch (error) {}

  const isMouse = event.pointerType === "mouse";

  if (isMouse && state.desktopMouseMode === "chord") {
    state.inputOrder += 1;
    state.heldMouseChordRoots.set(event.pointerId, {
      midi,
      order: state.inputOrder
    });
    
    // Pomocne funkcije iz tastature za postavljanje tonaliteta i dodatnih tonova
    if (state.keyboardLowerOctaves.size > 0 || state.keyboardLowerOctaveLatched) {
      state.keyboardLowerOctaveLatched = true;
      state.keyboardLowerOctaveMemoryKeys.add(pitchFromMidi(midi));
    }
    
    const inversionStep = getHeldKeyboardInversionStep();
    if (inversionStep !== null && inversionStep !== 0) {
      state.keyboardInversionMemory.set(pitchFromMidi(midi), inversionStep);
    }
    
    ["seven", "nine"].forEach((color) => {
      if (state.keyboardChordColors[color]?.size > 0) {
        state.keyboardChordColorLatched[color] = true;
      }
    });
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

function getHeldKeyboardInversionStep() {
  const rootOrder = maxMapValue(state.keyboardInversions.root);
  const leftOrder = maxMapValue(state.keyboardInversions.left);
  const rightOrder = maxMapValue(state.keyboardInversions.right);
  const maxOrder = Math.max(rootOrder, leftOrder, rightOrder);

  if (!maxOrder) return null;
  if (rootOrder === maxOrder) return 0;
  if (leftOrder === maxOrder) return -1;
  return 1;
}

function maxMapValue(map) {
  let max = 0;
  map.forEach((value) => { if (value > max) max = value; });
  return max;
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
  
  if (state.heldBaseKeys.size === 0 && state.heldMouseChordRoots.size === 0) {
    state.keyboardLowerOctaveLatched = false;
    state.keyboardChordColorLatched.seven = false;
    state.keyboardChordColorLatched.nine = false;
  }
  
  recomputeSound();
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

function updateLabelVisibility() {
  app.classList.toggle("hide-labels", !state.labelsVisible);
}

function updateSustainLengthDisplay() {
  sustainLengthDisplay.value = Number.isFinite(state.sustainLength)
    ? `${state.sustainLength.toFixed(1)}s`
    : "∞";
}

function updateDoubleTapSharpDisplay() {
  doubleTapSharpDisplay.value = `${state.doubleTapSharpMs}ms`;
}

function updateManualInversionDisplay() {
  if (!manualInversionDisplay) return;
  const step = clamp(Math.round(Number(state.manualInversionStep) || 0), -6, 6);
  manualInversionDisplay.value = step === 0 ? "Osnovni" : (step > 0 ? "+" : "") + step + " obrt";
}

function setManualInversionStep(nextStep) {
  state.manualInversionStep = clamp(Math.round(Number(nextStep) || 0), -6, 6);
  // An explicit panel choice becomes the new default for every manual root.
  // Per-root shortcut memory starts fresh so the UI and the heard voicing agree.
  state.keyboardInversionMemory.clear();
  state.retriggerChordRequested = true;
  updateManualInversionDisplay();
  saveKeyboardSettings();
  recomputeSound();
}

function saveKeyboardSettings() {
  writeJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {
    doubleTapSharpMs: state.doubleTapSharpMs,
    closeVoicingEnabled: state.closeVoicingEnabled,
    dugmetaraRows: state.dugmetaraRows,
    labelsVisible: state.labelsVisible,
    manualInversionStep: state.manualInversionStep,
    manualChordExtension: state.manualChordExtension,
    extensionVoicing: state.extensionVoicing,
    omitExtensionRootEnabled: state.omitExtensionRootEnabled,
    retriggerChordOnChangeEnabled: state.retriggerChordOnChangeEnabled
  });
}

function loadKeyboardSettings() {
  const settings = readJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {});
  state.doubleTapSharpMs = clamp(Number(settings.doubleTapSharpMs) || 90, 30, 250);
  state.closeVoicingEnabled = Boolean(settings.closeVoicingEnabled);
  state.dugmetaraRows = settings.dugmetaraRows === "3" ? "3" : "4";
  state.labelsVisible = settings.labelsVisible !== false;
  state.manualInversionStep = clamp(Math.round(Number(settings.manualInversionStep) || 0), -6, 6);
  state.manualChordExtension = ["seven", "nine"].includes(settings.manualChordExtension)
    ? settings.manualChordExtension
    : "none";
  state.extensionVoicing = settings.extensionVoicing === "left" ? "left" : "upper";
  state.omitExtensionRootEnabled = Boolean(settings.omitExtensionRootEnabled);
  state.retriggerChordOnChangeEnabled = settings.retriggerChordOnChangeEnabled !== false;
  
  if (doubleTapSharpControl) {
    doubleTapSharpControl.value = String(state.doubleTapSharpMs);
  }
  if (closeVoicingToggle) {
    closeVoicingToggle.checked = state.closeVoicingEnabled;
  }
  if (labelsToggle) {
    labelsToggle.checked = state.labelsVisible;
  }
  if (omitExtensionRootToggle) {
    omitExtensionRootToggle.checked = state.omitExtensionRootEnabled;
  }
  if (retriggerChordToggle) {
    retriggerChordToggle.checked = state.retriggerChordOnChangeEnabled;
  }
  document.querySelectorAll("input[name='dugmetaraRows']").forEach((input) => {
    input.checked = input.value === state.dugmetaraRows;
  });
  document.querySelectorAll("input[name='manualChordExtension']").forEach((input) => {
    input.checked = input.value === state.manualChordExtension;
  });
  document.querySelectorAll("input[name='extensionVoicing']").forEach((input) => {
    input.checked = input.value === state.extensionVoicing;
  });
  updateManualInversionDisplay();
}

// ---------------- REPERTOAR / PLAYLIST MENADZMENT ----------------
function loadRepertoireState() {
  const playlist = readJsonStorage(REPERTOIRE_STORAGE_KEY, null);
  const data = normalizeRepertoireFileData(playlist || { songs: [] });
  state.activePlaylistName = String(playlist?.name || "");
  state.activePlaylistPath = String(playlist?.path || "");
  state.activePlaylistSha = String(playlist?.sha || "");
  state.repertoire = restoreSongArtwork(playlist, data.songs);

  const settings = readJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {});
  state.youtubeSeekSeconds = clamp(Number(settings.seekSeconds) || 10, 1, 60);
  state.playbackRate = clamp(Number(settings.playbackRate) || 1, 0.25, 1.5);
  if (youtubeSeekSeconds) {
    youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);
  }

  const savedSongId = typeof data.selectedSongId === "string" && data.selectedSongId
    ? data.selectedSongId
    : typeof settings.selectedSongId === "string" ? settings.selectedSongId : null;
  state.selectedSongId = state.repertoire.some((song) => song.id === savedSongId)
    ? savedSongId
    : state.repertoire[0]?.id || null;
  return playlist === null;
}

async function loadBundledFirstRunRepertoire() {
  try {
    const response = await fetch("playlists/feelgood.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Bundled playlist HTTP ${response.status}`);
    const payload = await response.json();
    const data = normalizeRepertoireFileData(payload);
    // Do not overwrite a song the user may have added while the local file was
    // loading. This path runs only when no saved repertoire exists.
    if (state.repertoire.length || state.selectedSongId) return false;

    state.activePlaylistName = data.name || "FeelGood";
    state.activePlaylistPath = "";
    state.activePlaylistSha = "";
    state.repertoire = restoreSongArtwork(payload, data.songs);
    const preferredSongId = "luis-sve-se-osim-tuge-deli";
    state.selectedSongId = state.repertoire.some((song) => song.id === preferredSongId)
      ? preferredSongId
      : state.repertoire.some((song) => song.id === data.selectedSongId)
        ? data.selectedSongId
        : state.repertoire[0]?.id || null;
    state.youtubeSeekSeconds = data.seekSeconds;
    if (youtubeSeekSeconds) youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);

    saveRepertoire({ skipServerSave: true });
    renderRepertoire();
    updatePlaylistMode();
    setYouTubeStatus(`Playlist: ${state.activePlaylistName}`);
    return true;
  } catch (error) {
    console.error("Bundled FeelGood playlist could not be loaded.", error);
    setYouTubeStatus("Pokreni FGR preko POKRENI_FGR.bat fajla.");
    return false;
  }
}

async function restoreBundledLuisChartIfNeeded() {
  const song = state.repertoire.find((item) => item.id === "luis-sve-se-osim-tuge-deli");
  if (!song) return;
  const bundledMixUrl = "Luis - Sve se osim tuge deli - Amol.mp3";
  const addedBundledMix = !song.assets?.mix;
  if (addedBundledMix) {
    song.assets = {
      ...(song.assets || {}),
      mix: { url: bundledMixUrl }
    };
  }
  const badSignature = song?.chords?.slice(0, 5).map((chord) => chord.n).join("|");
  const legacyCore = song?.chords?.slice(0, 9) || [];
  const matchesCore = (names, times) =>
    legacyCore.length >= names.length &&
    legacyCore.slice(0, names.length).map((chord) => chord.n).join("|") === names.join("|") &&
    times.every((time, index) => Math.abs(Number(legacyCore[index]?.t) - time) <= 0.011);
  const hasLegacyDisPassage =
    song?.chords?.length === 64 &&
    matchesCore(
      ["Dm", "Dis", "Gm", "Dis", "Dm", "Dis", "Gm", "Dis", "Dm"],
      [4.8, 7, 10, 11, 14.3, 15.5, 17.3, 19.3, 21]
    );
  // A v118 pre-release repaired only the wrong Dis passage. Recognize that
  // exact generated fingerprint as well so it receives every measured
  // millisecond boundary, without touching a user-authored 63-event chart.
  const hasPartialTimingMigration =
    song?.chords?.length === 63 &&
    matchesCore(
      ["Dm", "Dis", "Gm", "Dm", "Dis", "Gm", "Dis", "Dm"],
      [4.8, 7, 10, 12.3, 15.5, 17.3, 19.3, 21]
    );
  // v123 already had the corrected 63-label order, but its boundaries were
  // still based on the coarse browser pass (notably Gm at 10.000 instead of
  // the isolated-stem attack around 8.754). Match the complete generated chart
  // fingerprint so a user-edited 63-chord chart is never overwritten.
  const hasV123TimingChart =
    song?.chords?.length === 63 &&
    chordChartFingerprint(song.chords) === "f5d64535";

  // Repairs only the exact noisy 129-event beta chart produced during the
  // former extension-heavy analysis. User-authored Luis charts are untouched.
  const hasNoisyBetaChart = song?.chords?.length === 129 && badSignature === "Dis|Bsus4|A7|Dm|Dis";
  if (!hasLegacyDisPassage && !hasPartialTimingMigration && !hasNoisyBetaChart && !hasV123TimingChart) {
    if (addedBundledMix) saveRepertoire({ skipServerSave: true });
    return;
  }

  try {
    const response = await fetch("playlists/feelgood.json", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const canonical = (Array.isArray(payload?.songs) ? payload.songs : [])
      .find((item) => item?.id === song.id);
    const chords = Array.isArray(canonical?.chords)
      ? canonical.chords
          .map((chord) => ({
            t: Math.max(0, Math.round((Number(chord?.t) || 0) * 1000) / 1000),
            n: String(chord?.n || "").trim()
          }))
          .filter((chord) => chord.n)
          .sort((first, second) => first.t - second.t)
      : [];
    if (chords.length !== 63) throw new Error("Bundled Luis chart is incomplete.");

    song.chords = chords;
    song.chordChartRevision = Math.max(2, Number(canonical?.chordChartRevision) || 0);
    saveRepertoire({ skipServerSave: true });
    renderCompactSongList();
    if (state.selectedSongId === song.id) {
      updateSelectedSongPanel();
      setPipeStatus("Luisov chart je usklađen sa basom i preciznim granicama akorda.");
    }
  } catch {
    // Keep the central musical correction available offline. On the next
    // online load the resulting 63-event fingerprint is upgraded in full.
    if (hasLegacyDisPassage) {
      song.chords.splice(3, 2, { t: 12.3, n: "Dm" });
      saveRepertoire({ skipServerSave: true });
      renderCompactSongList();
      if (state.selectedSongId === song.id) updateSelectedSongPanel();
    }
  }
}

const ARTWORK_DATA_URL_LIMIT = 90000;

function sanitizeArtworkDataUrl(value) {
  const artwork = typeof value === "string" ? value.trim() : "";
  if (!artwork || artwork.length > ARTWORK_DATA_URL_LIMIT) return "";
  return /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(artwork)
    ? artwork
    : "";
}

function getRawPlaylistSongs(rawData) {
  return Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.songs) ? rawData.songs : [];
}

function restoreSongArtwork(rawData, normalizedSongs) {
  const rawSongs = getRawPlaylistSongs(rawData);
  const byId = new Map(rawSongs.map((song) => [String(song?.id || ""), song]));
  return normalizedSongs.map((song, index) => {
    const rawSong = byId.get(song.id) || rawSongs[index];
    const artwork = sanitizeArtworkDataUrl(rawSong?.artwork);
    return artwork ? { ...song, artwork } : song;
  });
}

function buildRepertoireFileDataWithArtwork() {
  const data = buildRepertoireFileData();
  const runtimeSongs = new Map(state.repertoire.map((song) => [String(song.id), song]));
  data.songs = data.songs.map((song) => {
    const artwork = sanitizeArtworkDataUrl(runtimeSongs.get(String(song.id))?.artwork);
    return artwork ? { ...song, artwork } : song;
  });
  return data;
}

function saveRepertoire(options = {}) {
  writeJsonStorage(REPERTOIRE_STORAGE_KEY, {
    name: state.activePlaylistName,
    path: state.activePlaylistPath,
    sha: state.activePlaylistSha,
    ...buildRepertoireFileDataWithArtwork()
  });
  savePlayerSettings();
  if (!options.skipFileSave && !options.skipServerSave) {
    scheduleServerPlaylistSave();
  }
}

function savePlayerSettings() {
  writeJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {
    selectedSongId: state.selectedSongId,
    seekSeconds: state.youtubeSeekSeconds,
    playbackRate: state.playbackRate
  });
}

function scheduleServerPlaylistSave(delay = 700) {
  if (!state.activePlaylistPath) return;
  if (state.playlistSaveTimer) {
    window.clearTimeout(state.playlistSaveTimer);
  }
  state.playlistSaveTimer = window.setTimeout(() => {
    state.playlistSaveTimer = null;
    saveActivePlaylistToServer();
  }, delay);
}

async function saveActivePlaylistToServer(options = {}) {
  if (!state.activePlaylistPath) return;
  if (state.playlistSaveInFlight) {
    state.playlistDirtyAfterSave = true;
    return;
  }

  state.playlistSaveInFlight = true;
  state.playlistDirtyAfterSave = false;
  setYouTubeStatus("Cuvanje playliste");

  try {
    await saveLocalPlaylist(state.activePlaylistPath, buildRepertoireFileDataWithArtwork());
    saveRepertoire({ skipServerSave: true });
    setYouTubeStatus("Playlist sacuvana");
  } catch (_error) {
    // Writing to a file on this machine either works or the service is down;
    // there is no remote revision to reconcile any more.
    setYouTubeStatus("Playlist nije sacuvana — proveri da li servis radi");
  } finally {
    state.playlistSaveInFlight = false;
    if (state.playlistDirtyAfterSave) {
      scheduleServerPlaylistSave(150);
    }
  }
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
    state.availablePlaylists = await fetchLocalPlaylists();
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
    const rawData = await loadLocalPlaylist(playlist.slug || playlistSlug(playlist.name));
    const data = normalizeRepertoireFileData(rawData);

    // Primeni playlistu
    state.activePlaylistName = data.name || playlist.name;
    state.activePlaylistPath = playlist.slug || playlistSlug(playlist.name);
    state.activePlaylistSha = "";
    state.repertoire = restoreSongArtwork(rawData, data.songs);
    state.selectedSongId = state.repertoire.some((song) => song.id === data.selectedSongId)
      ? data.selectedSongId
      : state.repertoire[0]?.id || null;
    state.youtubeSeekSeconds = data.seekSeconds;
    if (youtubeSeekSeconds) {
      youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);
    }

    saveRepertoire({ skipFileSave: true });
    // Reloading the same playlist can replace every song object while keeping
    // the same selected id. Force exactly one real song-change notification.
    if (state.selectedSongId) invalidateNoteTrackTask(state.selectedSongId);
    resolvedNoteTrackSongId = "";
    lastSongChangeSelectionKey = null;
    renderRepertoire();
    updateSelectedSongPanel();
    updateYouTubeSeekButtons();
    updatePlaylistMode();
    setYouTubeStatus(`Playlist: ${state.activePlaylistName}`);
    closePlaylistBrowser();
    // Loading a playlist replaces the repertoire wholesale, which drops any
    // song adopted from the service at startup. Songs the service has
    // separated and analysed must survive that, or they become unreachable
    // again the moment a playlist is opened.
    adoptServiceLibrary();
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
    <button class="text-button primary-button" type="submit">Napravi</button>
  `;
  playlistBrowser.append(form);

  form.querySelector("#newPlaylistNameInput").focus();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    createNewPlaylistOnServer(form.querySelector("#newPlaylistNameInput").value);
  });
}

async function createNewPlaylistOnServer(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return;

  const path = playlistSlug(normalizedName);
  if (!path) {
    setYouTubeStatus("Ime playliste nije upotrebljivo");
    return;
  }
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
    await saveLocalPlaylist(path, data);
    state.activePlaylistName = normalizedName;
    state.activePlaylistPath = path;
    state.activePlaylistSha = "";
    state.repertoire = [];
    state.selectedSongId = null;
    saveRepertoire({ skipServerSave: true });
    renderRepertoire();
    updateSelectedSongPanel();
    updatePlaylistMode();
    closePlaylistBrowser();
    setYouTubeStatus(`Playlist napravljena: ${normalizedName}`);
  } catch (error) {
    setYouTubeStatus("Playlist nije napravljena — proveri da li servis radi");
  }
}

function writeSessionValue(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch {}
}

function bindSongSourceControls() {
  const tabs = [...document.querySelectorAll("[data-song-source]")];
  const fileInput = $("songFileInput");
  const fileButton = $("songFileButton");
  if (fileInput) fileInput.accept = AUDIO_IMPORT_ACCEPT;
  if (!tabs.length || tabs[0].dataset.bound === "true") return;
  tabs[0].dataset.bound = "true";

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setSongSourceMode(tab.dataset.songSource));
  });
  if (fileButton && fileInput) fileButton.addEventListener("click", () => fileInput.click());
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0] || null;
      selectedSongFile = file;
      const fileName = $("songFileName");
      if (!file) {
        if (fileName) fileName.textContent = "MP3, WAV, FLAC, M4A ili AIFF · do 512 MB";
        return;
      }
      const validation = validateImportedAudioFile(file);
      if (!validation.valid) {
        selectedSongFile = null;
        if (fileName) fileName.textContent = validation.message;
        setUploadStatus(validation.message, true);
        return;
      }
      const parsed = parseImportedAudioFilename(file.name);
      if (!songTitleInput.value.trim()) songTitleInput.value = parsed.title;
      if (!songKeyInput.value.trim() && parsed.key) songKeyInput.value = parsed.key;
      if (fileName) fileName.textContent = `${file.name} · ${formatBytes(file.size)}`;
      setUploadStatus("");
    });
  }
  setSongSourceMode("youtube");
}

function setSongSourceMode(mode) {
  songSourceMode = mode === "mp3" ? "mp3" : "youtube";
  document.querySelectorAll("[data-song-source]").forEach((tab) => {
    const active = tab.dataset.songSource === songSourceMode;
    tab.classList.toggle("on", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  const youtubePanel = $("youtubeSourcePanel");
  const mp3Panel = $("mp3SourcePanel");
  if (youtubePanel) youtubePanel.hidden = songSourceMode !== "youtube";
  if (mp3Panel) mp3Panel.hidden = songSourceMode !== "mp3";
  if (addSongButton) addSongButton.textContent = songSourceMode === "mp3" ? "Uvezi i obradi" : "Dodaj u repertoar";
}

async function addSongFromInputs() {
  if (songSourceMode === "mp3") {
    await addMp3SongFromInputs();
    return;
  }

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
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || `YouTube ${videoId}`,
    key,
    url,
    videoId,
    source: { type: "youtube" },
    chords: [],
    stems: false,
    processing: createProcessingStatus(
      "queued",
      "source",
      "Čeka preuzimanje i AI obradu povezanog izvora."
    )
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

async function addMp3SongFromInputs() {
  const file = selectedSongFile;
  const validation = validateImportedAudioFile(file);
  if (!validation.valid) {
    setUploadStatus(validation.message, true);
    $("songFileButton")?.focus();
    return;
  }

  const parsed = parseImportedAudioFilename(file.name);
  const title = songTitleInput.value.trim() || parsed.title;
  const key = songKeyInput.value.trim() || parsed.key;
  const songId = createUniqueSongId(title);
  const [duration, artwork] = await Promise.all([
    readAudioDuration(file).catch(() => 0),
    extractEmbeddedArtwork(file).catch(() => "")
  ]);
  const song = {
    id: songId,
    title,
    key,
    url: "",
    videoId: "",
    source: {
      type: "upload",
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size
    },
    chords: [],
    stems: false,
    availableStems: [],
    assets: null,
    ...(artwork ? { artwork } : {}),
    processing: createProcessingStatus(
      "needs-service",
      "source",
      "Audio fajl je sačuvan lokalno i čeka AI obradu."
    )
  };

  await dbPut({
    id: `song-${song.id}`,
    blob: file,
    dur: duration,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    at: Date.now()
  });

  state.repertoire.push(song);
  state.selectedSongId = song.id;
  resetSongInputs();
  saveRepertoire({ skipServerSave: true });
  renderRepertoire();
  updateSelectedSongPanel();
  await recLoad().catch(() => false);
  updateRecRow();
  setUploadStatus(`${importedAudioBadge(file)} je sačuvan. Pokrećem automatsku AI obradu…`);
  setYouTubeStatus(`${importedAudioBadge(file)} uvezen`);
  await processImportedSong(song, file, { autoAnalyze: true });
}

async function processImportedSong(song, file, options = {}) {
  if (!song) return false;
  const existing = processingTasks.get(song.id);
  if (existing) return existing;
  const task = processImportedSongInternal(song, file, options);
  processingTasks.set(song.id, task);
  try {
    return await task;
  } finally {
    if (processingTasks.get(song.id) === task) processingTasks.delete(song.id);
  }
}

async function processImportedSongInternal(song, file, options = {}) {
  if (!song || !processingClient) return false;
  const stored = file ? null : await dbGet(`song-${song.id}`);
  let localFile = file || stored?.blob;
  if (localFile && !localFile.name && typeof File === "function") {
    localFile = new File(
      [localFile],
      stored?.name || `${song.id}.${stored?.mime === "audio/wav" ? "wav" : "mp3"}`,
      {
        type: stored?.mime || localFile.type || "application/octet-stream",
        lastModified: Number(stored?.at) || Date.now()
      }
    );
  }
  const reusableSource = options.reuseExistingSource ? reusableProcessingSource(song) : null;
  if (!localFile && !reusableSource) {
    song.processing = createProcessingStatus("failed", "source", "Lokalni audio fajl više nije dostupan.");
    persistProcessingUpdate(song);
    return false;
  }
  const sourceMetadata = options.sourceMetadata || (
    options.sourceKind === "youtube-capture" || (song.videoId && song.localCapture?.available)
    ? createYouTubeCaptureMetadata({
        videoId: song.videoId,
        videoUrl: song.url,
        title: song.title,
        capturedAt: song.localCapture?.capturedAt,
        videoOffsetSeconds: song.localCapture?.videoOffsetSeconds
      }, null, Number(song.localCapture?.bitDepth) || 24)
    : null);

  const previousPoll = processingPolls.get(song.id);
  if (previousPoll?.cancel) previousPoll.cancel("new-processing-request");
  if (previousPoll) processingPolls.delete(song.id);
  song.processing = createProcessingStatus(
    "queued",
    "source",
    reusableSource
      ? "Pokrećem novu obradu nad postojećim serverskim audio izvorom."
      : "Šaljem audio na processing servis."
  );
  persistProcessingUpdate(song);
  let ownedPoll = null;

  try {
    const run = await beginProcessingRun(processingClient, song.id, {
      currentSource: reusableSource,
      file: localFile,
      processOptions: {
        freshAnalysis: options.replaceWithAiCandidate === true || options.freshAnalysis === true
      },
      uploadOptions: {
        uploadMode: "direct",
        ...(sourceMetadata ? { sourceMetadata } : {}),
        onProgress: ({ percent }) => {
          const overallPercent = Math.max(0, Math.min(5, Math.round((Number(percent) || 0) * 0.05)));
          song.processing = {
            ...song.processing,
            percent: overallPercent,
            phase: "upload",
            progress: { percent: overallPercent, phase: "upload" },
            message: `Slanje audio fajla ${Math.round(Number(percent) || 0)}%`
          };
          persistProcessingUpdate(song);
          setUploadStatus(`Upload ${percent}%`);
        }
      }
    });
    const { upload, job } = run;
    if (!job && (upload?.needsService || upload?.localOnly || !upload?.uploaded)) {
      song.processing = upload?.processing || createProcessingStatus(
        "needs-service",
        "source",
        "Pokreni: python processing_service.py"
      );
      persistProcessingUpdate(song);
      setUploadStatus("Audio radi lokalno. Za AI kanale pokreni processing servis.", true);
      return false;
    }
    if (!job) throw new Error("Processing servis nije pokrenuo AI obradu.");
    if (!job.jobId || job.processing.state === "needs-service") {
      song.processing = createProcessingStatus(
        "queued",
        "source",
        "Audio je poslat, ali potvrda AI posla nije stigla. Pokušaj ponovo."
      );
      persistProcessingUpdate(song);
      setUploadStatus(job.processing.message || "Processing servis nije dostupan.", true);
      return false;
    }
    song.processing = mergeProcessingProgress(song.processing, job.processing);
    persistProcessingUpdate(song);
    setUploadStatus(run.reusedSource
      ? "Ponovna AI obrada koristi postojeći lossless izvor."
      : "AI razdvaja kanale…");

    ownedPoll = processingClient.pollProcess(song.id, {
      intervalMs: 1500,
      timeoutMs: 90 * 60 * 1000,
      onUpdate: (update) => {
        song.processing = mergeProcessingProgress(song.processing, update.processing);
        persistProcessingUpdate(song);
        setUploadStatus(update.processing.message || "AI obrada je u toku…");
      }
    });
    processingPolls.set(song.id, ownedPoll);
    const completed = await ownedPoll;
    song.processing = mergeProcessingProgress(song.processing, completed.processing);
    if (completed.processing.state !== "ready") {
      persistProcessingUpdate(song);
      setUploadStatus(completed.processing.message || "AI obrada nije uspela.", true);
      return false;
    }

    return await finalizeImportedProcessing(song, completed, options);
  } catch (error) {
    if (error?.code === "aborted") return false;
    const message = error?.message || "Processing servis nije dostupan.";
    song.processing = song.processing?.state === "ready"
      ? createProcessingStatus("queued", "assets", `AI obrada je završena. Ponovo preuzmi kanale: ${message}`)
      : createProcessingStatus("failed", "source", message);
    persistProcessingUpdate(song);
    setUploadStatus(message, true);
    return false;
  } finally {
    if (ownedPoll && processingPolls.get(song.id) === ownedPoll) processingPolls.delete(song.id);
  }
}

async function resumeImportedProcessing(song, options = {}) {
  if (!song) return false;
  const existing = processingTasks.get(song.id);
  if (existing) return existing;
  const task = resumeImportedProcessingInternal(song, options);
  processingTasks.set(song.id, task);
  try {
    return await task;
  } finally {
    if (processingTasks.get(song.id) === task) processingTasks.delete(song.id);
  }
}

async function syncCompletedImportedProcessing(song) {
  // Deliberately not gated on hasLocalSongAudio(). That check infers whether a
  // song is local from flags a completed job sets, so a song whose job was
  // never collected fails it — which is exactly the song that needs repairing.
  // The service is the authority: if it reports a finished job for this id,
  // its result belongs to this song. An unknown song 404s and we do nothing.
  if (!song || !processingClient || song.chordPatchDirty) return false;
  const existing = processingTasks.get(song.id);
  if (existing) return existing;
  const task = (async () => {
    try {
      const current = await processingClient.getProcess(song.id, { strict: true });
      if (
        current.processing.state !== "ready"
        || !current.jobId
        || current.jobId === song.serviceJobId
        || song.chordPatchDirty
      ) return false;
      return await finalizeImportedProcessing(song, current, { autoAnalyze: false });
    } catch (_error) {
      // This is an opportunistic refresh of a locally usable song. An offline
      // service must not downgrade its ready status or hide retained assets.
      return false;
    }
  })();
  processingTasks.set(song.id, task);
  try {
    return await task;
  } finally {
    if (processingTasks.get(song.id) === task) processingTasks.delete(song.id);
  }
}

async function resumeImportedProcessingInternal(song, options = {}) {
  if (!song || !hasLocalSongAudio(song) || !processingClient) return false;
  const previousProcessing = song.processing;

  setUploadStatus(song.processing?.message || "Nastavljam praćenje AI obrade…");
  let ownedPoll = null;

  try {
    let current = await processingClient.getProcess(song.id, { strict: true });
    if (!current.jobId && current.processing.state === "queued") {
      song.processing = createProcessingStatus(
        "needs-service",
        "source",
        "Obrada nije pronađena na servisu. Klikni AI stemovi za novi pokušaj."
      );
      persistProcessingUpdate(song);
      return false;
    }

    song.processing = mergeProcessingProgress(song.processing, current.processing);
    persistProcessingUpdate(song);
    if (!["ready", "failed", "needs-service"].includes(current.processing.state)) {
      ownedPoll = processingClient.pollProcess(song.id, {
        intervalMs: 1500,
        timeoutMs: 90 * 60 * 1000,
        onUpdate: (update) => {
          song.processing = mergeProcessingProgress(song.processing, update.processing);
          persistProcessingUpdate(song);
          setUploadStatus(update.processing.message || "AI obrada je u toku…");
        }
      });
      processingPolls.set(song.id, ownedPoll);
      current = await ownedPoll;
    }

    if (current.processing.state !== "ready") {
      song.processing = mergeProcessingProgress(song.processing, current.processing);
      persistProcessingUpdate(song);
      setUploadStatus(current.processing.message || "AI obrada nije uspela.", true);
      return false;
    }
    return await finalizeImportedProcessing(song, current, options);
  } catch (error) {
    if (error?.code === "aborted") return false;
    const message = error?.message || "Processing servis nije dostupan.";
    song.processing = song.processing?.state === "ready"
      ? createProcessingStatus("queued", "assets", `AI obrada je završena. Ponovo preuzmi kanale: ${message}`)
      : error?.retryable
        ? createProcessingStatus(
            "queued",
            previousProcessing?.stage || "source",
            `Veza sa servisom je prekinuta; AI posao je sačuvan. Pokušaj ponovo: ${message}`
          )
        : createProcessingStatus("failed", previousProcessing?.stage || "source", message);
    persistProcessingUpdate(song);
    setUploadStatus(message, true);
    return false;
  } finally {
    if (ownedPoll && processingPolls.get(song.id) === ownedPoll) processingPolls.delete(song.id);
  }
}

async function finalizeImportedProcessing(song, completed, options = {}) {
  const assets = await processingClient.fetchAssets(song.id);
  const normalizeProcessedChords = (chords) => Array.isArray(chords)
    ? chords
        .map((chord) => ({
          t: Math.max(0, Math.round((Number(chord?.t) || 0) * 1000) / 1000),
          n: String(chord?.n || "").trim()
        }))
        .filter((chord) => chord.n)
        .sort((first, second) => first.t - second.t)
    : [];
  const rawServiceChords = normalizeProcessedChords(assets.chords);
  const aiCandidateChords = normalizeProcessedChords(assets.aiCandidateChords);
  if (options.replaceWithAiCandidate === true && !aiCandidateChords.length) {
    throw new Error("Nova AI obrada nije vratila pouzdan chart; prethodni akordi su sačuvani.");
  }
  // The processing worker analyses the canonical aligned WAV and is the only
  // automatic authority. Never replace it with the lower-resolution browser
  // analyser after a long-running separation job.
  // An explicit retry is the user's request for a new automatic answer, so it
  // must not silently keep an older manually protected service chart.
  const serviceChords = options.replaceWithAiCandidate === true
    ? aiCandidateChords
    : rawServiceChords.length ? rawServiceChords : aiCandidateChords;
  const nextAssets = {
    mix: assets.mix || null,
    stems: assets.stems || {},
    noteTracks: assets.noteTracks || {},
    beatGrid: assets.beatGrid || null
  };
  const nextAvailableStems = assets.availableStems || Object.keys(assets.stems || {});
  if (!nextAvailableStems.length) throw new Error("Processing servis nije vratio nijedan AI kanal.");

  song.assets = nextAssets;
  song.noteTracks = nextAssets.noteTracks;
  song.beatGrid = nextAssets.beatGrid;
  if (song.id === getSelectedSong()?.id) refreshBeatGridOverlay();
  song.availableStems = nextAvailableStems;
  song.stems = true;
  if (song.videoId) {
    song.localCapture = {
      ...(song.localCapture || {}),
      available: true,
      format: song.localCapture?.format || "wav"
    };
    if (typeof song.localMixEnabled !== "boolean") song.localMixEnabled = true;
  }
  song.chords = serviceChords;
  if (options.replaceWithAiCandidate === true) {
    delete song.chordEndTime;
    song.chordPatchDirty = false;
    song.chordPatchError = "";
    const stalePatchQueue = chordPatchQueues.get(song.id);
    if (stalePatchQueue) {
      stalePatchQueue.pending = null;
      if (stalePatchQueue.retryTimer) window.clearTimeout(stalePatchQueue.retryTimer);
      stalePatchQueue.retryTimer = 0;
      if (!stalePatchQueue.running) chordPatchQueues.delete(song.id);
    }
  } else {
    reconcileSongChordEndTime(song);
  }
  delete song.chordTimingOffsetSeconds;
  song.chordTimeBase = assets.chordTimeBase || "mix-seconds";
  song.chordSourceSha256 = assets.chordSourceSha256 || null;
  song.chordProvenance = assets.chordProvenance || null;
  song.serviceChordRevision = Math.max(0, Number(assets.chordRevision) || 0);
  song.serviceJobId = completed?.jobId || song.serviceJobId || "";
  song.processing = assets.processing || completed.processing;
  invalidateNoteTrackTask(song.id);
  invalidateHeroWaveformCache(song);
  persistProcessingUpdate(song);

  if (state.selectedSongId === song.id) {
    invalidateRecLoad();
    rec.buffer = null;
    rec.bufferId = null;
    rec.mixBuffer = null;
    rec.stems = null;
    rec.hasStems = false;
    await recLoad();
    updateRecRow();
    await prepareSongNoteTracks(song, { force: true });
    await refreshHeroWaveform(song);
    updateSelectedSongPanel();
    renderMiniChart();
    if (state.tool === "chart") renderTool();
  }
  setUploadStatus(
    serviceChords.length
      ? `Spremno: ${song.availableStems.length} AI kanala i ${serviceChords.length} precizno tempiranih akorda.`
      : `Spremno: ${song.availableStems.length} AI kanala.`
  );

  if (!serviceChords.length) {
    setPipeStatus("AI kanali su spremni, ali server nije vratio pouzdan chart. Pokreni obradu ponovo.");
  }
  return true;
}

function persistProcessingUpdate(song) {
  saveRepertoire({ skipServerSave: true });
  renderCompactSongList();
  refreshPipe();
  updateRecRow();
}

const chordPatchQueues = new Map();

function scheduleChordPatchRetry(songId, queue) {
  if (queue.retryTimer) return;
  const delay = Math.min(30000, 1500 * (2 ** Math.min(4, queue.retryCount || 0)));
  queue.retryTimer = window.setTimeout(() => {
    queue.retryTimer = 0;
    const song = state.repertoire.find((entry) => entry.id === songId);
    if (!song) {
      chordPatchQueues.delete(songId);
      return;
    }
    patchSongChordsOnService(song, { origin: queue.pending?.origin });
  }, delay);
}

function patchSongChordsOnService(song, options = {}) {
  if (!hasLocalSongAudio(song) || !processingClient || !Array.isArray(song.chords)) return;
  const songId = song.id;
  song.chordPatchDirty = true;
  song.chordPatchError = "Sinhronizacija akorda je u toku.";
  saveRepertoire({ skipServerSave: true });
  let queue = chordPatchQueues.get(songId);
  if (!queue) {
    queue = { running: false, pending: null, retryTimer: 0, retryCount: 0 };
    chordPatchQueues.set(songId, queue);
  }
  if (queue.retryTimer) {
    window.clearTimeout(queue.retryTimer);
    queue.retryTimer = 0;
  }

  // Dragging a boundary can produce several saves close together. Keep only
  // the newest complete chart, but never start it before the previous PATCH
  // finishes; otherwise an older request can arrive last and undo the edit.
  queue.pending = {
    chords: song.chords.map((chord) => ({ t: Number(chord.t) || 0, n: String(chord.n || "") })),
    origin: options.origin === "browser-analysis" ? "browser-analysis" : "manual-edit"
  };
  if (queue.running) return;
  queue.running = true;

  const drain = async () => {
    while (queue.pending) {
      const pending = queue.pending;
      const chords = pending.chords;
      queue.pending = null;
      try {
        const saved = await processingClient.patchChords(songId, chords, {
          body: { origin: pending.origin }
        });
        const currentSong = state.repertoire.find((entry) => entry.id === songId);
        if (currentSong) {
          currentSong.chordPatchDirty = false;
          currentSong.chordPatchError = "";
          currentSong.serviceChordRevision = Math.max(0, Number(saved?.revision) || 0);
          currentSong.chordTimeBase = saved?.timeBase || currentSong.chordTimeBase || "mix-seconds";
          currentSong.chordSourceSha256 = saved?.sourceSha256 || currentSong.chordSourceSha256 || null;
          currentSong.chordProvenance = saved?.provenance || currentSong.chordProvenance || null;
          saveRepertoire({ skipServerSave: true });
        }
        queue.retryCount = 0;
      } catch (error) {
        if (
          pending.origin === "browser-analysis"
          && ["server_analysis_active", "server_analysis_preferred"].includes(String(error?.code || ""))
        ) {
          const currentSong = state.repertoire.find((entry) => entry.id === songId);
          if (currentSong) {
            currentSong.chordPatchDirty = false;
            currentSong.chordPatchError = "";
            saveRepertoire({ skipServerSave: true });
          }
          queue.pending = null;
          break;
        }
        // Keep the newest complete chart dirty and retry it. Never let a
        // temporary server/network failure silently discard a user's edit.
        if (!queue.pending) queue.pending = pending;
        queue.retryCount = Math.min(8, (queue.retryCount || 0) + 1);
        const currentSong = state.repertoire.find((entry) => entry.id === songId);
        if (currentSong) {
          currentSong.chordPatchDirty = true;
          currentSong.chordPatchError = String(error?.message || "Sinhronizacija akorda ceka ponovni pokusaj.");
          saveRepertoire({ skipServerSave: true });
        }
        scheduleChordPatchRetry(songId, queue);
        break;
      }
    }
  };

  drain().finally(() => {
    queue.running = false;
    if (queue.pending && !queue.retryTimer) {
      patchSongChordsOnService(state.repertoire.find((entry) => entry.id === songId), {
        origin: queue.pending.origin
      });
    } else if (!queue.pending) {
      chordPatchQueues.delete(songId);
    }
  });
}

function resetSongInputs() {
  songTitleInput.value = "";
  songKeyInput.value = "";
  songUrlInput.value = "";
  selectedSongFile = null;
  const input = $("songFileInput");
  if (input) input.value = "";
  const name = $("songFileName");
  if (name) name.textContent = "MP3, WAV, FLAC, M4A ili AIFF · do 512 MB";
}

function setUploadStatus(message, isError = false) {
  const status = $("songUploadStatus");
  if (status) {
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }
}

function createUniqueSongId(title) {
  const base = String(title || "pesma")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "pesma";
  let candidate = base;
  let suffix = 2;
  while (state.repertoire.some((song) => song.id === candidate)) {
    candidate = `${base.slice(0, 58)}-${suffix++}`;
  }
  return candidate.slice(0, 64);
}

function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration) || 0;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Ne mogu da pročitam trajanje audio fajla."));
    };
    audio.src = url;
  });
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function parseYouTubeVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = String(url || "").match(regExp);
  return match && match[2].length === 11 ? match[2] : "";
}

function createProcessingStatus(stateName, stage, message) {
  return {
    state: stateName,
    stage,
    message,
    updatedAt: new Date().toISOString()
  };
}

function renderCompactSongList() {
  const listEl = $("songList");
  if (!listEl) return;
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
    const isSelectedForAction = state.selectedSongsForAction.has(song.id);
    const isInlineEditing = state.inlineEditingSongId === song.id;

    const item = document.createElement("div");
    item.className = "song-item";
    if (song.id === state.selectedSongId) {
      item.classList.add("on");
    }
    if (state.selectionModeActive && isSelectedForAction) {
      item.classList.add("selected-action");
    }
    item.dataset.songId = song.id;

    // Add context menu listener
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (state.inlineEditingSongId) return;
      showSongContextMenu(song.id, event.clientX, event.clientY);
    });

    const main = document.createElement(isInlineEditing ? "div" : "button");
    if (!isInlineEditing) {
      main.type = "button";
    }
    main.className = "song-item-main";
    const chordCount = Array.isArray(song.chords) ? song.chords.length : 0;

    if (isInlineEditing) {
      main.innerHTML =
        '<div class="si-title-edit-wrap"></div><span class="si-key"></span>' +
        '<span class="si-sub">' + (chordCount ? "chart · " + chordCount + " akorada" : "samo link") + "</span>";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "sheet-input inline-title-input";
      input.value = song.title || "";
      input.style.width = "100%";
      input.style.height = "28px";
      input.style.padding = "0 6px";
      input.style.fontSize = "12px";

      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const newTitle = input.value.trim();
          if (newTitle) {
            song.title = newTitle;
            state.inlineEditingSongId = null;
            saveRepertoire();
            renderRepertoire();
            updateSelectedSongPanel();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          state.inlineEditingSongId = null;
          renderCompactSongList();
        }
      });

      input.addEventListener("blur", () => {
        setTimeout(() => {
          if (state.inlineEditingSongId === song.id) {
            const newTitle = input.value.trim();
            if (newTitle) {
              song.title = newTitle;
            }
            state.inlineEditingSongId = null;
            saveRepertoire();
            renderRepertoire();
            updateSelectedSongPanel();
          }
        }, 150);
      });

      main.querySelector(".si-title-edit-wrap").append(input);
      main.querySelector(".si-key").textContent = song.key || "";
      
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      let checkboxHTML = "";
      if (state.selectionModeActive) {
        checkboxHTML = `<input type="checkbox" class="song-select-checkbox" ${isSelectedForAction ? "checked" : ""} style="margin-right: 8px; pointer-events: none;">`;
      }
      
      main.classList.add("has-thumb");
      main.innerHTML =
        checkboxHTML +
        '<span class="si-thumb"><span aria-hidden="true">♫</span></span>' +
        '<span class="si-title"></span><span class="si-key"></span>' +
        '<span class="si-sub"></span>';

      main.querySelector(".si-title").textContent = song.title || "(bez naziva)";
      main.querySelector(".si-key").textContent = song.key || "";
      const thumbnail = main.querySelector(".si-thumb");
      if (thumbnail && song.videoId) {
        const image = document.createElement("img");
        image.src = `https://i.ytimg.com/vi/${encodeURIComponent(song.videoId)}/mqdefault.jpg`;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove(), { once: true });
        thumbnail.append(image);
      }
      const subtitle = main.querySelector(".si-sub");
      if (subtitle) {
        const source = song.source?.type === "upload" || !song.videoId ? "MP3" : "YouTube";
        const processing = String(song.processing?.state || "");
        const details = [];
        if (chordCount) details.push(`${chordCount} akorda`);
        if (song.stems) details.push(`${song.availableStems?.length || 6} kanala`);
        else if (["queued", "downloading", "separating", "analyzing"].includes(processing)) details.push("AI obrada");
        else if (!chordCount) details.push(source === "MP3" ? "lokalno spremno" : "samo link");
        const badge = document.createElement("span");
        badge.className = "si-source";
        badge.textContent = source;
        subtitle.append(badge, document.createTextNode(details.join(" · ")));
      }

      main.addEventListener("click", (event) => {
        if (state.selectionModeActive) {
          event.stopPropagation();
          toggleSongSelection(song.id);
        } else {
          selectSong(song.id);
        }
      });
    }

    if (!state.selectionModeActive && !isInlineEditing) {
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
    } else {
      item.append(main);
    }

    listEl.append(item);
  });
}

function renderRepertoire() {
  const repertoireTableBody = $("repertoireTableBody");
  if (!repertoireTableBody) return;

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
    
    // Drag & Drop
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
      if (!query) return true;
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
  
  const repertoireTableBody = $("repertoireTableBody");
  if (repertoireTableBody) {
    requestAnimationFrame(() => {
      repertoireTableBody.querySelector(`[data-song-id="${firstVisible.song.id}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }
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
  if (!song) return;

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

function updateSelectedSongPanel(options = {}) {
  const song = getSelectedSong();
  const hasVideo = Boolean(song?.videoId);
  const localSource = !hasVideo && hasLocalSongAudio(song);
  const hybridSource = isHybridYouTubeSong(song);
  const usingLocalMix = isLocalSong(song);

  if (selectedSongTitle) selectedSongTitle.value = song?.title || "-";
  if (selectedSongKeyDisplay) selectedSongKeyDisplay.value = song?.key || "";
  const heroSourceBadge = $("heroSourceBadge");
  if (heroSourceBadge) {
    heroSourceBadge.textContent = localSource
      ? importedAudioBadge(song?.source?.name || "")
      : hybridSource && usingLocalMix ? "AI WAV" : "YouTube";
    heroSourceBadge.dataset.source = localSource ? "mp3" : hybridSource && usingLocalMix ? "local-mix" : "youtube";
  }
  const localMixToggle = $("localMixToggle");
  if (localMixToggle) {
    localMixToggle.hidden = !hybridSource;
    localMixToggle.setAttribute("aria-checked", String(usingLocalMix));
    localMixToggle.classList.toggle("is-local", usingLocalMix);
    const label = localMixToggle.querySelector("span");
    if (label) label.textContent = usingLocalMix ? "Naš miks" : "YouTube zvuk";
  }
  const localArtwork = $("localAudioArtwork");
  const localAudioFormat = $("localAudioFormat");
  const youtubePlayerElement = $("youtubePlayer");
  const openExternal = $("youtubeOpenExternal");
  if (localArtwork) localArtwork.hidden = !localSource;
  if (localAudioFormat) localAudioFormat.textContent = importedAudioBadge(song?.source?.name || "");
  if (youtubePlayerElement) youtubePlayerElement.hidden = Boolean(localSource);
  if (openExternal) {
    openExternal.hidden = Boolean(localSource);
    openExternal.disabled = Boolean(localSource);
  }
  updateHeroPlaybackVisuals(getLivePlaybackTime());
  refreshBeatGridOverlay();
  if (song) loadStaticBeatGrid(song);
  refreshHeroWaveform(song).catch(() => setHeroWaveformPath(buildWaveformPath([]), "unavailable"));

  renderCompactSongList();
  if (hybridSource) {
    ensureHybridVideoLoaded(song, { autoplay: false }).catch(() => {});
  }
  const sourceKey = song
    ? `${song.source?.type || (song.videoId ? "youtube" : "local")}:${song.videoId || song.source?.name || ""}`
    : "none";
  const selectionKey = `${state.activePlaylistPath || "local"}::${song?.id || ""}::${sourceKey}`;
  if (
    songChangeListenerReady &&
    (options.forceSongChange === true || selectionKey !== lastSongChangeSelectionKey)
  ) {
    lastSongChangeSelectionKey = selectionKey;
    window.dispatchEvent(new CustomEvent("fgr:songchange", { detail: { song: song || null } }));
  }
}

function getSelectedSong() {
  return state.repertoire.find((song) => song.id === state.selectedSongId) || null;
}

function moveSongBefore(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;

  const sourceIndex = state.repertoire.findIndex((song) => song.id === sourceId);
  const targetIndex = state.repertoire.findIndex((song) => song.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [song] = state.repertoire.splice(sourceIndex, 1);
  const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  state.repertoire.splice(adjustedTarget, 0, song);
  state.selectedSongId = sourceId;
  
  saveRepertoire();
  renderRepertoire();
}

async function adoptServiceLibrary() {
  if (!processingClient?.configured) return false;
  let listed = [];
  try {
    listed = await processingClient.listSongs();
  } catch (_error) {
    // The service is optional. A song already in the repertoire keeps working.
    return false;
  }
  let added = 0;
  for (const entry of listed) {
    const songId = String(entry?.songId || "").trim();
    if (!songId || state.repertoire.some((song) => song.id === songId)) continue;
    if (String(entry?.processing?.state || "") !== "ready") continue;
    const label = String(entry?.sourceName || "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    state.repertoire.push({
      id: songId,
      title: label || songId,
      key: "",
      url: "",
      videoId: "",
      stems: false,
      availableStems: [],
      assets: null,
      noteTracks: {},
      chords: [],
      chordChartRevision: 0,
      source: { type: "upload" },
      processing: {
        state: "ready",
        stage: "complete",
        message: "Obrada je gotova na servisu.",
        updatedAt: entry?.updatedAt || new Date().toISOString()
      }
    });
    added += 1;
  }
  if (!added) return false;
  if (!state.selectedSongId) state.selectedSongId = state.repertoire[0]?.id || null;
  saveRepertoire({ skipServerSave: true });
  renderRepertoire();
  updateSelectedSongPanel();
  // The chart is drawn once at startup, before these songs existed. Without
  // this it stays on whatever it drew for an empty repertoire.
  if (state.tool === "chart") renderTool();
  setPipeStatus(`Vraćeno sa servisa: ${added} ${added === 1 ? "pesma" : "pesme"}.`);
  return true;
}

function deleteSong(songId) {
  const index = state.repertoire.findIndex((song) => song.id === songId);
  if (index < 0) return;
  const removed = state.repertoire[index];

  // Removing a song throws away work that took minutes to produce, and for a
  // recorded song the audio itself cannot be obtained again. Name what is
  // about to go, and ask.
  const chordCount = (removed?.chords || []).length;
  const noteCount = Object.values(removed?.noteTracks || {})
    .reduce((total, track) => total + ((track?.events || []).length), 0);
  const parts = [];
  if (chordCount) parts.push(`${chordCount} akorda`);
  if (noteCount) parts.push(`${noteCount} prepoznatih tonova`);
  if ((removed?.availableStems || []).length) parts.push(`${removed.availableStems.length} razdvojenih kanala`);
  const isRecording = Boolean(removed?.localCapture?.available);
  const warning = isRecording
    ? "\n\nOvo je snimak sa YouTube-a — ako ga obrišeš, snimanje mora ponovo."
    : "";
  const detail = parts.length ? `\n\nGubi se: ${parts.join(", ")}.` : "";
  const confirmed = window.confirm(
    `Obrisati "${removed?.title || songId}" iz repertoara?${detail}${warning}`
      + "\n\nObrada se sklanja u korpu na servisu, pa se može vratiti ručno."
  );
  if (!confirmed) return;
  const poll = processingPolls.get(songId);
  if (poll?.cancel) poll.cancel("song-deleted");
  processingPolls.delete(songId);
  processingTasks.delete(songId);
  invalidateNoteTrackTask(songId);

  state.repertoire.splice(index, 1);
  // Every local master uses the same IndexedDB key, including captured
  // YouTube WAV files whose source type remains "youtube".
  if (removed) dbDelete(`song-${songId}`).catch(() => {});
  processingClient?.deleteSong?.(songId).catch(() => {});
  if (state.selectedSongId === songId) {
    state.selectedSongId = state.repertoire[Math.min(index, state.repertoire.length - 1)]?.id || null;
  }
  
  saveRepertoire();
  renderRepertoire();
  updateSelectedSongPanel();
}

// ---------------- YOUTUBE INTEGRACIJA ----------------
function handleYouTubeShortcut(event) {
  const isPlayerShortcut = event.code === "Backquote" || event.code === "Digit1" || event.code === "Digit2";
  if (!isPlayerShortcut) {
    return false;
  }

  event.preventDefault();
  if (event.type !== "keydown" || event.repeat) {
    return true;
  }

  if (event.code === "Backquote" && isLeftShiftPracticeShortcut(event)) {
    if (event.altKey) {
      seekPracticeRecordingToStart();
    } else {
      togglePracticeMode();
    }
    return true;
  }

  if (event.code === "Backquote") {
    if (event.altKey) {
      seekYouTubeToStart();
    } else {
      triggerSelectedSongToggle();
    }
  } else if (event.code === "Digit1") {
    if (shouldControlRecordedSong()) seekPracticeRecording(-getYouTubeSeekSeconds());
    else seekYouTube(-getYouTubeSeekSeconds());
  } else if (event.code === "Digit2") {
    if (shouldControlRecordedSong()) seekPracticeRecording(getYouTubeSeekSeconds());
    else seekYouTube(getYouTubeSeekSeconds());
  }

  return true;
}

function isLeftShiftPracticeShortcut(event) {
  return Boolean(event.shiftKey && state.keyboardInversions?.right?.has("ShiftLeft"));
}

function shouldControlRecordedSong() {
  return Boolean(state.practiceModeActive || rec.playing);
}

function seekPracticeRecordingToStart() {
  seekRecordedSongTo(0, { startIfActive: state.practiceModeActive || rec.playing, status: "Pocetak vezbe" });
}

function seekPracticeRecording(deltaSeconds) {
  seekRecordedSongTo(deltaSeconds, { relative: true, startIfActive: rec.playing, status: `${deltaSeconds < 0 ? "Nazad" : "Napred"} ${Math.abs(deltaSeconds)}s` });
}

function seekRecordedSongTo(value, options = {}) {
  const song = getSelectedSong();
  if (!song) {
    setPipeStatus("Prvo izaberi pesmu.");
    return;
  }

  recLoad().then((ok) => {
    if (!ok) {
      setPipeStatus("Nema naseg snimka za ovu pesmu.");
      return;
    }
    if (rec.ctx.state === "suspended") rec.ctx.resume();
    const duration = rec.buffer ? rec.buffer.duration : 0;
    const current = rec.playing ? recTime() : rec.offset;
    const target = options.relative
      ? clamp(current + value, 0, Math.max(0, duration - 0.1))
      : clamp(value, 0, Math.max(0, duration - 0.1));

    if (rec.playing || options.startIfActive) {
      recPlayFrom(target);
    } else {
      rec.offset = target;
      updateRecordedPlaybackControls();
      window.dispatchEvent(new CustomEvent("fgr:recupdate"));
    }

    if (state.practiceModeActive) {
      updatePracticeFollowHighlight(true);
    }
    setPipeStatus(options.status || "Snimak pomeren");
  }).catch((err) => {
    setPipeStatus("Greska: " + err.message);
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
    if (!player || typeof player.seekTo !== "function") return;
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
    if (!player || typeof player.getCurrentTime !== "function") return;
    const duration = typeof player.getDuration === "function" ? player.getDuration() : 0;
    const current = player.getCurrentTime() || 0;
    const target = duration > 0
      ? clamp(current + deltaSeconds, 0, Math.max(0, duration - 0.2))
      : Math.max(0, current + deltaSeconds);
    player.seekTo(target, true);
    setYouTubeStatus(`${deltaSeconds < 0 ? "Nazad" : "Napred"} ${Math.abs(deltaSeconds)}s`);
  });
}

function setHybridYouTubeAudioMode(player, useLocalMix) {
  if (!player) return;
  try {
    if (useLocalMix && typeof player.mute === "function") player.mute();
    if (!useLocalMix && typeof player.unMute === "function") player.unMute();
  } catch (_error) {}
}

function getHybridVideoOffset(song) {
  return Math.max(0, Number(song?.localCapture?.videoOffsetSeconds) || 0);
}

function localTimeToHybridVideoTime(song, localTime) {
  return Math.max(0, Number(localTime) || 0) + getHybridVideoOffset(song);
}

function hybridVideoTimeToLocalTime(song, videoTime) {
  return Math.max(0, (Number(videoTime) || 0) - getHybridVideoOffset(song));
}

function ensureHybridVideoLoaded(song, options = {}) {
  if (!song?.videoId) return Promise.resolve(null);
  return ensureYouTubePlayer().then((player) => {
    const alreadyLoaded = state.youtubeLoadedVideoId === song.videoId;
    if (!alreadyLoaded) {
      if (options.autoplay && typeof player.loadVideoById === "function") player.loadVideoById(song.videoId);
      else if (typeof player.cueVideoById === "function") player.cueVideoById(song.videoId);
      state.youtubeLoadedVideoId = song.videoId;
    }
    setHybridYouTubeAudioMode(player, isLocalSong(song));
    return player;
  });
}

async function toggleHybridPlaybackSourceLegacy() {
  const song = getSelectedSong();
  if (!isHybridYouTubeSong(song)) return;

  const wasUsingLocal = isLocalSong(song);
  const wasPlaying = wasUsingLocal ? rec.playing : state.youtubeDesiredPlaying;
  const currentTime = Math.max(0, getLivePlaybackTime());
  song.localMixEnabled = !wasUsingLocal;
  saveRepertoire({ skipServerSave: true });

  const player = await ensureHybridVideoLoaded(song, { autoplay: false }).catch(() => null);
  if (player && typeof player.seekTo === "function") player.seekTo(currentTime, true);

  if (song.localMixEnabled) {
    setHybridYouTubeAudioMode(player, true);
    if (wasPlaying) {
      ensureAudio();
      const loaded = await recLoad().catch(() => false);
      if (loaded && state.selectedSongId === song.id) {
        recPlayFrom(currentTime);
        state.youtubeDesiredPlaying = true;
        if (player && typeof player.playVideo === "function") player.playVideo();
      }
    } else {
      rec.offset = currentTime;
      state.youtubeDesiredPlaying = false;
      if (player && typeof player.pauseVideo === "function") player.pauseVideo();
    }
    setPipeStatus("YouTube video + naš WAV/AI miks.");
  } else {
    if (rec.playing) recStop(true);
    rec.offset = currentTime;
    setHybridYouTubeAudioMode(player, false);
    state.youtubeResumeTime = currentTime;
    state.youtubeDesiredPlaying = wasPlaying;
    if (player) {
      if (wasPlaying && typeof player.playVideo === "function") player.playVideo();
      else if (typeof player.pauseVideo === "function") player.pauseVideo();
    }
    setPipeStatus("Svira originalni YouTube zvuk; AI kanali su privremeno isključeni.");
  }

  updateSelectedSongPanel();
  syncMixerControls();
  updateRepertoirePlaybackButtons();
}

async function toggleHybridPlaybackSource() {
  const song = getSelectedSong();
  if (!isHybridYouTubeSong(song)) return;

  if (hybridSourceSwitchPending) {
    setPipeStatus("Promena izvora je vec u toku...");
    return;
  }
  hybridSourceSwitchPending = true;
  const switchGeneration = ++hybridSourceSwitchGeneration;
  const toggle = $("localMixToggle");
  if (toggle) toggle.disabled = true;

  const wasUsingLocal = isLocalSong(song);
  const wasPlaying = wasUsingLocal ? rec.playing : state.youtubeDesiredPlaying;
  const liveTime = Math.max(0, getLivePlaybackTime());
  const localTime = wasUsingLocal ? liveTime : hybridVideoTimeToLocalTime(song, liveTime);
  const videoTime = wasUsingLocal ? localTimeToHybridVideoTime(song, liveTime) : liveTime;

  try {
    const player = await ensureHybridVideoLoaded(song, { autoplay: false }).catch(() => null);
    if (switchGeneration !== hybridSourceSwitchGeneration || state.selectedSongId !== song.id) return;

    if (!wasUsingLocal) {
      ensureAudio();
      const loaded = await recLoad().catch(() => false);
      if (switchGeneration !== hybridSourceSwitchGeneration || state.selectedSongId !== song.id) return;
      if (!loaded) {
        song.localMixEnabled = false;
        setHybridYouTubeAudioMode(player, false);
        setPipeStatus("Nas WAV/AI miks nije mogao da se ucita; YouTube zvuk ostaje aktivan.");
        return;
      }

      song.localMixEnabled = true;
      saveRepertoire({ skipServerSave: true });
      setHybridYouTubeAudioMode(player, true);
      rec.offset = localTime;
      if (player && typeof player.seekTo === "function") {
        player.seekTo(localTimeToHybridVideoTime(song, localTime), true);
      }
      if (wasPlaying) {
        recPlayFrom(localTime);
        state.youtubeDesiredPlaying = true;
        if (player && typeof player.playVideo === "function") player.playVideo();
      } else {
        state.youtubeDesiredPlaying = false;
        if (player && typeof player.pauseVideo === "function") player.pauseVideo();
      }
      setPipeStatus("YouTube video + nas WAV/AI miks.");
    } else {
      if (rec.playing) recStop(true);
      rec.offset = localTime;
      song.localMixEnabled = false;
      saveRepertoire({ skipServerSave: true });
      setHybridYouTubeAudioMode(player, false);
      state.youtubeResumeTime = videoTime;
      state.youtubeDesiredPlaying = wasPlaying;
      if (player) {
        if (typeof player.seekTo === "function") player.seekTo(videoTime, true);
        if (wasPlaying && typeof player.playVideo === "function") player.playVideo();
        else if (typeof player.pauseVideo === "function") player.pauseVideo();
      }
      setPipeStatus("Svira originalni YouTube zvuk; AI kanali su privremeno iskljuceni.");
    }
  } finally {
    if (switchGeneration === hybridSourceSwitchGeneration) hybridSourceSwitchPending = false;
    if (toggle?.isConnected) toggle.disabled = false;
    updateSelectedSongPanel();
    syncMixerControls();
    updateRepertoirePlaybackButtons();
  }
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

function loadSelectedSong(options = {}) {
  const song = getSelectedSong();
  if (isLocalSong(song)) {
    state.youtubeDesiredPlaying = Boolean(options.autoplay);
    setYouTubeStatus("Učitavam lokalni audio");
    return recLoad().then((ok) => {
      if (!ok) {
        setYouTubeStatus("Lokalni audio nije dostupan");
        return null;
      }
      if (options.autoplay) recPlayFrom(0);
      setYouTubeStatus(song.title || "Audio spreman");
      updateRecRow();
      if (state.tool === "chart") renderTool();
      updateHeroPlaybackVisuals(recTime());
      return rec;
    });
  }
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
      if (!player) return null;
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
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin,
        widget_referrer: window.location.origin
      },
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
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      state.youtubeApiPromise = null;
      reject(new Error("YouTube API nije dostupan"));
    };
    document.head.append(script);
  });

  return state.youtubeApiPromise;
}

function handleYouTubeError(event) {
  state.youtubeDesiredPlaying = false;
  updateRepertoirePlaybackButtons();
  setYouTubeStatus("Embed blokiran - otvori YouTube ili probaj drugi link");
}

function handleYouTubeStateChange(event) {
  const states = window.YT?.PlayerState;
  if (!states) return;

  const isPlayingNow = event.data === states.PLAYING || event.data === states.BUFFERING;
  if (isPlayingNow && !state.youtubeDesiredPlaying) {
    pauseYouTubeNow(event.target);
    return;
  }

  if (event.data === states.ENDED) {
    state.youtubeDesiredPlaying = false;
    state.youtubeResumeTime = 0;
    updateRepertoirePlaybackButtons();
    if (capRec?.state === "recording" && capSongId === state.selectedSongId) {
      setPipeStatus("YouTube je završen. Čuvam WAV i automatski pokrećem analizu…");
      stopCapture();
    }
    return;
  }

  if (
    event.data === states.PLAYING
    && capAwaitingPlayback
    && capRec?.state === "recording"
    && capSongId === state.selectedSongId
  ) {
    capAwaitingPlayback = false;
    capVideoOffsetSeconds = typeof event.target?.getCurrentTime === "function"
      ? Math.max(0, Number(event.target.getCurrentTime()) || 0)
      : 0;
    capRec.markOrigin?.();
    capStart = Date.now();
    setPipeStatus("Snima direktno u 48 kHz PCM... Kad se pesma zavrsi, klikni Zaustavi.");
  }

  updateRepertoirePlaybackButtons();
}

function playYouTubeNow(player) {
  state.youtubeDesiredPlaying = true;
  state.youtubePauseGuardUntil = 0;
  if (state.youtubeResumeTime > 0 && typeof player.seekTo === "function") {
    player.seekTo(state.youtubeResumeTime, true);
  }
  player.playVideo();
  updateRepertoirePlaybackButtons();
}

function pauseYouTubeNow(player) {
  state.youtubeDesiredPlaying = false;
  state.youtubePauseGuardUntil = Date.now() + 60000;
  if (typeof player.pauseVideo === "function") {
    player.pauseVideo();
  }
  updateRepertoirePlaybackButtons();

  if (typeof player.getCurrentTime === "function") {
    const currentTime = Number(player.getCurrentTime()) || 0;
    if (currentTime > 0) {
      state.youtubeResumeTime = currentTime;
    }
  }
}

function triggerSelectedSongToggle() {
  const song = getSelectedSong();
  if (!song) {
    setYouTubeStatus("Dodaj pesmu");
    return;
  }

  toggleSongPlayback(song.id);
}

function hasLocalSongAudio(song) {
  return Boolean(song && (
    song.source?.type === "upload"
    || song.localCapture?.available === true
    || song.stems === true
    || (!song.videoId && (song.assets?.mix || song.source))
  ));
}

function isHybridYouTubeSong(song) {
  return Boolean(song?.videoId && hasLocalSongAudio(song));
}

function isLocalSong(song) {
  if (!hasLocalSongAudio(song)) return false;
  // Imported/local songs always use their local master. A YouTube song with a
  // captured master can deliberately switch between our aligned stem mix and
  // the original YouTube sound while the video remains visible in both modes.
  return !song.videoId || song.localMixEnabled !== false;
}

function toggleLocalSongPlayback(song) {
  if (rec.playing) {
    recStop(true);
    state.youtubeDesiredPlaying = false;
    if (isHybridYouTubeSong(song) && state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
      state.youtubePlayer.pauseVideo();
    }
    setYouTubeStatus("Pauza");
    updateRepertoirePlaybackButtons();
    return;
  }

  // Resume Web Audio synchronously inside the transport gesture. Decoding
  // six stems can outlive the browser's activation window and otherwise
  // leave a visually playing, but silent, transport on the first click.
  ensureAudio();
  setYouTubeStatus("Učitavam lokalni audio");
  recLoad().then((ok) => {
    if (!ok || state.selectedSongId !== song.id) {
      setYouTubeStatus("Lokalni audio nije dostupan");
      return;
    }
    if (rec.ctx?.state === "suspended") rec.ctx.resume();
    state.youtubeDesiredPlaying = true;
    recPlayFrom(rec.offset || 0);
    if (isHybridYouTubeSong(song)) {
      ensureHybridVideoLoaded(song, { autoplay: false }).then((player) => {
        if (!player || state.selectedSongId !== song.id || !rec.playing) return;
        setHybridYouTubeAudioMode(player, true);
        if (typeof player.seekTo === "function") player.seekTo(localTimeToHybridVideoTime(song, recTime()), true);
        if (typeof player.playVideo === "function") player.playVideo();
      }).catch(() => {});
    } else if (state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
      state.youtubePlayer.pauseVideo();
    }
    setYouTubeStatus(song.title || "Pusti");
    updateRepertoirePlaybackButtons();
  }).catch((error) => setYouTubeStatus(error?.message || "Lokalni audio nije dostupan"));
}

function seekSelectedPlaybackBy(deltaSeconds) {
  const song = getSelectedSong();
  if (isLocalSong(song)) {
    const target = Math.max(0, recTime() + Number(deltaSeconds || 0));
    recSeek(target);
    if (isHybridYouTubeSong(song)) {
      ensureHybridVideoLoaded(song, { autoplay: false }).then((player) => {
        if (player && typeof player.seekTo === "function") player.seekTo(localTimeToHybridVideoTime(song, target), true);
      }).catch(() => {});
    }
    return;
  }
  seekYouTube(Number(deltaSeconds || 0));
}

function toggleSongPlayback(songId) {
  const song = state.repertoire.find((item) => item.id === songId);
  if (!song) {
    setYouTubeStatus("Dodaj pesmu");
    return;
  }
  if (isLocalSong(song)) {
    if (state.selectedSongId !== song.id) {
      state.selectedSongId = song.id;
      savePlayerSettings();
      updateSelectedSongPanel();
      renderRepertoire();
    }
    toggleLocalSongPlayback(song);
    return;
  }
  if (!song.videoId) {
    setYouTubeStatus("Unesi YouTube link");
    return;
  }

  const wasSelected = state.selectedSongId === song.id;
  const shouldPlay = !(wasSelected && state.youtubeDesiredPlaying);
  const commandToken = state.youtubeCommandToken + 1;

  // YouTube starts after an asynchronous API hop. Resume Web Audio now, while
  // we are still inside the user's click gesture, so assisted harmony is not
  // blocked by the browser's autoplay policy.
  if (shouldPlay && (state.harmonyPianoEnabled || state.melodyPianoEnabled)) {
    ensureAudio();
  }
  
  state.youtubeCommandToken = commandToken;
  state.selectedSongId = song.id;
  savePlayerSettings();
  updateSelectedSongPanel();
  // A genuine song-change notification intentionally clears the old player
  // state. Apply this click's command only after that reset.
  state.youtubeDesiredPlaying = shouldPlay;
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
  const song = state.repertoire.find((item) => item.id === songId);
  const playing = isLocalSong(song)
    ? state.selectedSongId === songId && rec.playing
    : state.selectedSongId === songId && state.youtubeDesiredPlaying;
  return playing ? "Pauza" : "Pusti";
}

function updateRepertoirePlaybackButtons() {
  if (youtubePlayPause) {
    const label = getSongToggleLabel(state.selectedSongId);
    youtubePlayPause.textContent = label;
    youtubePlayPause.classList.toggle("is-playing", label === "Pauza");
    youtubePlayPause.setAttribute("aria-label", label);
  }
  const repertoireTableBody = $("repertoireTableBody");
  if (!repertoireTableBody) return;
  repertoireTableBody.querySelectorAll("[data-song-toggle]").forEach((button) => {
    button.textContent = getSongToggleLabel(button.dataset.songToggle);
  });
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

function getYouTubeSeekSeconds() {
  const value = clamp(Number(youtubeSeekSeconds.value) || 10, 1, 60);
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

// ---------------- STAGE CHORD SYNCHRONIZATION ----------------
function syncStage() {
  const stage = $("stageChordName");
  const notesEl = $("stageChordNotes");
  const activeChord = $("activeChordDisplay");
  
  const midiName = detectMidiChord();
  if (midiName) {
    const midiNotes = Array.from(midiHeld).sort((a, b) => a - b)
      .map((m) => NOTE_NAMES[m % 12]).join(" ");
    if (stage) {
      stage.textContent = midiName;
      stage.classList.remove("idle");
    }
    if (notesEl) {
      notesEl.textContent = midiHeld.size > 1 ? "(" + midiNotes + ")" : "";
    }
    return;
  }
  
  const text = (activeChord.value || activeChord.textContent || "").trim();
  if (!text || text === "-") {
    if (stage) {
      stage.textContent = "—";
      stage.classList.add("idle");
    }
    if (notesEl) notesEl.textContent = "";
    return;
  }
  
  // Parsiranje i lepo prikazivanje akorda
  const parts = text.split(" - ");
  const main = parts[0].replace(/\([^)]*\)/g, "").trim();
  const words = main.split(/\s+/);
  const root = (words[0] || "").replace(/\d+/g, "");
  let quality = "";
  for (let i = 1; i < words.length; i++) {
    const w = words[i].toLowerCase();
    if (w === "dur" || w === "mol") { quality = w; break; }
    if (w.indexOf("sept") === 0) quality = quality || "7";
  }
  const notes = (parts[1] || "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  
  if (stage) {
    stage.textContent = (root + " " + quality).trim();
    stage.classList.remove("idle");
  }
  if (notesEl) {
    notesEl.textContent = notes ? "(" + notes + ")" : "";
  }
}

// ---------------- TEMA & STYLING ----------------
function applySavedTheme() {
  const root = document.documentElement;
  const legacy = readJsonStorage("fgr-ui-v1", {});
  const preferences = readUiPreferences();

  state.theme = preferences.theme;
  state.darkAccent = preferences.darkAccent;
  state.melodyColor = preferences.melodyColor;
  state.harmonyColor = preferences.harmonyColor;
  state.melodyPianoEnabled = preferences.melodyPianoEnabled;
  state.harmonyPianoEnabled = preferences.harmonyPianoEnabled;
  state.pianoDockHeight = preferences.pianoDockHeight;
  state.metronomeCollapsed = preferences.metronomeCollapsed;
  state.trackMelody = preferences.melodyPianoEnabled;
  state.melodyTrackSource = preferences.melodyTrackSource;
  state.showFingering = preferences.showFingering;
  state.showBeatGrid = preferences.showBeatGrid;
  state.compingPattern = preferences.compingPattern;
  state.processingServiceUrl = preferences.processingServiceUrl;

  if (legacy.tool) state.tool = legacy.tool;
  if (typeof legacy.scaleAllOctaves === "boolean") state.scaleAllOctaves = legacy.scaleAllOctaves;
  if (typeof legacy.octaveLocked === "boolean") state.octaveLocked = legacy.octaveLocked;

  applyVisualPreferences(root, preferences);
  applyWorkbenchLayoutPreferences();

  const icon = $("themeToggleIcon");
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  if (icon) icon.innerHTML = state.theme === "dark" ? SUN : MOON;

  document.querySelectorAll("input[name='uiTheme']").forEach((radio) => {
    radio.checked = radio.value === state.theme;
  });

  const accentInput = $("accentColorInput");
  const accentValue = $("accentColorValue");
  const accentRow = $("accentColorRow");
  if (accentInput) {
    accentInput.value = state.darkAccent;
    accentInput.disabled = state.theme !== "dark";
  }
  if (accentValue) accentValue.value = state.darkAccent.toUpperCase();
  if (accentRow) accentRow.classList.toggle("is-disabled", state.theme !== "dark");

  const melodyColor = $("melodyColorInput");
  const harmonyColor = $("harmonyColorInput");
  const themeSwatch = $("userThemeColorSwatch");
  if (melodyColor) melodyColor.value = state.melodyColor;
  if (harmonyColor) harmonyColor.value = state.harmonyColor;
  if (themeSwatch) themeSwatch.style.background = "var(--active)";

  const meta = document.querySelector("meta[name='theme-color']");
  if (meta) meta.setAttribute("content", state.theme === "dark" ? "#141009" : "#efe9dd");
}

function applyWorkbenchLayoutPreferences() {
  const height = normalizePianoDockHeight(state.pianoDockHeight);
  state.pianoDockHeight = height;
  app?.style.setProperty("--piano-dock-height", `${height}px`);

  if (pianoHeightControl) pianoHeightControl.value = String(height);
  if (pianoHeightDisplay) pianoHeightDisplay.value = `${height} px`;

  const panel = $("metronomePanel");
  const controls = $("metronomeControls");
  const collapsed = Boolean(state.metronomeCollapsed);
  panel?.classList.toggle("is-collapsed", collapsed);
  panel?.closest(".studio-rail")?.classList.toggle("metronome-collapsed", collapsed);
  if (controls) controls.hidden = collapsed;
  if (metronomePanelToggle) {
    metronomePanelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    metronomePanelToggle.setAttribute("aria-label", collapsed ? "Prikazi metronom" : "Sakrij metronom");
  }
}

function bindAppearanceSettings() {
  const toggle = $("themeToggle");
  const popover = $("appearancePopover");
  if (!toggle || !popover || toggle.dataset.bound === "true") return;
  toggle.dataset.bound = "true";

  const close = ({ focus = false } = {}) => {
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (focus) toggle.focus();
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    popover.hidden = !popover.hidden;
    toggle.setAttribute("aria-expanded", popover.hidden ? "false" : "true");
  });

  popover.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("pointerdown", (event) => {
    if (!popover.hidden && !popover.contains(event.target) && event.target !== toggle) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) close({ focus: true });
  });

  document.querySelectorAll("input[name='uiTheme']").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      patchUiPreferences({ theme: radio.value === "light" ? "light" : "dark" });
      applySavedTheme();
    });
  });

  const accentInput = $("accentColorInput");
  if (accentInput) {
    accentInput.addEventListener("input", () => {
      patchUiPreferences({ darkAccent: normalizeHexColor(accentInput.value, DEFAULT_DARK_ACCENT) });
      applySavedTheme();
    });
  }

  const reset = $("resetAccentButton");
  if (reset) {
    reset.addEventListener("click", () => {
      patchUiPreferences({ darkAccent: DEFAULT_DARK_ACCENT });
      applySavedTheme();
    });
  }
}

function bindPianoFollowControls() {
  const melodyToggle = $("melodyPianoToggle");
  const harmonyToggle = $("harmonyPianoToggle");
  const melodySource = $("melodyPianoSource");
  const melodyColor = $("melodyColorInput");
  const harmonyColor = $("harmonyColorInput");
  if (!melodyToggle || melodyToggle.dataset.bound === "true") return;
  melodyToggle.dataset.bound = "true";

  melodyToggle.checked = state.melodyPianoEnabled;
  if (harmonyToggle) harmonyToggle.checked = state.harmonyPianoEnabled;
  if (melodySource) melodySource.value = state.melodyTrackSource;
  refreshNoteTrackMenus();

  melodyToggle.addEventListener("change", () => {
    state.melodyPianoEnabled = melodyToggle.checked;
    state.trackMelody = melodyToggle.checked;
    if (trackMelodyToggle) trackMelodyToggle.checked = state.trackMelody;
    patchUiPreferences({ melodyPianoEnabled: state.melodyPianoEnabled });
    if (!state.melodyPianoEnabled) {
      clearTimedNoteTracking();
    } else {
      ensureAudio();
      prepareSongNoteTracks(getSelectedSong()).then((tracks) => {
        if (!tracks[state.melodyTrackSource]?.length) {
          setPipeStatus(noteTrackUnavailableMessage(state.melodyTrackSource));
        }
      });
    }
  });

  if (harmonyToggle) {
    harmonyToggle.addEventListener("change", () => {
      state.harmonyPianoEnabled = harmonyToggle.checked;
      patchUiPreferences({ harmonyPianoEnabled: state.harmonyPianoEnabled });
      if (!state.harmonyPianoEnabled) {
        clearHarmonyHints();
        refreshGuidedPlayback({ force: true });
      } else {
        ensureAudio();
        refreshGuidedPlayback({ force: true });
        updateHarmonyPiano(state.currentPlaybackChordName);
      }
    });
  }

  if (melodySource) {
    melodySource.addEventListener("change", () => {
      state.melodyTrackSource = melodySource.value === "bass" ? "bass" : "melody";
      if (melodySourceSelect) melodySourceSelect.value = state.melodyTrackSource;
      patchUiPreferences({ melodyTrackSource: state.melodyTrackSource });
      clearTimedNoteTracking();
      if (state.melodyPianoEnabled) ensureAudio();
      const song = getSelectedSong();
      prepareSongNoteTracks(song).then((tracks) => {
        if (!tracks[state.melodyTrackSource]?.length) {
          setPipeStatus(noteTrackUnavailableMessage(state.melodyTrackSource));
        }
      });
    });
  }

  if (melodyColor) {
    melodyColor.addEventListener("input", () => {
      state.melodyColor = normalizeHexColor(melodyColor.value, DEFAULT_MELODY_COLOR);
      patchUiPreferences({ melodyColor: state.melodyColor });
      applyVisualPreferences(document.documentElement, readUiPreferences());
    });
  }

  if (harmonyColor) {
    harmonyColor.addEventListener("input", () => {
      state.harmonyColor = normalizeHexColor(harmonyColor.value, DEFAULT_HARMONY_COLOR);
      patchUiPreferences({ harmonyColor: state.harmonyColor });
      applyVisualPreferences(document.documentElement, readUiPreferences());
    });
  }
}

function updateToneCard() {
  const currentSong = getSelectedSong();
  const orig = currentSong ? parseKey(currentSong.key) : null;
  const origKeyEl = $("origKey");
  
  if (origKeyEl) {
    origKeyEl.textContent = orig ? formatKey(orig.pc, orig.minor) : (currentSong && currentSong.key ? currentSong.key : "—");
  }
  
  const k = shownKey();
  const transKeyEl = $("transKey");
  if (transKeyEl) {
    transKeyEl.textContent = (currentSong || state.transpose !== 0) ? formatKey(k.pc, k.minor) : "—";
  }
  
  const transValEl = $("transVal");
  if (transValEl) {
    transValEl.textContent = state.transpose > 0 ? "+" + state.transpose : (state.transpose < 0 ? String(state.transpose) : "±0");
  }
}

// ---------------- LOKALNO SNIMANJE & PITCH ANALIZA ----------------
function setPipeStatus(text) {
  const el = $("pipeStatus");
  if (el) el.textContent = text || "";
}

function refreshPipe() {
  const song = getSelectedSong();
  const view = buildAnalysisProgressView(song, {
    localAudio: hasLocalSongAudio(song),
    recording: capRec?.state === "recording" || Boolean(capStopping),
    captureStarting: capStarting,
    captureStopping: Boolean(capStopping)
  });
  const shell = $("analysisProgressShell");
  const bar = $("analysisProgressBar");
  const percent = $("analysisProgressPercent");
  const title = $("analysisProgressTitle");
  const recordButton = $("pipeRec");
  const retryButton = $("analysisRetryButton");
  // Gotova analiza ne treba da zauzima traku. Postojanje akorada i razdvojenih
  // kanala je samo po sebi dokaz da je obrada završena, pa panel nestaje čim
  // više nema šta da javi. Ostaje samo kada nešto traje, kada je pukao, ili
  // kada korisnik može nešto da pokrene.
  const strip = $("analysisStrip");
  if (strip) {
    const hasSomethingToSay = view.active
      || view.canRetry
      || view.canRecord
      || view.state === "failed"
      || view.state === "needs-service"
      || view.state === "idle";
    strip.hidden = !hasSomethingToSay;
  }
  if (shell) shell.dataset.state = view.state;
  if (title) title.textContent = view.title;
  if (percent) percent.textContent = view.indeterminate ? "…" : `${view.percent}%`;
  if (bar) {
    if (view.indeterminate) bar.removeAttribute("value");
    else bar.value = view.percent;
    bar.setAttribute("aria-label", `${view.title}: ${view.percent}%`);
  }
  setPipeStatus(view.message);
  if (recordButton) {
    const recording = capRec?.state === "recording" || capStarting || Boolean(capStopping);
    recordButton.hidden = !(view.canRecord || recording);
    recordButton.disabled = Boolean(capStarting || capStopping || (view.active && !recording));
    if (!recording) {
      const label = recordButton.querySelector(".tt");
      if (label) label.textContent = "Snimi i analiziraj";
    }
  }
  if (retryButton) {
    retryButton.hidden = !view.canRetry;
    retryButton.disabled = view.active;
  }
}

function setPipelineStepState(id, value) {
  const step = $(id);
  if (!step) return;
  if (value && value !== "idle") step.dataset.state = value;
  else delete step.dataset.state;
}

let capStream = null, capRec = null, capChunks = [], capStart = 0, capTimer = null;
let capSongId = "", capStopping = null, capStarting = false;
let capAwaitingPlayback = false, capVideoOffsetSeconds = 0;

function startLegacyCapture() {
  const song = getSelectedSong();
  if (!song) {
    setPipeStatus("Prvo izaberi pesmu u repertoaru.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setPipeStatus("Deljenje taba ne radi u ovom browseru (Chrome/Edge desktop).");
    return;
  }
  
  navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      channelCount: 2,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    preferCurrentTab: true,
    selfBrowserSurface: "include"
  }).then((stream) => {
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      setPipeStatus("Nema zvuka — pri deljenju čekiraj „Deli audio taba”.");
      return;
    }
    
    capStream = stream;
    const audioTrack = stream.getAudioTracks()[0];
    if (typeof audioTrack.applyConstraints === "function") {
      audioTrack.applyConstraints({
        channelCount: 2,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }).catch(() => {});
    }
    const audioStream = new MediaStream([audioTrack]);
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recOptions = mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : { audioBitsPerSecond: 256000 };
    capRec = new MediaRecorder(audioStream, recOptions);
    capChunks = [];
    
    capRec.ondataavailable = (e) => {
      if (e.data.size) capChunks.push(e.data);
    };
    
    capRec.onstop = () => {
      const blob = new Blob(capChunks, { type: capChunks[0] ? capChunks[0].type : "audio/webm" });
      const dur = Math.round((Date.now() - capStart) / 1000);
      const id = recId();
      
      if (!id || dur < 3) {
        setPipeStatus("Snimak prekratak — nije sačuvan.");
        return;
      }
      
      dbPut({ id, blob, dur, at: Date.now() }).then(() => {
        setPipeStatus("Snimljeno " + fmtTime(dur) + " — sada klikni „3 Prepoznaj akorde”.");
        refreshPipe();
        updateRecRow();
      }).catch((err) => {
        setPipeStatus("Greška pri čuvanju: " + err.message);
      });
    };
    
    capRec.start(1000);
    capStart = Date.now();
    
    const btn = $("pipeRec");
    if (btn) btn.classList.add("rec");
    
    capTimer = setInterval(() => {
      if (btn) btn.querySelector(".tt").textContent = "■ Zaustavi (" + fmtTime((Date.now() - capStart) / 1000) + ")";
    }, 500);
    
    // Auto-reprodukcija sa YouTube-a pri snimanju
    playFromStart();
    setPipeStatus("Snima… pesma je puštena od početka. Kad se završi, klikni „Zaustavi”.");
    
    stream.getAudioTracks()[0].onended = stopCapture;
  }).catch((err) => {
    setPipeStatus("Otkazano: " + err.message);
  });
}

function playFromStart() {
  const song = getSelectedSong();
  if (!song?.videoId) return;
  if (rec.playing) recStop(true);
  state.youtubeResumeTime = 0;
  ensureYouTubePlayer().then((player) => {
    if (!player) return;
    if (state.youtubeLoadedVideoId !== song.videoId && typeof player.loadVideoById === "function") {
      player.loadVideoById(song.videoId);
      state.youtubeLoadedVideoId = song.videoId;
    }
    setHybridYouTubeAudioMode(player, false);
    if (typeof player.seekTo === "function") {
      player.seekTo(0, true);
    }
    state.youtubeDesiredPlaying = true;
    if (typeof player.playVideo === "function") {
      player.playVideo();
    }
  });
}

function stopLegacyCapture() {
  if (capRec && capRec.state !== "inactive") capRec.stop();
  if (capStream) capStream.getTracks().forEach((t) => t.stop());
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  
  const btn = $("pipeRec");
  if (btn) {
    btn.classList.remove("rec");
    btn.querySelector(".tt").textContent = "Snimi jednom";
  }
}

// Above this share of missing audio the take is not worth analysing. One of
// the two captures found on disk had lost 1.2% of the song in about a thousand
// separate gaps and passed every check the app had, because the only test was
// for silence. Beats, chords and note timing are all derived from this audio,
// so a damaged take produces confidently wrong analysis.
const MAX_CAPTURE_DROPOUT_RATIO = 0.003;

async function finalizePcmCapture(songId, audioBuffer, integrity = null) {
  const song = state.repertoire.find((entry) => entry.id === songId);
  if (!song || !audioBuffer || audioBuffer.duration < 3) {
    setPipeStatus("Snimak je prekratak i nije sačuvan.");
    return;
  }
  const droppedRatio = Number(integrity?.droppedRatio) || 0;
  if (droppedRatio > MAX_CAPTURE_DROPOUT_RATIO) {
    const lost = (Number(integrity?.droppedSeconds) || 0).toFixed(1);
    song.processing = createProcessingStatus(
      "failed",
      "source",
      `Snimanje je izgubilo ${lost} s zvuka (${(droppedRatio * 100).toFixed(1)}%). `
        + "Zatvori nepotrebne tabove i programe pa snimi ponovo — od ovakvog snimka analiza ne može da bude tačna."
    );
    persistProcessingUpdate(song);
    return;
  }
  const signal = audioBufferSignalStats(audioBuffer);
  if (signal.silent) {
    song.processing = createProcessingStatus(
      "failed",
      "source",
      "Snimak nema upotrebljiv zvuk. Podeli YouTube tab i uključi opciju Deli audio taba."
    );
    persistProcessingUpdate(song);
    return;
  }

  const capturedAt = Date.now();
  const file = createPcmWavFile(audioBuffer, {
    bitDepth: 24,
    fileName: `${song.title || song.id}-youtube.wav`,
    lastModified: capturedAt
  });
  await dbPut({
    id: `song-${song.id}`,
    blob: file,
    dur: audioBuffer.duration,
    name: file.name,
    mime: file.type,
    size: file.size,
    at: capturedAt
  });

  song.localCapture = {
    available: true,
    format: "wav",
    bitDepth: 24,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    duration: Math.round(audioBuffer.duration * 1000) / 1000,
    videoOffsetSeconds: Math.round(Math.max(0, capVideoOffsetSeconds) * 1000) / 1000,
    capturedAt: new Date(capturedAt).toISOString()
  };
  invalidateHeroWaveformCache(song);
  song.localMixEnabled = true;
  song.duration = song.localCapture.duration;
  song.stems = false;
  song.availableStems = [];
  song.assets = null;
  song.noteTracks = {};
  song.chords = [];
  delete song.chordProvenance;
  delete song.chordSourceSha256;
  delete song.chordTimingOffsetSeconds;
  delete song.chordPatchDirty;
  delete song.chordPatchError;
  song.processing = createProcessingStatus("queued", "source", "WAV je sačuvan; pokrećem AI kanale i analizu.");
  saveRepertoire({ skipServerSave: true });

  if (state.selectedSongId === song.id) {
    invalidateRecLoad();
    rec.buffer = null;
    rec.bufferId = null;
    rec.mixBuffer = null;
    rec.stems = null;
    rec.hasStems = false;
    updateSelectedSongPanel();
    await recLoad().catch(() => false);
    refreshPipe();
    updateRecRow();
  }

  setPipeStatus(`WAV ${fmtTime(audioBuffer.duration)} je sačuvan u punom PCM kvalitetu. AI obrada je pokrenuta.`);
  await processImportedSong(song, file, { autoAnalyze: true, sourceKind: "youtube-capture" });
}

async function startCapture() {
  const song = getSelectedSong();
  if (!song?.videoId) {
    setPipeStatus("Za snimanje prvo izaberi YouTube pesmu.");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setPipeStatus("Deljenje taba radi u Chrome/Edge desktop browseru.");
    return;
  }
  if (capStarting || capStopping || capRec?.state === "recording") return;
  capStarting = true;
  refreshPipe();
  const startButton = $("pipeRec");
  if (startButton) startButton.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        channelCount: 2,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      preferCurrentTab: true,
      selfBrowserSurface: "include"
    });
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      stream.getTracks().forEach((track) => track.stop());
      capStarting = false;
      if (startButton?.isConnected) startButton.disabled = false;
      setPipeStatus("Nema zvuka — pri deljenju obavezno uključi „Deli audio taba“.");
      return;
    }

    capStream = stream;
    if (typeof audioTrack.applyConstraints === "function") {
      await audioTrack.applyConstraints({
        channelCount: 2,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }).catch(() => {});
    }
    capRec = await createPcmTabRecorder(new MediaStream([audioTrack]));
    capSongId = song.id;
    capStart = 0;
    capVideoOffsetSeconds = 0;
    capAwaitingPlayback = true;
    capStarting = false;
    refreshPipe();

    const button = $("pipeRec");
    if (button) button.disabled = false;
    button?.classList.add("rec");
    capTimer = window.setInterval(() => {
      const label = button?.querySelector(".tt");
      if (!capStart) {
        if (label) label.textContent = "Cekam da YouTube krene...";
        return;
      }
      if (label) label.textContent = `■ Zaustavi (${fmtTime((Date.now() - capStart) / 1000)})`;
    }, 500);

    // Arm the tab stream first; handleYouTubeStateChange starts PCM collection
    // on the actual PLAYING state so buffering time is excluded.
    playFromStart();
    setPipeStatus("Snima direktno u 48 kHz PCM… Kad se pesma završi, klikni Zaustavi.");
    setPipeStatus("Cekam da YouTube stvarno krene; tada pocinje 48 kHz PCM snimanje.");
    audioTrack.onended = () => stopCapture();
  } catch (error) {
    capStream?.getTracks().forEach((track) => track.stop());
    capStream = null;
    capRec = null;
    capSongId = "";
    capAwaitingPlayback = false;
    capStarting = false;
    if (startButton?.isConnected) startButton.disabled = false;
    setPipeStatus("Snimanje nije pokrenuto: " + (error?.message || error));
    refreshPipe();
  }
}

async function stopCapture() {
  if (capStopping) return capStopping;
  const recorder = capRec;
  const songId = capSongId;

  if (capTimer) {
    window.clearInterval(capTimer);
    capTimer = null;
  }
  const button = $("pipeRec");
  if (button) button.disabled = true;
  button?.classList.remove("rec");
  const label = button?.querySelector(".tt");
  if (label) label.textContent = "Snimi jednom";
  state.youtubeDesiredPlaying = false;
  if (state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
    try { state.youtubePlayer.pauseVideo(); } catch (_error) {}
  }

  capStopping = (async () => {
    const audioBuffer = recorder?.state === "recording" ? await recorder.stop() : null;
    const integrity = typeof recorder?.captureIntegrity === "function" ? recorder.captureIntegrity() : null;
    capStream?.getTracks().forEach((track) => track.stop());
    capStream = null;
    capRec = null;
    capSongId = "";
    capAwaitingPlayback = false;
    if (audioBuffer) await finalizePcmCapture(songId, audioBuffer, integrity);
  })().catch((error) => {
    setPipeStatus("Greška pri WAV snimanju: " + (error?.message || error));
  }).finally(() => {
    capStopping = null;
    capStarting = false;
    capVideoOffsetSeconds = 0;
    if (button?.isConnected) button.disabled = false;
    refreshPipe();
  });
  refreshPipe();
  return capStopping;
}

function mixAnalysisBuffers(actx, buffers) {
  const valid = buffers.filter(Boolean);
  if (!valid.length) throw new Error("Nema harmonijskih stemova za analizu.");

  const length = Math.max(...valid.map((buffer) => buffer.length));
  const channels = Math.max(...valid.map((buffer) => buffer.numberOfChannels));
  const mixed = actx.createBuffer(channels, length, valid[0].sampleRate);
  const scale = 1 / valid.length;

  valid.forEach((buffer) => {
    for (let channel = 0; channel < channels; channel += 1) {
      const output = mixed.getChannelData(channel);
      const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      for (let i = 0; i < input.length; i += 1) {
        output[i] += input[i] * scale;
      }
    }
  });

  return mixed;
}
async function analyzeSongChords(song, options = {}) {
  if (!song) {
    setPipeStatus("Prvo izaberi pesmu.");
    return [];
  }
  if (isProcessingActive(song.processing)) {
    setPipeStatus("Server trenutno obrađuje izvor. Sačekaj da automatska analiza završi.");
    return [];
  }

  const previousProcessing = song.processing;
  song.processing = createProcessingStatus("analyzing", "chords", "Analiziram harmonijske kanale.");
  persistProcessingUpdate(song);
  setPipeStatus("Analiziram harmoniju… 0%");

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const actx = new AudioContext();
  try {
    const referenceChords = Array.isArray(song.chords) && song.chords.length
      ? song.chords.map((chord) => ({ ...chord }))
      : null;
    let buffer;
    let bassReferenceBuffer = null;
    if (song.stems) {
      const [bassBuffer, ...harmonicBuffers] = await Promise.all([
        loadAnalysisStem(actx, song, "bass"),
        loadAnalysisStem(actx, song, "piano"),
        loadAnalysisStem(actx, song, "guitar"),
        loadAnalysisStem(actx, song, "other")
      ]);
      bassReferenceBuffer = bassBuffer;
      buffer = mixAnalysisBuffers(actx, harmonicBuffers);
    } else {
      const item = await dbGet(`song-${song.id}`);
      if (!item?.blob) throw new Error("Nema lokalnog MP3 izvora za analizu.");
      buffer = await actx.decodeAudioData(await item.blob.arrayBuffer());
    }

    const chords = await analyzeBuffer(
      buffer,
      (progress) => setPipeStatus(`Analiziram harmoniju… ${Math.round(progress * 100)}%`),
      {
        key: song.key,
        minSegmentSeconds: 0.36,
        smoothingRadius: 1,
        hopSeconds: 0.05,
        fftSize: 4096,
        simpleChart: true,
        referenceChords,
        bassReferenceBuffer,
        allowLabelCorrection: Boolean(bassReferenceBuffer),
        // Existing/manual charts are a useful prior. Correct each boundary
        // independently, but do not let weak shared-tone evidence drag it by
        // several seconds into a neighbouring musical event.
        refinementWindowSeconds: 0.9,
        evidenceWindowSeconds: 0.62
      }
    );
    if (!chords.length) throw new Error("Nisam uspeo pouzdano da prepoznam akorde.");

    song.chords = chords;
    song.processing = previousProcessing?.state === "ready"
      ? previousProcessing
      : createProcessingStatus("ready", "complete", "AI kanali i akordi su spremni.");
    saveRepertoire({ skipServerSave: hasLocalSongAudio(song) });
    updateSelectedSongPanel();
    renderMiniChart();
    if (state.tool === "chart") renderTool();
    refreshPipe();
    setPipeStatus(referenceChords
      ? (bassReferenceBuffer
          ? `Granice i nepouzdani nazivi svih ${chords.length} akorda provereni su prema harmoniji i izdvojenom basu.`
          : `Precizirane su granice svih ${chords.length} postojećih akorda; redosled i nazivi nisu menjani.`)
      : `Upisano ${chords.length} stabilizovanih akorda. Proveri ih po sluhu.`);

    if (options.patchService) {
      patchSongChordsOnService(song, {
        origin: options.automatic ? "browser-analysis" : "manual-edit"
      });
    }
    return chords;
  } catch (error) {
    song.processing = previousProcessing?.state === "ready"
      ? previousProcessing
      : createProcessingStatus("failed", "chords", error?.message || "Analiza akorda nije uspela.");
    persistProcessingUpdate(song);
    setPipeStatus(`Greška: ${error?.message || "Analiza akorda nije uspela."}`);
    return [];
  } finally {
    actx.close().catch(() => {});
  }
}

function loadAnalysisStem(actx, song, stemName) {
  const asset = song?.assets?.stems?.[stemName];
  const url = typeof asset === "string" ? asset : asset?.url || `samples/${song.id}/${stemName}.wav`;
  return fetch(url)
    .then((response) => response.ok ? response.arrayBuffer() : null)
    .then((data) => data ? actx.decodeAudioData(data) : null)
    .catch(() => null);
}

function updateRecordedPlaybackControls() {
  const duration = rec.buffer ? rec.buffer.duration : 0;
  const current = duration ? Math.min(recTime(), duration) : Math.max(0, recTime());

  const recTimeDisplay = $("recTime");
  if (recTimeDisplay) {
    recTimeDisplay.textContent = duration ? `${fmtTime(current)} / ${fmtTime(duration)}` : fmtTime(current);
  }

  const recPitchDisplay = $("recPitch");
  if (recPitchDisplay) {
    recPitchDisplay.textContent = state.transpose === 0 ? "" : (state.transpose > 0 ? "+" + state.transpose : String(state.transpose));
  }

  if (sideTransVal) {
    sideTransVal.textContent = state.transpose > 0 ? "+" + state.transpose : (state.transpose < 0 ? String(state.transpose) : "+/-0");
  }

  if (recSpeedSelect && recSpeedSelect.value !== String(state.playbackRate)) {
    recSpeedSelect.value = String(state.playbackRate);
  }

  if (recSeeker) {
    recSeeker.max = duration ? String(duration) : "0";
    recSeeker.disabled = !duration;
    if (document.activeElement !== recSeeker) {
      recSeeker.value = String(current);
    }
  }

  updatePracticeButtonLabel();
}
function updateRecRow() {
  const row = $("recPlayerRow");
  if (!row) return;
  const mix = $("recMixerPanel");
  if (mix) mix.hidden = false;
  syncMixerControls();
  const id = recId();
  if (!id) { 
    row.hidden = true; 
    return; 
  }
  
  const song = getSelectedSong();
  const hasStems = song && song.stems === true;
  
  if (hasStems) {
    row.hidden = false;
    updateRecordedPlaybackControls();
    return;
  }
  
  const requestedId = id;
  dbGet(id).then((item) => {
    if (recId() !== requestedId) return;
    row.hidden = !item;
    syncMixerControls();
    updateRecordedPlaybackControls();
  }).catch(() => {
    if (recId() !== requestedId) return;
    row.hidden = true;
    syncMixerControls();
  });
}

function rawNoteTrackEvents(entry) {
  return Array.isArray(entry?.events) ? entry.events : [];
}

function isLowConfidenceNoteTrack(entry) {
  const status = String(entry?.status || "").trim().toLowerCase();
  if (["low-confidence", "low_confidence", "failed", "unavailable"].includes(status)) return true;
  const confidence = Number(entry?.confidence);
  return Number.isFinite(confidence) && confidence < 0.35;
}

function noteTrackEvents(entry) {
  return isLowConfidenceNoteTrack(entry) ? [] : rawNoteTrackEvents(entry);
}

function normalizedSongNoteTracks(song) {
  return {
    ...normalizeNoteTracks(song?.assets?.noteTracks || song?.assets?.note_tracks || {}),
    ...normalizeNoteTracks(song?.note_tracks || {}),
    ...normalizeNoteTracks(song?.noteTracks || {})
  };
}

async function fetchNoteTrackEntry(entry, channel) {
  if (rawNoteTrackEvents(entry).length) return entry;
  const url = typeof entry === "string" ? entry : entry?.url;
  if (!url) return entry || null;
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Tonska linija nije dostupna (${response.status}).`);
  const payload = await response.json();
  if (Array.isArray(payload)) {
    return normalizeNoteTracks({ [channel]: { ...entry, events: payload } })[channel] || null;
  }
  const documentTracks = normalizeNoteTracks(payload?.noteTracks || payload?.note_tracks || payload);
  if (documentTracks[channel]) return documentTracks[channel];
  return normalizeNoteTracks({ [channel]: { ...entry, ...(payload || {}) } })[channel] || null;
}

async function fetchStaticNoteTracks(song) {
  if (!song?.id) return {};
  try {
    const response = await fetch(`samples/${encodeURIComponent(song.id)}/note-tracks.json`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return {};
    const payload = await response.json();
    return normalizeNoteTracks(payload?.noteTracks || payload?.note_tracks || payload);
  } catch {
    return {};
  }
}

/**
 * Učitaj generisanu mrežu za pesmu koja ide uz aplikaciju, da demo repertoar
 * ima ritmičku mrežu i kada localhost servis nije pokrenut.
 */
async function loadStaticBeatGrid(song) {
  if (!song?.id || song.beatGrid) return;
  const songId = song.id;
  try {
    const response = await fetch(`samples/${encodeURIComponent(songId)}/beat-grid.json`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return;
    const grid = normalizeBeatGrid(await response.json());
    if (!grid) return;
    const target = state.repertoire.find((item) => item.id === songId);
    if (!target || target.beatGrid) return;
    target.beatGrid = grid;
    if (getSelectedSong()?.id === songId) refreshBeatGridOverlay();
  } catch {
    // Mreža je dodatak: pesma bez nje i dalje radi u slobodnom vremenu.
  }
}

function refreshNoteTrackMenus() {
  const selectedSource = state.melodyTrackSource === "bass" ? "bass" : "melody";
  const labels = { melody: "Melodija", bass: "Bas" };
  [$(`melodyPianoSource`), melodySourceSelect].filter(Boolean).forEach((select) => {
    select.value = selectedSource;
    [...select.options].forEach((option) => {
      const channel = option.value === "bass" ? "bass" : "melody";
      const ready = resolvedNoteTracks[channel]?.length > 0;
      option.disabled = !ready;
      option.textContent = labels[channel];
    });
    const ready = resolvedNoteTracks[selectedSource]?.length > 0;
    const rawEntry = normalizedSongNoteTracks(getSelectedSong())[selectedSource];
    select.title = ready
      ? `${labels[selectedSource]}: ${resolvedNoteTracks[selectedSource].length} tačno tempiranih tonova`
      : isLowConfidenceNoteTrack(rawEntry)
        ? `${labels[selectedSource]} ima nisku pouzdanost; automatsko sviranje je isključeno`
      : `${labels[selectedSource]} još nije analizirana za ovu pesmu`;
  });
}

function noteTrackUnavailableMessage(source) {
  const label = source === "bass" ? "Bas linija" : "Melodija";
  const entry = normalizedSongNoteTracks(getSelectedSong())[source];
  return isLowConfidenceNoteTrack(entry)
    ? `${label} je označena kao nepouzdana; automatsko sviranje je isključeno.`
    : `${label} još nije analizirana.`;
}

function serializeExtractedTrack(channel, extracted) {
  return {
    status: "ready",
    role: channel,
    events: extracted.events,
    sourceStems: extracted.sourceStem ? [extracted.sourceStem] : [],
    algorithm: extracted.algorithm || "browser-spectral-exact-v3",
    timeBase: "mix-seconds",
    timeOffset: 0,
    confidence: extracted.quality?.meanConfidence || 0,
    quality: extracted.quality || null
  };
}

function invalidateNoteTrackTask(songId) {
  const id = String(songId || "");
  if (!id) return;
  noteTrackGenerations.set(id, (noteTrackGenerations.get(id) || 0) + 1);
  noteTrackTasks.delete(id);
}

function isCurrentNoteTrackGeneration(songId, generation) {
  return noteTrackGenerations.get(String(songId || "")) === generation;
}

async function resolveSongNoteTracks(song, generation) {
  if (!song) return { melody: [], bass: [] };
  const isCurrent = () => isCurrentNoteTrackGeneration(song.id, generation);
  const existing = normalizedSongNoteTracks(song);
  const resolvedEntries = { ...existing };

  await Promise.all(["melody", "bass"].map(async (channel) => {
    if (!resolvedEntries[channel]) return;
    try {
      const resolved = await fetchNoteTrackEntry(resolvedEntries[channel], channel);
      if (resolved) resolvedEntries[channel] = resolved;
    } catch {
      // The server may be offline after a completed import. The static/client
      // fallback below keeps the song usable without pretending that a stem is
      // already an accurate note line.
    }
  }));

  if (!isCurrent()) return { melody: [], bass: [] };

  const staticTracks = await fetchStaticNoteTracks(song);
  if (!isCurrent()) return { melody: [], bass: [] };
  ["melody", "bass"].forEach((channel) => {
    if (!noteTrackEvents(resolvedEntries[channel]).length && noteTrackEvents(staticTracks[channel]).length) {
      resolvedEntries[channel] = staticTracks[channel];
    }
  });

  const missing = ["melody", "bass"].filter((channel) => !noteTrackEvents(resolvedEntries[channel]).length);
  if (missing.length && song.stems && state.selectedSongId === song.id && isCurrent()) {
    const expectedBufferId = `song-${song.id}`;
    const loaded = await recLoad();
    if (loaded && state.selectedSongId === song.id && rec.bufferId === expectedBufferId && rec.stems && isCurrent()) {
      const generated = await extractFallbackNoteTracks(rec.stems, {
        onProgress: ({ channel, source, progress }) => {
          if (state.selectedSongId !== song.id || !isCurrent()) return;
          const label = channel === "bass" ? "bas liniju" : `melodiju (${source})`;
          setPipeStatus(`Analiziram ${label}… ${Math.round(progress * 100)}%`);
        }
      });
      missing.forEach((channel) => {
        if (generated[channel]?.events?.length) {
          resolvedEntries[channel] = serializeExtractedTrack(channel, generated[channel]);
        }
      });
      if (Object.keys(generated).length && state.selectedSongId === song.id && rec.bufferId === expectedBufferId && isCurrent()) {
        song.noteTracks = resolvedEntries;
        saveRepertoire({ skipServerSave: true });
      }
    }
  }

  const tracks = {
    melody: noteTrackEvents(resolvedEntries.melody),
    bass: noteTrackEvents(resolvedEntries.bass)
  };
  if (isCurrent() && (tracks.melody.length || tracks.bass.length)) song.noteTracks = resolvedEntries;
  return tracks;
}

function prepareSongNoteTracks(song, options = {}) {
  const songId = String(song?.id || "");
  if (!songId) {
    resolvedNoteTrackSongId = "";
    resolvedNoteTracks = { melody: [], bass: [] };
    resolvedNoteTrackOffsets = { melody: 0, bass: 0 };
    refreshNoteTrackMenus();
    clearTimedNoteTracking();
    return Promise.resolve(resolvedNoteTracks);
  }

  if (resolvedNoteTrackSongId !== songId) {
    resolvedNoteTrackSongId = songId;
    resolvedNoteTracks = { melody: [], bass: [] };
    resolvedNoteTrackOffsets = { melody: 0, bass: 0 };
    refreshNoteTrackMenus();
    clearTimedNoteTracking();
  }
  if (options.force) invalidateNoteTrackTask(songId);
  if (!noteTrackTasks.has(songId)) {
    const generation = (noteTrackGenerations.get(songId) || 0) + 1;
    noteTrackGenerations.set(songId, generation);
    const promise = resolveSongNoteTracks(song, generation);
    noteTrackTasks.set(songId, { generation, promise });
  }
  const task = noteTrackTasks.get(songId);
  return task.promise.then((tracks) => {
    if (noteTrackTasks.get(songId) !== task || !isCurrentNoteTrackGeneration(songId, task.generation)) return tracks;
    if (state.selectedSongId === songId) {
      resolvedNoteTracks = tracks;
      const entries = normalizedSongNoteTracks(song);
      resolvedNoteTrackOffsets = {
        melody: Number(entries.melody?.timeOffset ?? entries.melody?.time_offset) || 0,
        bass: Number(entries.bass?.timeOffset ?? entries.bass?.time_offset) || 0
      };
      refreshNoteTrackMenus();
      syncMixerControls();
      const source = state.melodyTrackSource === "bass" ? "bass" : "melody";
      if (tracks[source].length) {
        setPipeStatus(`${source === "bass" ? "Bas linija" : "Melodija"}: ${tracks[source].length} tonova spremno.`);
      }
    }
    return tracks;
  }).catch((error) => {
    if (noteTrackTasks.get(songId) !== task) return { melody: [], bass: [] };
    noteTrackTasks.delete(songId);
    if (state.selectedSongId === songId) {
      resolvedNoteTracks = { melody: [], bass: [] };
      resolvedNoteTrackOffsets = { melody: 0, bass: 0 };
      refreshNoteTrackMenus();
      syncMixerControls();
      setPipeStatus(error?.message || "Analiza tonske linije nije uspela.");
    }
    return { melody: [], bass: [] };
  });
}

// ---------------- MINI CHART & HIGHLIGHT TRACKING ----------------
function renderMiniChart() {
  const wrap = $("miniChart");
  if (!wrap) return;
  const currentSong = getSelectedSong();
  const chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords : [];
  
  const learnChartInfo = $("learnChartInfo");
  if (learnChartInfo) {
    learnChartInfo.textContent = chords.length ? chords.length + " akorada" : "nema";
  }
  
  const learnProgressBar = $("learnProgressBar");
  if (learnProgressBar) {
    learnProgressBar.style.width = chords.length ? "100%" : "0%";
  }
  
  if (!chords.length) {
    wrap.innerHTML = '<div class="mini-empty">Jos nema akorda za ovu pesmu.<br>Snimi pesmu ili dodaj akorde ovde.</div>';
    return;
  }
  wrap.innerHTML = "";
  
  chords.forEach((chord, idx) => {
    const item = document.createElement("div");
    item.className = "mini-cc";
    item.dataset.t = chord.t;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `${transposeChordName(chord.n)} na ${fmtChordTime(chord.t)}`);
    item.innerHTML = '<span class="n">' + transposeChordName(chord.n) + '</span><span class="t">' + fmtChordTime(chord.t) + "</span>";
    const seekToChord = () => {
      if (isLocalSong(currentSong)) recSeek(chord.t);
      else if (state.youtubePlayer && typeof state.youtubePlayer.seekTo === "function") {
        state.youtubePlayer.seekTo(chord.t, true);
      }
      paintChordName(transposeChordName(chord.n), false);
    };
    item.addEventListener("click", seekToChord);
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      seekToChord();
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (confirm("Obrisi " + chord.n + " (" + fmtChordTime(chord.t) + ")?")) {
        window.dispatchEvent(new CustomEvent("fgr:removechordrequest", { detail: { index: idx } }));
      }
    });
    wrap.appendChild(item);
  });
}

let lastFollowedChord = null;
let lastLearningScrollAt = 0;
let lastPlaybackPaintAt = 0;
let lastHybridVideoSyncAt = 0;
let lastTimedVisualMidis = new Set();
let lastTimedEventKeys = new Map();
let lastTimedTrackClock = null;
let catchUpHeldEvents = new Map();

function clearTimedNoteTracking() {
  lastTimedVisualMidis.forEach((midi) => state.keyElementsByMidi.get(midi)?.classList.remove("melody-hint"));
  lastTimedVisualMidis = new Set();
  lastUpcomingMidis.forEach((midi) => state.keyElementsByMidi.get(midi)?.classList.remove("melody-upcoming"));
  lastUpcomingMidis = new Set();
  lastTimedEventKeys = new Map();
  lastTimedTrackClock = null;
  catchUpHeldEvents = new Map();
  clearMelodyFingeringBadges();
}

// ---------------------------------------------------------------------------
// Vođena reprodukcija: zakazivanje unapred umesto paljenja iz RAF petlje.
// ---------------------------------------------------------------------------

let scorePlayer = null;
let lastScoreSignature = "";

function ensureScorePlayer() {
  if (scorePlayer) return scorePlayer;
  scorePlayer = createScorePlayer({
    getContextTime: () => state.audioContext?.currentTime,
    getMixTime: () => getLivePlaybackTime(),
    getPlaybackRate: () => Math.max(0.1, Number(state.playbackRate) || 1),
    isPlaying: () => isSongPlaybackRunning(getSelectedSong()),
    // Mikro-pomeraj od 6 ms: dovoljno da mašinska preciznost ne zvuči
    // sterilno, premalo da se čuje kao neujednačen tempo.
    humanizeSeconds: 0.006,
    resolveVoice: (request) => scheduleAssistedNote(request)
  });
  scorePlayer.start();
  return scorePlayer;
}

/** Melodijski/bas događaji u obliku koji scheduler razume. */
function buildGuidedLineEvents(source) {
  const events = resolvedNoteTrackSongId === getSelectedSong()?.id ? resolvedNoteTracks[source] : null;
  if (!events?.length) return [];
  const offset = Number(resolvedNoteTrackOffsets[source]) || 0;
  return events.map((event) => {
    const midi = assistedMidiFromEvent(event, state.transpose);
    if (!Number.isFinite(midi)) return null;
    return {
      t: (Number(event.t) || 0) + offset,
      d: Math.max(0.05, Number(event.d) || 0.12),
      midi,
      // Prava izmerena dinamika kada je transkripcija nosi. Tamo gde je
      // nema, pouzdanost detekcije je najpoštenija zamena: nesiguran ton se
      // svira tiše, ne kao čvrst.
      vel: Number.isFinite(Number(event.vel))
        ? Number(event.vel)
        : 0.5 + 0.35 * Math.max(0, Math.min(1, Number(event.confidence) ?? 0.7))
    };
  }).filter(Boolean);
}

function buildHarmonyEvents(song) {
  if (!state.harmonyPianoEnabled || !song) return [];
  const chords = Array.isArray(song.chords) ? song.chords : [];
  if (!chords.length) return [];
  const melodyEvents = resolvedNoteTrackSongId === song.id ? resolvedNoteTracks.melody : null;
  return renderHarmonyEvents(chords, songBeatGrid(song), {
    parseChord: (chord) => parseChordName(transposeChordName(chord.n)),
    patternName: state.compingPattern || null,
    endTime: getHeroDuration() || undefined,
    melodyMidiAt: melodyEvents?.length
      ? (time) => {
        const active = getActiveNoteEvents(melodyEvents, time)[0];
        return active ? assistedMidiFromEvent(active, state.transpose) : null;
      }
      : null
  });
}

/**
 * Osveži linije koje scheduler svira. Potpis sprečava da se iste note
 * ponovo učitavaju svakog frejma, jer bi to resetovalo kursor i zaustavilo
 * zvuk.
 */
function refreshGuidedPlayback(options = {}) {
  const song = getSelectedSong();
  const player = ensureScorePlayer();
  const lineSource = state.melodyTrackSource === "bass" ? "bass" : "melody";
  const lineOn = Boolean(song && state.trackMelody && state.melodyPianoEnabled);
  const harmonyOn = Boolean(song && state.harmonyPianoEnabled);

  const signature = [
    song?.id || "",
    lineOn ? lineSource : "-",
    lineOn ? resolvedNoteTracks[lineSource]?.length || 0 : 0,
    harmonyOn ? song?.chords?.length || 0 : 0,
    harmonyOn ? song?.chordChartRevision || 0 : 0,
    state.transpose,
    state.compingPattern || "",
    songBeatGrid(song)?.bpm || 0,
    songBeatGrid(song)?.beatsPerBar || 0,
    songBeatGrid(song)?.downbeatIndex || 0
  ].join("|");
  if (!options.force && signature === lastScoreSignature) return;
  lastScoreSignature = signature;

  // Mreža stiže asinhrono, posle prvog crtanja timeline-a. Bez ovoga bi
  // taktovne crte izostale sve dok korisnik ručno ponovo ne izabere pesmu.
  refreshBeatGridOverlay();

  player.setTrack("melody", lineOn ? buildGuidedLineEvents(lineSource) : []);
  player.setTrack("harmony", harmonyOn ? buildHarmonyEvents(song) : []);
}

function clearMelodyFingeringBadges() {
  document.querySelectorAll(".fingering-badge.melody-fingering").forEach((badge) => badge.remove());
}

function setMelodyFingeringBadge(midi, finger) {
  const key = state.keyElementsByMidi.get(midi);
  if (!key) return;
  let badge = key.querySelector(".fingering-badge.melody-fingering");
  if (!finger) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "fingering-badge melody-fingering";
    key.append(badge);
  }
  const label = String(finger);
  if (badge.textContent !== label) badge.textContent = label;
}

function getNoteTrackFingering(source, events) {
  if (!events?.length) return null;
  const transpose = Math.round(Number(state.transpose) || 0);
  const cached = noteFingeringCache[source];
  if (cached && cached.events === events && cached.transpose === transpose) return cached.fingers;
  // Prsti se računaju na tasterima koji se stvarno prikazuju (detektovani
  // registar + transpozicija), da bi pravila o crnim dirkama bila tačna.
  const fingers = computeMelodyFingering(
    events.map((event) => ({
      t: Number(event?.t) || 0,
      d: Number(event?.d) || 0,
      midi: Math.round(Number(event?.midi)) + transpose
    })),
    { hand: source === "bass" ? "left" : "right" }
  );
  noteFingeringCache[source] = { events, transpose, fingers };
  return fingers;
}

// ---------------- VEŽBANJE MELODIJE TON PO TON ----------------
function collectPressedMidis() {
  const pressed = new Set();
  midiHeld.forEach((midi) => pressed.add(midi));
  state.activeMidiSet.forEach((midi) => pressed.add(midi));
  return pressed;
}

function clearMelodyPracticeVisuals() {
  melodyPracticeVisualMidis.forEach((midi) => {
    const key = state.keyElementsByMidi.get(midi);
    if (!key) return;
    key.classList.remove("melody-hint", "melody-upcoming");
    key.querySelector(".fingering-badge.melody-fingering")?.remove();
  });
  melodyPracticeVisualMidis = new Set();
}

function paintMelodyPracticeTarget() {
  if (!melodyPractice) return;
  clearMelodyPracticeVisuals();
  const { events, source } = melodyPractice;
  const event = events[melodyPractice.index];
  if (!event) return;
  const targetMidi = assistedMidiFromEvent(event, state.transpose);
  if (!Number.isFinite(targetMidi)) {
    melodyPractice.index += 1;
    if (melodyPractice.index < events.length) paintMelodyPracticeTarget();
    return;
  }

  const key = state.keyElementsByMidi.get(targetMidi);
  key?.classList.add("melody-hint");
  melodyPracticeVisualMidis.add(targetMidi);
  key?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });

  let fingerText = "";
  if (state.showFingering) {
    const finger = getNoteTrackFingering(source, events)?.[melodyPractice.index];
    if (finger) {
      setMelodyFingeringBadge(targetMidi, finger);
      fingerText = ` · prst ${finger}`;
    }
  }

  // Najavi sledeća dva različita tona da ruka stigne da se pripremi.
  const upcoming = [];
  for (let index = melodyPractice.index + 1; index < events.length && upcoming.length < 2; index += 1) {
    const midi = assistedMidiFromEvent(events[index], state.transpose);
    if (Number.isFinite(midi) && midi !== targetMidi && !upcoming.includes(midi)) upcoming.push(midi);
  }
  upcoming.forEach((midi) => {
    const element = state.keyElementsByMidi.get(midi);
    if (!element || melodyPracticeVisualMidis.has(midi)) return;
    element.classList.add("melody-upcoming");
    melodyPracticeVisualMidis.add(midi);
  });

  setPipeStatus(`🎯 Ton ${melodyPractice.index + 1}/${events.length}: ${noteLabel(targetMidi)}${fingerText}`);
}

function toggleMelodyPractice() {
  if (melodyPractice) {
    stopMelodyPractice();
    return;
  }
  const source = state.melodyTrackSource === "bass" ? "bass" : "melody";
  const events = resolvedNoteTracks[source];
  if (!events?.length) {
    setPipeStatus(noteTrackUnavailableMessage(source));
    return;
  }
  stopPracticeMode({ pauseRecording: false });
  if (rec.playing) {
    recStop(true);
    updateRecordedPlaybackControls();
  }
  ensureAudio();
  // Ukloni ostatke playback-praćenja pre ciljanja, da kasniji frame ne
  // obriše bedž i oznake mete.
  clearTimedNoteTracking();
  const offset = Number(resolvedNoteTrackOffsets[source]) || 0;
  const trackTime = Math.max(0, getLivePlaybackTime() - offset);
  let index = events.findIndex((entry) => (Number(entry.t) || 0) >= trackTime - 0.05);
  if (index < 0) index = 0;
  melodyPractice = { source, events, index };
  melodyPracticeLastPressed = collectPressedMidis();
  $("melodyPracticeButton")?.classList.add("primary-button");
  paintMelodyPracticeTarget();
}

function stopMelodyPractice(options = {}) {
  if (!melodyPractice) return;
  melodyPractice = null;
  melodyPracticeLastPressed = new Set();
  clearMelodyPracticeVisuals();
  $("melodyPracticeButton")?.classList.remove("primary-button");
  if (!options.silent) setPipeStatus("Vežba melodije zaustavljena.");
}

function checkMelodyPractice() {
  if (!melodyPractice) return;
  const pressed = collectPressedMidis();
  const fresh = [...pressed].filter((midi) => !melodyPracticeLastPressed.has(midi));
  melodyPracticeLastPressed = pressed;
  if (!fresh.length) return;
  const event = melodyPractice.events[melodyPractice.index];
  const targetMidi = assistedMidiFromEvent(event, state.transpose);
  if (!fresh.includes(targetMidi)) return;
  melodyPractice.index += 1;
  if (melodyPractice.index >= melodyPractice.events.length) {
    stopMelodyPractice({ silent: true });
    playSuccessBeep();
    setPipeStatus("🎉 Bravo! Cela linija je odsvirana do kraja.");
    return;
  }
  paintMelodyPracticeTarget();
}

function isSongPlaybackRunning(song) {
  return isLocalSong(song) ? rec.playing : state.youtubeDesiredPlaying;
}

function updateTimedNoteTracking(song, time, wallTime) {
  const source = state.melodyTrackSource === "bass" ? "bass" : "melody";
  const playing = Boolean(song && state.trackMelody && state.melodyPianoEnabled && isSongPlaybackRunning(song));
  const events = resolvedNoteTrackSongId === song?.id ? resolvedNoteTracks[source] : [];
  if (!playing || !events?.length) {
    if (lastTimedEventKeys.size || lastTimedVisualMidis.size) clearTimedNoteTracking();
    return;
  }

  const previousClock = lastTimedTrackClock;
  const elapsedWall = previousClock ? Math.max(0, (wallTime - previousClock.wallTime) / 1000) : 0;
  const expectedAdvance = elapsedWall * Math.max(0.1, Number(state.playbackRate) || 1);
  const actualAdvance = previousClock ? time - previousClock.time : 0;
  const discontinuity = !previousClock
    || previousClock.songId !== song.id
    || previousClock.source !== source
    || actualAdvance < -0.03
    || Math.abs(actualAdvance - expectedAdvance) > 0.14;

  // Track analysis may carry a calibrated stem/mix alignment offset. Events
  // are queried on their own time axis while the player remains in mix time.
  const trackTime = Math.max(0, time - (Number(resolvedNoteTrackOffsets[source]) || 0));
  const activeEvents = getActiveNoteEvents(events, trackTime);
  if (discontinuity) catchUpHeldEvents.clear();
  catchUpHeldEvents.forEach((held, key) => {
    if (held.untilWall <= wallTime) catchUpHeldEvents.delete(key);
  });

  const toPlayableMidi = (event) => {
    // Assisted playback uses the exact detected register. Manual octave,
    // voicing and visible-keyboard settings belong only to the user keyboard.
    return assistedMidiFromEvent(event, state.transpose);
  };

  // Zvuk više ne ide odavde. Tonove zakazuje `score-player` na WebAudio satu
  // 150 ms unapred, pa kratak ton ne može da propadne između dva frejma i
  // stari `catchUpHeldEvents` krpež više nije potreban. Ova petlja od sada
  // radi samo ono za šta je frejm dovoljno tačan: bojenje dirki i prstored.
  const eventKeys = new Map();
  const fingering = state.showFingering ? getNoteTrackFingering(source, events) : null;
  const fingerByMidi = new Map();
  activeEvents.forEach((event) => {
    const midi = toPlayableMidi(event);
    if (!Number.isFinite(midi)) return;
    eventKeys.set(midi, `${song.id}:${source}:${event.index}:${event.t}`);
    const finger = fingering?.[event.index];
    if (finger) fingerByMidi.set(midi, finger);
  });

  const visualMidis = new Set(eventKeys.keys());
  lastTimedVisualMidis.forEach((midi) => {
    if (!visualMidis.has(midi)) {
      state.keyElementsByMidi.get(midi)?.classList.remove("melody-hint");
      setMelodyFingeringBadge(midi, null);
    }
  });
  visualMidis.forEach((midi) => {
    if (!lastTimedVisualMidis.has(midi)) state.keyElementsByMidi.get(midi)?.classList.add("melody-hint");
    setMelodyFingeringBadge(midi, fingerByMidi.get(midi) || null);
  });

  // Najava: bledo osvetli do tri različita tona koji uskoro počinju, da ruka
  // stigne da se pripremi. Prozor prati brzinu reprodukcije.
  const lookahead = Math.min(2.6, Math.max(0.9, 1.7 * Math.max(0.25, Number(state.playbackRate) || 1)));
  const upcomingMidis = new Set();
  getNoteEventsStartingBetween(events, trackTime + 0.001, trackTime + lookahead).some((event) => {
    const midi = toPlayableMidi(event);
    if (Number.isFinite(midi) && !visualMidis.has(midi)) upcomingMidis.add(midi);
    return upcomingMidis.size >= 3;
  });
  lastUpcomingMidis.forEach((midi) => {
    if (!upcomingMidis.has(midi)) state.keyElementsByMidi.get(midi)?.classList.remove("melody-upcoming");
  });
  upcomingMidis.forEach((midi) => {
    if (!lastUpcomingMidis.has(midi)) state.keyElementsByMidi.get(midi)?.classList.add("melody-upcoming");
  });
  lastUpcomingMidis = upcomingMidis;

  lastTimedVisualMidis = visualMidis;
  lastTimedEventKeys = eventKeys;
  lastTimedTrackClock = { songId: song.id, source, time, trackTime, wallTime };
}

function clearHarmonyHints() {
  state.keyElementsByMidi.forEach((element) => element.classList.remove("harmony-hint"));
}

/**
 * Bojenje dirki za akord koji trenutno zvuči. Zvuk harmonije više ne ide
 * odavde: pratnju unapred pripremi `renderHarmonyEvents` i zakaže scheduler,
 * jer jedan blok akord držan dva takta nije klavirska pratnja nego orgulje.
 */
function updateHarmonyPiano(chordName) {
  clearHarmonyHints();
  if (!state.harmonyPianoEnabled || !chordName) return;

  // Playback tracking reads the already-transposed label from the visible
  // chart, so transposing it again would move harmony by two intervals.
  const parsed = parseChordName(chordName);
  if (!parsed) return;

  getKeyboardChordMidis(parsed).forEach((midi) => {
    state.keyElementsByMidi.get(midi)?.classList.add("harmony-hint");
  });
}

function getKeyboardChordMidis(parsed) {
  // Chart harmony has its own stable register. The octave selector and chord
  // voicing controls belong exclusively to manual keyboard playing.
  const rootMidi = noteToMidi(parsed.pc, 4);
  return [...new Set(parsed.ivs.map((interval) => rootMidi + interval))]
    .filter((midi) => state.keyElementsByMidi.has(midi))
    .sort((a, b) => a - b);
}

function getLivePlaybackTime() {
  const song = getSelectedSong();
  if (isLocalSong(song)) {
    return Math.max(0, Number(recTime()) || 0);
  }

  if (state.youtubePlayerReady && state.youtubePlayer && typeof state.youtubePlayer.getCurrentTime === "function") {
    const actualTime = Math.max(0, Number(state.youtubePlayer.getCurrentTime()) || 0);
    const pendingTime = getPendingRemoteSeekTime(song, actualTime);
    return pendingTime === null ? actualTime : pendingTime;
  }

  const pendingTime = getPendingRemoteSeekTime(song, null);
  if (pendingTime !== null) return pendingTime;
  return Math.max(0, Number(rec.offset) || 0);
}

function syncHybridVideoClock(song, localTime, now) {
  if (!isHybridYouTubeSong(song) || !isLocalSong(song) || !rec.playing) return;
  if (now - lastHybridVideoSyncAt < 250) return;
  lastHybridVideoSyncAt = now;
  const player = state.youtubePlayer;
  if (!player || !state.youtubePlayerReady || state.youtubeLoadedVideoId !== song.videoId) {
    ensureHybridVideoLoaded(song, { autoplay: false }).then((loaded) => {
      if (!loaded || state.selectedSongId !== song.id || !rec.playing) return;
      setHybridYouTubeAudioMode(loaded, true);
      if (typeof loaded.seekTo === "function") loaded.seekTo(localTimeToHybridVideoTime(song, localTime), true);
      if (typeof loaded.playVideo === "function") loaded.playVideo();
    }).catch(() => {});
    return;
  }
  setHybridYouTubeAudioMode(player, true);
  const targetVideoTime = localTimeToHybridVideoTime(song, localTime);
  const videoTime = typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) : NaN;
  if (Number.isFinite(videoTime) && Math.abs(videoTime - targetVideoTime) > 0.15 && typeof player.seekTo === "function") {
    player.seekTo(targetVideoTime, true);
  }
}

function scrollLearningCellIntoView(cell, behavior = "smooth") {
  if (!cell || typeof cell.scrollIntoView !== "function") return;
  const now = Date.now();
  if (behavior === "smooth" && now - lastLearningScrollAt < 450) return;
  lastLearningScrollAt = now;
  cell.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
}

function syncLearningChartAtTime(time, options = {}) {
  const t = Math.max(0, Number(time) || 0);
  const song = getSelectedSong();
  const chords = Array.isArray(song?.chords) ? song.chords : [];
  const timingOffsetSeconds = Number(
    song?.chordTimingOffsetSeconds ?? song?.analysis?.chordTimingOffsetSeconds
  ) || 0;
  const chartTime = t - timingOffsetSeconds;
  let activeIndex = findActiveChordIndex(chords, t, { timingOffsetSeconds });
  const hasChordEndTime = song?.chordEndTime !== null && song?.chordEndTime !== undefined && song?.chordEndTime !== "";
  const chordEndTime = Number(song?.chordEndTime);
  if (
    activeIndex === chords.length - 1 &&
    hasChordEndTime &&
    Number.isFinite(chordEndTime) &&
    chartTime >= chordEndTime - 1e-9
  ) {
    activeIndex = -1;
  }
  if (
    activeIndex < 0 &&
    options.allowBeforeFirst &&
    chords.length &&
    chartTime < (Number(chords[0]?.t) || 0)
  ) activeIndex = 0;
  const currentName = activeIndex >= 0 ? transposeChordName(chords[activeIndex].n) : null;
  let activeCell = null;

  ["miniChart", "ccStrip"].forEach((id) => {
    const wrap = $(id);
    if (!wrap) return;
    const cells = [...wrap.querySelectorAll("[data-t]")];
    if (!cells.length) return;

    const current = activeIndex >= 0 ? cells[activeIndex] || null : null;

    cells.forEach((cell) => {
      const isCurrent = cell === current;
      cell.classList.toggle("now", isCurrent);
      cell.classList.toggle("on", isCurrent);
    });

    if (current) {
      if (id === "miniChart" && !$("ccStrip")) activeCell = current;
    }
  });

  if (activeCell && options.scroll !== false) {
    scrollLearningCellIntoView(activeCell, options.force ? "auto" : "smooth");
  }

  return currentName;
}

function trackPlaybackAndHighlight() {
  const now = performance.now();
  const currentSong = getSelectedSong();
  if (!currentSong) {
    clearTimedNoteTracking();
    return;
  }
  const t = getLivePlaybackTime();
  syncHybridVideoClock(currentSong, t, now);
  // Note events run from the playback clock on every animation frame. Chart
  // repainting below may be throttled while paused, but musical articulation
  // (including repeated equal notes) must never inherit that UI throttle.
  updateTimedNoteTracking(currentSong, t, now);
  // Follow the playback clock every animation frame while audio is running;
  // a 33 ms throttle was itself one extra visible frame of boundary latency.
  const paintInterval = rec.playing || state.youtubeDesiredPlaying ? 16 : 180;
  if (now - lastPlaybackPaintAt < paintInterval) return;
  lastPlaybackPaintAt = now;
  const heroScrubbing = $("heroWaveform")?.classList.contains("is-scrubbing");
  if (!heroScrubbing) updateHeroPlaybackVisuals(t);

  if (rec.playing || rec.buffer) {
    updateRecordedPlaybackControls();
  }
  // Scheduler sam gasi glasove kada reprodukcija stane; ovde se samo prati
  // da li se sadržaj linija promenio.
  refreshGuidedPlayback();

  const currentName = heroScrubbing
    ? null
    : syncLearningChartAtTime(t, { allowBeforeFirst: state.practiceModeActive });

  if (!currentName) {
    lastFollowedChord = null;
    if (state.currentPlaybackChordName) {
      state.currentPlaybackChordName = null;
      state.currentPlaybackChordTime = t;
      updateHarmonyPiano(null);
    }
  }

  if (currentName && currentName !== lastFollowedChord) {
    lastFollowedChord = currentName;
    state.currentPlaybackChordName = currentName;
    state.currentPlaybackChordTime = t;
    updateHarmonyPiano(currentName);
    if (state.tool === "krug") {
      renderTool();
    }
    if (!state.practiceModeActive && state.tool !== "skale" && state.tool !== "vezba") {
      paintChordName(currentName, true);
    }
  }

  if (!currentName && state.harmonyPianoEnabled) updateHarmonyPiano("");

  if (state.practiceModeActive && state.practiceFollowPlayback) {
    updatePracticeFollowHighlight(false);
  }
}
// A short description of what this browser ended up with, sent to the local
// service so a fault can be read instead of guessed. It has taken hours to
// learn that an empty area on a screenshot can mean four different things.
// Local only: it goes to the service on this machine and nowhere else.
function reportRenderState(reason) {
  try {
    if (!processingClient?.configured) return;
    const song = getSelectedSong();
    const strip = document.getElementById("ccStrip");
    const body = document.getElementById("toolBody");
    const rect = strip ? strip.getBoundingClientRect() : null;
    const report = {
      reason,
      build: document.getElementById("fgrBuildTag")?.textContent || "",
      tool: state.tool,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      songs: state.repertoire.map((entry) => ({
        id: entry.id,
        chords: (entry.chords || []).length,
        stems: (entry.availableStems || []).length,
        notes: Object.fromEntries(
          Object.entries(entry.noteTracks || {}).map(([name, track]) => [name, (track?.events || []).length])
        ),
        processing: entry.processing?.state || ""
      })),
      selected: song?.id || null,
      toolBodyChars: body ? body.innerHTML.length : -1,
      strip: strip
        ? {
            chords: strip.querySelectorAll(".cc").length,
            melody: strip.querySelectorAll(".chart-line-melody .chart-note").length,
            bass: strip.querySelectorAll(".chart-line-bass .chart-note").length,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: rect.height > 0 && rect.width > 0
          }
        : null,
      renderError: body?.querySelector(".tool-render-error-detail")?.textContent || null,
      lastError: window.__fgrLastError || null
    };
    fetch(resolveDiagnosticsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report)
    }).catch(() => {});
  } catch (_error) {
    // Diagnostics must never be the thing that breaks the page.
  }
}

function resolveDiagnosticsUrl() {
  const base = String(processingClient?.baseUrl || "").replace(/\/+$/, "");
  return `${base}/v1/diagnostics`;
}

window.addEventListener("error", (event) => {
  window.__fgrLastError = String(event?.message || "") + " @ " + String(event?.filename || "") + ":" + String(event?.lineno || "");
});

/**
 * Is anything actually serving this app, or is it a frozen cache?
 *
 * A service worker will happily serve a months-old copy of the whole app with
 * no server running at all. Nothing looks wrong: the page loads, buttons work,
 * and every change made since then is invisible. Worse, any module the cache
 * never stored comes back as the app shell, so startup dies halfway through
 * and the screen simply stays empty. Both states have to announce themselves.
 */
async function checkBackendReachable() {
  const banner = document.getElementById("backendWarning");
  if (!banner) return;
  let reachable = false;
  try {
    const base = String(processingClient?.baseUrl || state.processingServiceUrl || "").replace(/\/+$/, "");
    const response = await fetch(`${base}/v1/health?probe=${Date.now()}`, { cache: "no-store" });
    reachable = response.ok;
  } catch (_error) {
    reachable = false;
  }
  banner.hidden = reachable;
  if (!reachable) {
    banner.textContent =
      "Servis za obradu nije pokrenut. Pokreni \u201ePokreni FGR\u201c \u2014 bez njega aplikacija radi iz kesa i ne vidi ni pesme ni izmene.";
  }
}

// ---------------- POMOCNI PWA SERVISI ----------------
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // A new worker calls skipWaiting and claims the open pages, but the page it
  // claims is still running the code it was loaded with. Without this reload
  // an update looks like it did nothing: the tab reports the new cache while
  // executing the previous version, and the only way out was to know to press
  // reload twice. Guarded so the reload can happen at most once per load.
  // Only when a worker was already in charge. On a first visit there is no
  // controller and nothing stale to escape, and reloading there would be a
  // pointless flash at best and a reload loop at worst.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((registration) => {
      // Ask on every start, so a machine left open overnight still updates.
      registration.update().catch(() => {});
    }).catch(() => {});
  });
}

// Globalni FGRBridge interfejs za komunikaciju sa drugim skriptama
window.FGRBridge = {
  getSelectedSong() {
    return getSelectedSong();
  },
  getBaseOctave() {
    return state.baseOctave;
  },
  getTime() {
    const player = state.youtubePlayer;
    return isLocalSong(getSelectedSong())
      ? recTime()
      : (player && typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) || 0 : 0);
  },
  getDuration() {
    return getHeroDuration();
  },
  seekTo(seconds) {
    return seekSelectedPlaybackTo(seconds);
  },
  setRate(rate) {
    state.playbackRate = clamp(Number(rate) || 1, 0.25, 1.5);
    savePlayerSettings();
    if (recSpeedSelect && [...recSpeedSelect.options].some((option) => Number(option.value) === state.playbackRate)) {
      recSpeedSelect.value = String(state.playbackRate);
    }
    const player = state.youtubePlayer;
    if (player && typeof player.setPlaybackRate === "function") {
      player.setPlaybackRate(state.playbackRate);
    }
    recRetune();
  },
  playFromStart() {
    const song = getSelectedSong();
    if (!song) return false;

    if (isLocalSong(song)) {
      ensureAudio();
      recLoad().then((ok) => {
        if (ok) {
          state.youtubeDesiredPlaying = true;
          recPlayFrom(0);
        }
      });
    } else {
      playFromStart();
    }
    return true;
  },
  addChordToSelected(name, atSeconds) {
    return commitChordInsertion(getSelectedSong(), name, atSeconds);
  },
  setChordsForSelected(chords) {
    const song = getSelectedSong();
    if (!song || !Array.isArray(chords)) return false;
    
    song.chords = chords
      .map((chord) => ({ t: Math.max(0, Math.round((Number(chord?.t) || 0) * 1000) / 1000), n: String(chord?.n || "").trim() }))
      .filter((chord) => chord.n)
      .sort((a, b) => a.t - b.t);
    reconcileSongChordEndTime(song);
      
    saveRepertoire();
    patchSongChordsOnService(song);
    updateSelectedSongPanel();
    renderMiniChart();
    return true;
  },
  removeChordFromSelected(index) {
    const song = getSelectedSong();
    if (!song || !Array.isArray(song.chords) || !song.chords[index]) return false;
    
    song.chords.splice(index, 1);
    reconcileSongChordEndTime(song);
    saveRepertoire();
    patchSongChordsOnService(song);
    updateSelectedSongPanel();
    renderMiniChart();
    return true;
  }
};

// Pokretanje
init().catch((error) => {
  console.error("FGR initialization failed.", error);
});

// ---------------- INTERAKTIVNI MOD ZA VEZBANJE PESME ----------------
function startRecordedPlaybackOnly() {
  ensureAudio();
  recLoad().then((ok) => {
    if (!ok) {
      setPipeStatus("Nema naseg snimka za ovu pesmu.");
      return;
    }
    if (rec.ctx.state === "suspended") rec.ctx.resume();
    if (state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
      state.youtubePlayer.pauseVideo();
    }
    recPlayFrom(rec.offset || 0);
    updateRecRow();
    setPipeStatus("Pustam nas snimak. Dodaj/prepoznaj akorde za vodjeno vezbanje.");
  }).catch((err) => {
    setPipeStatus("Greska: " + err.message);
  });
}
function togglePracticeMode() {
  if (state.practiceModeActive) {
    stopPracticeMode();
    return;
  }

  if (rec.playing) {
    recStop(true);
    updateRecordedPlaybackControls();
    setPipeStatus("");
    return;
  }

  const song = getSelectedSong();
  if (!song) {
    alert("Prvo izaberi pesmu u listi!");
    return;
  }

  if (!song.chords || !song.chords.length) {
    startRecordedPlaybackOnly();
    return;
  }

  stopMelodyPractice({ silent: true });
  ensureAudio();
  recLoad().then((ok) => {
    if (!ok) {
      setPipeStatus("Nema naseg snimka za ovu pesmu. Prvo uradi 'Snimi jednom'.");
      return;
    }

    if (rec.ctx.state === "suspended") rec.ctx.resume();
    if (state.youtubePlayer && typeof state.youtubePlayer.pauseVideo === "function") {
      state.youtubePlayer.pauseVideo();
    }

    state.practiceModeActive = true;
    state.practiceFollowPlayback = true;
    state.practiceSongChords = [...song.chords];
    state.practiceCurrentIndex = -1;

    setPracticeButtonActive(true);
    const startAt = rec.offset > 0 && rec.buffer && rec.offset < rec.buffer.duration - 0.25 ? rec.offset : 0;
    recPlayFrom(startAt);
    updateRecRow();
    setPipeStatus("Vezba ide iz naseg snimka. Plavi akord prati chart po vremenu.");
    updatePracticeFollowHighlight(true);
  }).catch((err) => {
    setPipeStatus("Greska: " + err.message);
  });
}

function stopPracticeMode(options = {}) {
  const pauseRecording = options.pauseRecording !== false;
  if (pauseRecording && state.practiceFollowPlayback && rec.playing) {
    recStop(true);
    updateRecordedPlaybackControls();
  }

  state.practiceModeActive = false;
  state.practiceFollowPlayback = false;
  state.practiceSongChords = null;
  state.practiceCurrentIndex = -1;

  setPracticeButtonActive(false);
  clearPracticeHints();
  setPipeStatus("");
}

function setPracticeButtonActive(active) {
  const btn = $("practiceSongButton");
  if (!btn) return;
  btn.classList.toggle("practice-active", active);
  updatePracticeButtonLabel();
}

function updatePracticeButtonLabel() {
  const btn = $("practiceSongButton");
  if (!btn) return;
  if (state.practiceModeActive || rec.playing) {
    btn.textContent = "\u25A0 Zaustavi";
  } else {
    btn.textContent = "◉  Vežbaj uz pesmu";
  }
  btn.classList.toggle("practice-active", state.practiceModeActive || rec.playing);
}

function updatePracticeFollowHighlight(force) {
  if (!state.practiceModeActive || !state.practiceFollowPlayback || !state.practiceSongChords) return;
  const t = rec.playing ? recTime() : rec.offset;
  const index = getPracticeChordIndexAtTime(t);
  if (index !== state.practiceCurrentIndex || force) {
    state.practiceCurrentIndex = index;
    highlightPracticeChord();
  }
}

function getPracticeChordIndexAtTime(time) {
  let index = -1;
  for (let i = 0; i < state.practiceSongChords.length; i++) {
    if (Number(state.practiceSongChords[i].t) <= time + 0.08) {
      index = i;
    }
  }
  return index < 0 ? 0 : index;
}

function highlightPracticeChord() {
  if (!state.practiceModeActive || !state.practiceSongChords) return;
  const chord = state.practiceSongChords[state.practiceCurrentIndex];
  if (!chord) {
    if (!state.practiceFollowPlayback) {
      playSuccessBeep();
      alert("Cestitamo! Uvezbali ste pesmu!");
      stopPracticeMode();
    }
    return;
  }

  const shownName = transposeChordName(chord.n);
  state.currentPlaybackChordName = shownName;
  state.currentPlaybackChordTime = Number(chord.t) || 0;
  setPipeStatus("Vežba: " + shownName + " na " + fmtChordTime(chord.t));
  paintPracticeChord(shownName);
  if (state.tool === "krug") {
    renderTool();
  }

  syncLearningChartAtTime(chord.t, { force: true });
}

function clearPracticeHints() {
  state.keyElementsByMidi.forEach((el) => {
    el.classList.remove("practice-hint");
    el.classList.remove("harmony-hint");
    el.querySelectorAll(".fingering-badge").forEach((badge) => badge.remove());
  });
}

function paintPracticeChord(name) {
  clearPracticeHints();

  const parsed = parseChordName(name);
  if (!parsed) return;

  const targetMidis = getKeyboardChordMidis(parsed);

  targetMidis.forEach((midi) => {
    const el = state.keyElementsByMidi.get(midi);
    if (el) el.classList.add("harmony-hint");
  });

  if (state.showFingering) {
    addFingeringBadges(targetMidis);
  }
}

function addFingeringBadges(midis) {
  const fingers = getFingeringPattern(midis.length);
  midis.forEach((midi, index) => {
    const key = state.keyElementsByMidi.get(midi);
    if (!key) return;
    const badge = document.createElement("span");
    badge.className = "fingering-badge";
    badge.textContent = String(fingers[index] || Math.min(index + 1, 5));
    key.append(badge);
  });
}

function getFingeringPattern(count) {
  if (count <= 1) return [1];
  if (count === 2) return [1, 5];
  if (count === 3) return [1, 3, 5];
  if (count === 4) return [1, 2, 3, 5];
  return [1, 2, 3, 4, 5].slice(0, count);
}

function checkPracticeChord() {
  if (state.practiceFollowPlayback) return;
  if (!state.practiceModeActive || !state.practiceSongChords) return;
  const chord = state.practiceSongChords[state.practiceCurrentIndex];
  if (!chord) return;

  const parsed = parseChordName(transposeChordName(chord.n));
  if (!parsed) return;

  const targetPcs = parsed.ivs.map((iv) => (parsed.pc + iv) % 12);

  const activePcs = new Set();
  midiHeld.forEach((m) => activePcs.add(((m % 12) + 12) % 12));
  state.activeMidiSet.forEach((m) => activePcs.add(((m % 12) + 12) % 12));

  const isMatch = targetPcs.every((pc) => activePcs.has(pc)) && activePcs.size === targetPcs.length;
  if (isMatch) {
    playSuccessBeep();
    state.practiceCurrentIndex++;

    const nextChord = state.practiceSongChords[state.practiceCurrentIndex];
    if (nextChord) {
      if (rec.playing) recSeek(nextChord.t);
      else if (state.youtubePlayerReady && typeof state.youtubePlayer.seekTo === "function") {
        state.youtubePlayer.seekTo(nextChord.t, true);
      }
    }

    setTimeout(() => {
      highlightPracticeChord();
    }, 450);
  }
}
function playSuccessBeep() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }
  const ctx = state.audioContext;
  if (ctx.state === "suspended") ctx.resume();
  
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(587.33, now); // D5
  osc.frequency.setValueAtTime(880, now + 0.08); // A5
  
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.26);
}

// ---------------- CONTEXT MENU, EDIT & SELECTION HELPERS ----------------
function showSongContextMenu(songId, clientX, clientY) {
  state.contextMenuSongId = songId;
  const menu = $("songContextMenu");
  if (!menu) return;
  
  menu.hidden = false;
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  
  const rect = menu.getBoundingClientRect();
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;
  
  if (clientX + rect.width > winWidth) {
    menu.style.left = `${winWidth - rect.width - 8}px`;
  }
  if (clientY + rect.height > winHeight) {
    menu.style.top = `${winHeight - rect.height - 8}px`;
  }
}

function hideSongContextMenu() {
  state.contextMenuSongId = null;
  const menu = $("songContextMenu");
  if (menu) {
    menu.hidden = true;
  }
}

function toggleSongSelection(songId) {
  if (state.selectedSongsForAction.has(songId)) {
    state.selectedSongsForAction.delete(songId);
  } else {
    state.selectedSongsForAction.add(songId);
  }
  renderCompactSongList();
}

function deleteSelectedSongs() {
  if (state.selectedSongsForAction.size === 0) return;
  if (confirm(`Da li ste sigurni da želite da obrišete ${state.selectedSongsForAction.size} selektovanih pesama?`)) {
    state.repertoire = state.repertoire.filter(song => !state.selectedSongsForAction.has(song.id));
    
    if (state.selectedSongsForAction.has(state.selectedSongId)) {
      state.selectedSongId = state.repertoire[0]?.id || null;
    }
    
    state.selectionModeActive = false;
    state.selectedSongsForAction.clear();
    
    saveRepertoire();
    renderRepertoire();
    updateSelectedSongPanel();
    updatePlaylistSelectionActionsVisibility();
  }
}

function cancelSelectionMode() {
  state.selectionModeActive = false;
  state.selectedSongsForAction.clear();
  renderCompactSongList();
  updatePlaylistSelectionActionsVisibility();
}

function updatePlaylistSelectionActionsVisibility() {
  const actionsEl = $("songSelectionActions");
  if (actionsEl) {
    actionsEl.hidden = !state.selectionModeActive;
  }
}

function openEditSongDialog(songId) {
  const song = state.repertoire.find((s) => s.id === songId);
  if (!song) return;
  
  state.editingSongId = songId;
  editSongTitleInput.value = song.title || "";
  editSongKeyInput.value = song.key || "";
  editSongUrlInput.value = song.url || "";
  
  editSongDialog.hidden = false;
  editSongTitleInput.focus();
}

function closeEditSongDialog() {
  state.editingSongId = null;
  editSongDialog.hidden = true;
}

function saveEditedSong() {
  const songId = state.editingSongId;
  const song = state.repertoire.find((s) => s.id === songId);
  if (!song) return;
  
  const title = editSongTitleInput.value.trim();
  const key = editSongKeyInput.value.trim();
  const url = editSongUrlInput.value.trim();
  const videoId = parseYouTubeVideoId(url);
  const localSource = song.source?.type === "upload";
  const previousVideoId = String(song.videoId || "");

  if (!localSource && !videoId) {
    setYouTubeStatus("Unesi YouTube link");
    editSongUrlInput.focus();
    return;
  }
  
  if (
    song.localCapture?.available
    && previousVideoId
    && videoId
    && previousVideoId !== videoId
  ) {
    dbDelete(`song-${song.id}`).catch(() => {});
    song.localCapture = null;
    song.localMixEnabled = false;
    song.stems = false;
    song.availableStems = [];
    song.assets = null;
    song.noteTracks = {};
    song.chords = [];
    song.chordChartRevision = 0;
    song.processing = null;
    song.duration = 0;
  }

  song.title = title || (localSource ? song.title : `YouTube ${videoId}`);
  song.key = key;
  if (!localSource || videoId) {
    song.url = url;
    song.videoId = videoId;
  }
  
  saveRepertoire();
  renderRepertoire();
  updateSelectedSongPanel();
  if (song.id === state.selectedSongId) {
    loadSelectedSong({ autoplay: false });
  }
  
  closeEditSongDialog();
  setYouTubeStatus("Izmenjeno");
}
