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
  updateMixerGains,
  dbGet,
  dbPut,
  dbGetAll,
  dbDelete,
  recId,
  noteToMidi,
  pitchFromMidi,
  octaveFromMidi
} from "./audio.js";

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
  fetchServerPlaylists, 
  putGitHubFile, 
  fetchGitHubFileMetadata, 
  slugifyPlaylistName, 
  buildRepertoireFileData, 
  normalizeRepertoireFileData,
  getGitHubToken,
  ensureGitHubToken
} from "./github.js";

import { 
  fmtTime, 
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
  getActiveHint
} from "./ui-tools.js";

// Cache DOM Elements
const $ = (id) => document.getElementById(id);

let app, keyboard, pianoScroll, volumeControl, octaveDown, octaveUp, octaveDisplay, labelsToggle;
let instrumentSelect, sustainToggle, sustainLengthControl, sustainLengthDisplay, pianoKeyboardToggle;
let omitExtensionRootToggle, closeVoicingToggle, retriggerChordToggle, resetMemoryButton;
let doubleTapSharpControl, doubleTapSharpDisplay, activeChordDisplay, selectedSongTitle;
let selectedSongKeyDisplay, youtubeStatus, youtubePlayPause, youtubeRewind, youtubeForward, youtubeSeekSeconds;
let playlistStart, playlistWorkspace, startLoadPlaylistButton, startNewPlaylistButton;
let loadPlaylistButton, newPlaylistButton, playlistDialog, playlistDialogTitle, playlistDialogClose, playlistBrowser;
let songTitleInput, songKeyInput, songUrlInput, addSongButton, songSearchInput, songSearchButton;
let mobileModifierButtons;
let abA = null, abB = null, abTimer = null;

function cacheDom() {
  app = $("app");
  keyboard = $("keyboard");
  pianoScroll = $("pianoScroll");
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
}

// Inicijalizacija aplikacije
function init() {
  cacheDom();
  
  // Primenjivanje sacuvane teme na pocetku
  applySavedTheme();
  
  // Renderovanje virtuelne klavijature
  renderKeyboard();
  window.dispatchEvent(new CustomEvent("fgr:keyboardready", {
    detail: { octave: state.baseOctave }
  }));
  
  loadRepertoireState();
  loadKeyboardSettings();
  renderRepertoire();
  updateSelectedSongPanel();
  updatePlaylistMode();
  bindEvents();
  updateOctaveControls();
  updateMobileModifierState();
  updateLabelVisibility();
  updateSustainLengthDisplay();
  updateDoubleTapSharpDisplay();
  
  // Ucitavanje metronoma
  initMetronome();
  
  // Ucitavanje alata
  renderTool();
  
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
  });

  // Promena instrumenta
  instrumentSelect.addEventListener("change", () => {
    state.instrument = instrumentSelect.value;
    stopAllSoundingNotes();
    recomputeSound();
  });

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
  });

  resetMemoryButton.addEventListener("click", () => {
    resetChordMemory();
  });

  document.querySelectorAll("input[name='extensionVoicing']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.extensionVoicing = input.value;
        recomputeSound();
      }
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

  // YouTube plejer kontrole
  youtubePlayPause.addEventListener("click", triggerSelectedSongToggle);
  youtubeRewind.addEventListener("click", () => seekYouTube(-getYouTubeSeekSeconds()));
  youtubeForward.addEventListener("click", () => seekYouTube(getYouTubeSeekSeconds()));
  youtubeSeekSeconds.addEventListener("input", () => {
    state.youtubeSeekSeconds = getYouTubeSeekSeconds();
    savePlayerSettings();
    updateYouTubeSeekButtons();
  });

  // Zasebne precice na vrhu Plejera
  const youtubeOpenExternal = $("youtubeOpenExternal");
  if (youtubeOpenExternal) youtubeOpenExternal.addEventListener("click", openSelectedSongOnYouTube);
  
  const speedButton = $("speedButton");
  const RATES = [1.0, 0.75, 0.5];
  let rateIndex = 0;
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
        if (abTimer) {
          window.clearInterval(abTimer);
          abTimer = null;
        }
        updateAbStatus("");
        abLoopButton.classList.remove("primary-button");
      }
    });
  }
  
  const themeToggle = $("themeToggle");
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);

  const settingsToggle = $("settingsToggle");
  const settingsPanel = $("settingsPanel");
  if (settingsToggle && settingsPanel) {
    settingsToggle.addEventListener("click", () => {
      const show = settingsPanel.hidden;
      settingsPanel.hidden = !show;
      settingsToggle.setAttribute("aria-expanded", show ? "true" : "false");
    });
  }

  const addSongToggle = $("addSongToggle");
  const addSongForm = $("addSongForm");
  if (addSongToggle && addSongForm) {
    addSongToggle.addEventListener("click", () => {
      addSongForm.hidden = !addSongForm.hidden;
    });
  }

  // ---------------- EVENT HANDLERI IZ DRUGIH MODULA ----------------
  window.addEventListener("fgr:songchange", (e) => {
    const song = e.detail && e.detail.song ? e.detail.song : null;
    const pillTitle = $("pillTitle");
    const pillKey = $("pillKey");
    
    if (pillTitle) pillTitle.textContent = song ? (song.title || "(bez naziva)") : "Izaberi pesmu";
    if (pillKey) {
      pillKey.hidden = !(song && song.key);
      pillKey.textContent = song && song.key ? song.key : "";
    }
    
    updateToneCard();
    renderMiniChart();
    refreshPipe();
    
    // Zaustavljanje lokalnog snimka pri promeni pesme
    recStop(false);
    rec.buffer = null;
    rec.bufferId = null;
    updateRecRow();
    
    // Zaustavljanje A-B petlje pri promeni pesme
    abA = null;
    abB = null;
    if (abTimer) {
      window.clearInterval(abTimer);
      abTimer = null;
    }
    updateAbStatus("");
    if (abLoopButton) {
      abLoopButton.classList.remove("primary-button");
    }
  });
  
  window.addEventListener("fgr:octavechange", () => {
    if (["akordi", "skale", "vezba"].indexOf(state.tool) !== -1) {
      clearScale();
      renderTool();
    } else {
      const hint = getActiveHint();
      if (hint && !hint.autoClear) renderHint(hint);
      else clearScale();
    }
  });

  window.addEventListener("fgr:playchange", (event) => {
    const midis = event.detail.midis;
    const pcs = event.detail.pcs;
    
    // Azuriranje virtuelnih dirki na ekranu
    state.keyElementsByMidi.forEach((element, midi) => {
      element.classList.toggle("is-active", midis.includes(midi));
    });
  });

  window.addEventListener("fgr:midichange", () => {
    syncStage();
  });

  window.addEventListener("fgr:recupdate", () => {
    updateRecRow();
  });

  // Dodavanje, izmena i brisanje akorada u chartu preko dogadjaja
  window.addEventListener("fgr:seekrequest", (e) => {
    const time = e.detail.time;
    if (rec.playing) recSeek(time);
    else if (state.youtubePlayer && typeof state.youtubePlayer.seekTo === "function") {
      state.youtubePlayer.seekTo(time, true);
    }
  });

  window.addEventListener("fgr:removechordrequest", (e) => {
    const index = e.detail.index;
    const song = getSelectedSong();
    if (song && Array.isArray(song.chords) && song.chords[index]) {
      song.chords.splice(index, 1);
      saveRepertoire();
      updateSelectedSongPanel();
      renderMiniChart();
      if (state.tool === "chart") renderTool();
    }
  });

  window.addEventListener("fgr:addchordrequest", () => {
    const song = getSelectedSong();
    if (!song) return;
    const player = state.youtubePlayer;
    const t = rec.playing ? recTime() : (player && typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) || 0 : 0);
    const name = prompt(`Akord na ${fmtTime(t)}:`, "");
    if (name) {
      song.chords = Array.isArray(song.chords) ? song.chords : [];
      song.chords.push({ t: Math.round(t * 10) / 10, n: name.trim() });
      song.chords.sort((a, b) => a.t - b.t);
      saveRepertoire();
      updateSelectedSongPanel();
      renderMiniChart();
      if (state.tool === "chart") renderTool();
    }
  });

  // ---------------- LOKALNO SNIMANJE I ANALIZA (Skidanje pesme) ----------------
  const pipeRecBtn = $("pipeRec");
  if (pipeRecBtn) {
    pipeRecBtn.addEventListener("click", () => {
      if (capRec && capRec.state === "recording") {
        stopCapture();
      } else {
        startCapture();
      }
    });
  }

  const pipeChordsBtn = $("pipeChords");
  if (pipeChordsBtn) {
    pipeChordsBtn.addEventListener("click", runOfflineChordAnalysis);
  }

  const pipeReadBtn = $("pipeRead");
  if (pipeReadBtn) {
    pipeReadBtn.addEventListener("click", () => selectTool("chart"));
  }

  // Lokalni snimak plejer dugme
  const recPlayBtn = $("recPlayBtn");
  if (recPlayBtn) {
    recPlayBtn.addEventListener("click", () => {
      if (rec.playing) {
        recStop(true);
        updateRecRow();
      } else {
        recLoad().then((ok) => {
          if (!ok) {
            setPipeStatus("Nema snimka za ovu pesmu.");
            return;
          }
          if (rec.ctx.state === "suspended") rec.ctx.resume();
          recPlayFrom(rec.offset);
          updateRecRow();
        });
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

  bindMixerEvents();

  // Periodicni tajmer za pracenje pesme i bojenje akorda na klavijaturi
  window.setInterval(trackPlaybackAndHighlight, 600);
}

function bindMixerEvents() {
  const channels = ["Bass", "Mid", "High"];
  const keys = { Bass: "bass", Mid: "mid", High: "high" };

  channels.forEach((chan) => {
    const volInput = $(`mix${chan}Vol`);
    const muteBtn = $(`mix${chan}Mute`);
    const soloBtn = $(`mix${chan}Solo`);
    const key = keys[chan];

    if (volInput) {
      volInput.addEventListener("input", () => {
        state.mixer[key].volume = Number(volInput.value) / 100;
        updateMixerGains();
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener("click", () => {
        state.mixer[key].mute = !state.mixer[key].mute;
        muteBtn.classList.toggle("on-mute", state.mixer[key].mute);
        updateMixerGains();
      });
    }

    if (soloBtn) {
      soloBtn.addEventListener("click", () => {
        state.mixer[key].solo = !state.mixer[key].solo;
        soloBtn.classList.toggle("on-solo", state.mixer[key].solo);
        updateMixerGains();
      });
    }
  });
}

// ---------------- VIRTUELNA KLAVIJATURA ----------------
function renderKeyboard() {
  keyboard.innerHTML = "";
  state.keyElementsByMidi.clear();

  const LOWEST_MIDI = noteToMidi(7, 1); // C2..
  const HIGHEST_MIDI = noteToMidi(11, 7);

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

function saveKeyboardSettings() {
  writeJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {
    doubleTapSharpMs: state.doubleTapSharpMs,
    closeVoicingEnabled: state.closeVoicingEnabled,
    dugmetaraRows: state.dugmetaraRows
  });
}

function loadKeyboardSettings() {
  const settings = readJsonStorage(KEYBOARD_SETTINGS_STORAGE_KEY, {});
  state.doubleTapSharpMs = clamp(Number(settings.doubleTapSharpMs) || 90, 30, 250);
  state.closeVoicingEnabled = Boolean(settings.closeVoicingEnabled);
  state.dugmetaraRows = settings.dugmetaraRows === "3" ? "3" : "4";
  
  if (doubleTapSharpControl) {
    doubleTapSharpControl.value = String(state.doubleTapSharpMs);
  }
  if (closeVoicingToggle) {
    closeVoicingToggle.checked = state.closeVoicingEnabled;
  }
  document.querySelectorAll("input[name='dugmetaraRows']").forEach((input) => {
    input.checked = input.value === state.dugmetaraRows;
  });
}

// ---------------- REPERTOAR / PLAYLIST MENADZMENT ----------------
function loadRepertoireState() {
  const playlist = readJsonStorage(REPERTOIRE_STORAGE_KEY, null);
  const data = normalizeRepertoireFileData(playlist || { songs: [] });
  state.activePlaylistName = String(playlist?.name || "");
  state.activePlaylistPath = String(playlist?.path || "");
  state.activePlaylistSha = String(playlist?.sha || "");
  state.repertoire = data.songs;

  const settings = readJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {});
  state.youtubeSeekSeconds = clamp(Number(settings.seekSeconds) || 10, 1, 60);
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

function savePlayerSettings() {
  writeJsonStorage(PLAYER_SETTINGS_STORAGE_KEY, {
    selectedSongId: state.selectedSongId,
    seekSeconds: state.youtubeSeekSeconds
  });
}

function scheduleServerPlaylistSave(delay = 700) {
  if (!state.activePlaylistPath) return;
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
  if (!state.activePlaylistPath) return;
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
    const rawData = await response.json();
    const data = normalizeRepertoireFileData(rawData);
    ensureGitHubToken();
    
    // Primeni playlistu
    state.activePlaylistName = data.name || playlist.name;
    state.activePlaylistPath = playlist.path;
    state.activePlaylistSha = playlist.sha;
    state.repertoire = data.songs;
    state.selectedSongId = state.repertoire.some((song) => song.id === data.selectedSongId)
      ? data.selectedSongId
      : state.repertoire[0]?.id || null;
    state.youtubeSeekSeconds = data.seekSeconds;
    if (youtubeSeekSeconds) {
      youtubeSeekSeconds.value = String(state.youtubeSeekSeconds);
    }

    saveRepertoire({ skipFileSave: true });
    renderRepertoire();
    updateSelectedSongPanel();
    updateYouTubeSeekButtons();
    updatePlaylistMode();
    setYouTubeStatus(`Playlist: ${state.activePlaylistName}`);
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
  if (!normalizedName) return;

  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    setYouTubeStatus("GitHub token je potreban");
    return;
  }
  writeSessionValue(state.GITHUB_TOKEN_STORAGE_KEY, normalizedToken);

  const path = `playlists/${slugifyPlaylistName(normalizedName)}.json`;
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

function writeSessionValue(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch {}
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
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || `YouTube ${videoId}`,
    key,
    url,
    videoId,
    chords: []
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

function parseYouTubeVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = String(url || "").match(regExp);
  return match && match[2].length === 11 ? match[2] : "";
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

function updateSelectedSongPanel() {
  const song = getSelectedSong();
  
  if (selectedSongTitle) selectedSongTitle.value = song?.title || "-";
  if (selectedSongKeyDisplay) selectedSongKeyDisplay.value = song?.key ? `- ${song.key}` : "";
  
  renderCompactSongList();
  window.dispatchEvent(new CustomEvent("fgr:songchange", { detail: { song: song || null } }));
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

function deleteSong(songId) {
  const index = state.repertoire.findIndex((song) => song.id === songId);
  if (index < 0) return;

  state.repertoire.splice(index, 1);
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

  if (event.code === "Backquote") {
    if (event.altKey) {
      seekYouTubeToStart();
    } else {
      triggerSelectedSongToggle();
    }
  } else if (event.code === "Digit1") {
    seekYouTube(-getYouTubeSeekSeconds());
  } else if (event.code === "Digit2") {
    seekYouTube(getYouTubeSeekSeconds());
  }

  return true;
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
    return;
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
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  writeJsonStorage("fgr-ui-v1", { 
    theme: state.theme, 
    tool: state.tool, 
    scaleAllOctaves: state.scaleAllOctaves, 
    octaveLocked: state.octaveLocked 
  });
  applySavedTheme();
}

function applySavedTheme() {
  const root = document.documentElement;
  root.setAttribute("data-theme", state.theme);
  
  const icon = $("themeToggleIcon");
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  
  if (icon) icon.innerHTML = state.theme === "dark" ? SUN : MOON;
  
  document.querySelectorAll("input[name='uiTheme']").forEach((r) => {
    r.checked = r.value === state.theme;
  });
  
  const meta = document.querySelector("meta[name='theme-color']");
  if (meta) {
    meta.setAttribute("content", state.theme === "dark" ? "#141009" : "#efe9dd");
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
  const recSt = $("pipeRecSt");
  const chSt = $("pipeChordsSt");
  const rdSt = $("pipeReadSt");
  const song = getSelectedSong();
  const chords = song && Array.isArray(song.chords) ? song.chords.length : 0;
  
  if (chSt) { chSt.textContent = chords ? "✓ " + chords : ""; chSt.classList.toggle("ok", chords > 0); }
  if (rdSt) { rdSt.textContent = chords ? "✓ spremno" : ""; rdSt.classList.toggle("ok", chords > 0); }
  
  if (!recSt) return;
  const id = recId();
  if (!id) { recSt.textContent = ""; return; }
  
  dbGet(id).then((item) => {
    recSt.textContent = item ? "✓ " + fmtTime(item.dur) : "";
    recSt.classList.toggle("ok", !!item);
  }).catch(() => {});
}

let capStream = null, capRec = null, capChunks = [], capStart = 0, capTimer = null;

function startCapture() {
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
    audio: true,
    preferCurrentTab: true,
    selfBrowserSurface: "include"
  }).then((stream) => {
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      setPipeStatus("Nema zvuka — pri deljenju čekiraj „Deli audio taba”.");
      return;
    }
    
    capStream = stream;
    const audioStream = new MediaStream([stream.getAudioTracks()[0]]);
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    capRec = new MediaRecorder(audioStream, { mimeType: mime });
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
  if (!song) return;
  state.youtubeResumeTime = 0;
  ensureSelectedVideoLoaded({ autoplay: true, keepDesired: false }).then((player) => {
    if (!player) return;
    if (typeof player.seekTo === "function") {
      player.seekTo(0, true);
    }
    state.youtubeDesiredPlaying = true;
    if (typeof player.playVideo === "function") {
      player.playVideo();
    }
  });
}

function stopCapture() {
  if (capRec && capRec.state !== "inactive") capRec.stop();
  if (capStream) capStream.getTracks().forEach((t) => t.stop());
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  
  const btn = $("pipeRec");
  if (btn) {
    btn.classList.remove("rec");
    btn.querySelector(".tt").textContent = "Snimi jednom";
  }
}

// Offline analiza buffer-a za automatsko prepoznavanje akorda
function runOfflineChordAnalysis() {
  const song = getSelectedSong();
  if (!song) {
    setPipeStatus("Prvo izaberi pesmu.");
    return;
  }
  const id = recId();
  dbGet(id).then((item) => {
    if (!item) {
      setPipeStatus("Nema snimka za ovu pesmu — prvo „1 Snimi jednom”.");
      return;
    }
    
    setPipeStatus("Analiziram snimak… (može potrajati)");
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    
    return item.blob.arrayBuffer()
      .then((data) => actx.decodeAudioData(data))
      .then((buffer) => window.FGRAnalyzeBuffer(buffer, (p) => {
        setPipeStatus("Analiziram… " + Math.round(p * 100) + "%");
      }))
      .then((chords) => {
        actx.close().catch(() => {});
        if (!chords.length) {
          setPipeStatus("Nisam uspeo da prepoznam akorde iz ovog snimka.");
          return;
        }
        
        if (song.chords && song.chords.length && !confirm("Pesma već ima " + song.chords.length + " akorada u chartu. Da ih zamenim sa " + chords.length + " prepoznatih?")) {
          setPipeStatus("");
          return;
        }
        
        song.chords = chords;
        saveRepertoire();
        updateSelectedSongPanel();
        renderMiniChart();
        if (state.tool === "chart") renderTool();
        refreshPipe();
        setPipeStatus("Upisano " + chords.length + " akorada u chart. Proveri ih i ispravi po sluhu.");
      });
  }).catch((err) => {
    setPipeStatus("Greška: " + err.message);
  });
}

function updateRecRow() {
  const row = $("recPlayerRow");
  if (!row) return;
  const id = recId();
  if (!id) { 
    row.hidden = true; 
    const mix = $("recMixerPanel");
    if (mix) mix.hidden = true;
    return; 
  }
  
  dbGet(id).then((item) => {
    row.hidden = !item;
    const mix = $("recMixerPanel");
    if (mix) mix.hidden = !item;
  }).catch(() => {
    row.hidden = true;
    const mix = $("recMixerPanel");
    if (mix) mix.hidden = true;
  });
  
  const recTimeDisplay = $("recTime");
  if (recTimeDisplay) {
    recTimeDisplay.textContent = fmtTime(recTime()) + (rec.buffer ? " / " + fmtTime(rec.buffer.duration) : "");
  }
  
  const recPitchDisplay = $("recPitch");
  if (recPitchDisplay) {
    recPitchDisplay.textContent = state.transpose === 0 ? "" :
      (state.transpose > 0 ? "+" + state.transpose : state.transpose) + " (" + (state.transpose > 0 ? "brže" : "sporije") + ")";
  }
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
    wrap.innerHTML = '<div class="mini-empty">Još nema akorda za ovu pesmu.<br>Upiši ih u <b>Chord chart</b> alatu dok pesma svira, ili sačekaj automatsko prepoznavanje.</div>';
    return;
  }
  wrap.innerHTML = "";
  
  chords.forEach((chord, idx) => {
    const item = document.createElement("div");
    item.className = "mini-cc";
    item.dataset.t = chord.t;
    item.innerHTML = '<span class="n">' + transposeChordName(chord.n) + '</span><span class="t">' + fmtTime(chord.t) + "</span>";
    item.addEventListener("click", () => {
      if (rec.playing) recSeek(chord.t);
      else if (state.youtubePlayer && typeof state.youtubePlayer.seekTo === "function") {
        state.youtubePlayer.seekTo(chord.t, true);
      }
      paintChordName(transposeChordName(chord.n), false);
    });
    wrap.appendChild(item);
  });
}

let lastFollowedChord = null;

function trackPlaybackAndHighlight() {
  const currentSong = getSelectedSong();
  if (!currentSong) return;
  
  const t = rec.playing 
    ? recTime() 
    : (state.youtubePlayerReady && typeof state.youtubePlayer.getCurrentTime === "function" 
        ? Number(state.youtubePlayer.getCurrentTime()) || 0 
        : 0);
        
  if (rec.playing) {
    updateRecRow();
  }
  
  if (!t) return;
  let currentName = null;
  
  ["miniChart", "ccStrip"].forEach((id) => {
    const wrap = $(id);
    if (!wrap) return;
    const cells = wrap.querySelectorAll("[data-t]");
    let current = null;
    
    cells.forEach((cell) => {
      if (Number(cell.dataset.t) <= t) {
        current = cell;
      }
    });
    
    cells.forEach((cell) => {
      cell.classList.toggle("now", cell === current);
      cell.classList.toggle("on", cell === current);
    });
    
    if (current) {
      currentName = (current.querySelector(".n") || current).textContent.trim();
      if (id === "ccStrip") {
        current.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
    }
  });
  
  // Auto-bojenje akorda na virtuelnom klaviru
  if (currentName && currentName !== lastFollowedChord && state.tool !== "skale" && state.tool !== "vezba") {
    lastFollowedChord = currentName;
    paintChordName(currentName, true);
  }
}

// ---------------- POMOCNI PWA SERVISI ----------------
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
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
    return rec.playing ? recTime() : (player && typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) || 0 : 0);
  },
  seekTo(seconds) {
    if (rec.playing) {
      recSeek(seconds);
    } else {
      ensureSelectedVideoLoaded({ autoplay: false, keepDesired: true }).then((player) => {
        if (player && typeof player.seekTo === "function") {
          player.seekTo(Math.max(0, Number(seconds) || 0), true);
        }
      });
    }
  },
  setRate(rate) {
    state.playbackRate = Number(rate) || 1;
    const player = state.youtubePlayer;
    if (player && typeof player.setPlaybackRate === "function") {
      player.setPlaybackRate(state.playbackRate);
    }
    recRetune();
  },
  playFromStart() {
    const song = getSelectedSong();
    if (!song) return false;
    
    if (rec.playing) {
      recSeek(0);
    } else {
      playFromStart();
    }
    return true;
  },
  addChordToSelected(name, atSeconds) {
    const song = getSelectedSong();
    const chordName = String(name || "").trim();
    if (!song || !chordName) return false;
    
    const t = Math.max(0, Number(atSeconds));
    song.chords = Array.isArray(song.chords) ? song.chords : [];
    song.chords.push({ t: Math.round(t * 10) / 10, n: chordName });
    song.chords.sort((a, b) => a.t - b.t);
    
    saveRepertoire();
    updateSelectedSongPanel();
    renderMiniChart();
    return true;
  },
  setChordsForSelected(chords) {
    const song = getSelectedSong();
    if (!song || !Array.isArray(chords)) return false;
    
    song.chords = chords
      .map((chord) => ({ t: Math.max(0, Math.round((Number(chord?.t) || 0) * 10) / 10), n: String(chord?.n || "").trim() }))
      .filter((chord) => chord.n)
      .sort((a, b) => a.t - b.t);
      
    saveRepertoire();
    updateSelectedSongPanel();
    renderMiniChart();
    return true;
  },
  removeChordFromSelected(index) {
    const song = getSelectedSong();
    if (!song || !Array.isArray(song.chords) || !song.chords[index]) return false;
    
    song.chords.splice(index, 1);
    saveRepertoire();
    updateSelectedSongPanel();
    renderMiniChart();
    return true;
  }
};

// Okidac za ucitavanje teme (sprecava flicker)
function applySavedTheme() {
  const root = document.documentElement;
  const saved = readJsonStorage("fgr-ui-v1", {});
  if (saved.theme === "light" || saved.theme === "dark") {
    state.theme = saved.theme;
  }
  if (saved.tool) {
    state.tool = saved.tool;
  }
  if (typeof saved.scaleAllOctaves === "boolean") {
    state.scaleAllOctaves = saved.scaleAllOctaves;
  }
  if (typeof saved.octaveLocked === "boolean") {
    state.octaveLocked = saved.octaveLocked;
  }
  
  root.setAttribute("data-theme", state.theme);
}

// Pokretanje
init();
