import { state, NOTE_NAMES, readJsonStorage, writeJsonStorage } from "./state.js";
import { connectMidi, setMidiOnChordCallback, midiPcSet, detectMidiChord } from "./midi.js";
import { noteToMidi, setAssistedMidiSet } from "./audio.js?v=164";
import {
  buildCountInPattern,
  buildMetronomePattern,
  beatAccentLevel,
  normalizeTimelineZoom,
  stepTimelineZoom,
  TIMELINE_ZOOM_DEFAULT,
  timelineSecondsFromClientX,
  timelineTickSeconds,
  timelineZoomScrollLeft
} from "./practice-timing.js?v=164";
import {
  chordPreviewMidis,
  chordSegmentGeometry,
  editChordSegment,
  openChordPicker,
  resolveChordEndTime,
  showChordContextMenu,
  showTimelineContextMenu,
  splitChordSegment
} from "./chord-editor.js?v=164";

const TIMELINE_ZOOM_STORAGE_KEY = "fgr-timeline-zoom-v1";
const TRIAD = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
const SUFFIX = { maj: "", min: "m", dim: "°" };
const CHORD_VARIANTS = {
  triad: { label: "Osnovni", short: "", suffix: { maj: "", min: "m", dim: "°" } },
  "7": { label: "7", short: "7", suffix: { maj: "7", min: "m7", dim: "m7b5" } },
  "9": { label: "9", short: "9", suffix: { maj: "9", min: "m9", dim: "dim9" } },
  sus: { label: "sus", short: "sus", suffix: { maj: "sus", min: "sus", dim: "sus" } },
  maj7: { label: "maj7", short: "maj", suffix: { maj: "maj7", min: "m maj7", dim: "dim maj7" } },
  dim: { label: "dim", short: "dim", suffix: { maj: "dim", min: "dim", dim: "dim" } }
};
const CHORD_VARIANT_GROUPS = {
  triad: ["triad"],
  "7": ["7"],
  "9": ["9"],
  sus: ["sus"],
  maj7: ["maj7"],
  dim: ["dim"],
  all: ["triad", "7", "9", "sus", "maj7", "dim"]
};
const INTERVAL_DRILLS = [
  ["mala sekunda", 1], ["velika sekunda", 2], ["mala terca", 3], ["velika terca", 4],
  ["kvarta", 5], ["tritonus", 6], ["kvinta", 7], ["mala seksta", 8],
  ["velika seksta", 9], ["mala septima", 10], ["velika septima", 11], ["oktava", 12]
];
const MAJOR_DEGREES = [
  ["I", "maj", 0], ["ii", "min", 2], ["iii", "min", 4], ["IV", "maj", 5],
  ["V", "maj", 7], ["vi", "min", 9], ["vii°", "dim", 11]
];
const MINOR_DEGREES = [
  ["i", "min", 0], ["ii°", "dim", 2], ["III", "maj", 3], ["iv", "min", 5],
  ["v", "min", 7], ["VI", "maj", 8], ["VII", "maj", 10], ["V dur", "maj", 7, true]
];
const SCALES = {
  "prirodni mol": [0, 2, 3, 5, 7, 8, 10],
  "harmonijski mol": [0, 2, 3, 5, 7, 8, 11],
  "dur": [0, 2, 4, 5, 7, 9, 11],
  "mol pentatonika": [0, 3, 5, 7, 10],
  "blues": [0, 3, 5, 6, 7, 10],
  "dorska": [0, 2, 3, 5, 7, 9, 10],
  "miksolidijska": [0, 2, 4, 5, 7, 9, 10],
  "alterovana (jazz)": [0, 1, 3, 4, 6, 8, 10]
};

// Pomocne funkcije za vizuelizaciju
export function fmtTime(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function fmtChordTime(value) {
  const secondsTotal = Math.max(0, Math.round((Number(value) || 0) * 10) / 10);
  const minutes = Math.floor(secondsTotal / 60);
  const seconds = secondsTotal - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function parseKey(text) {
  var raw = String(text || "").trim();
  if (!raw) return null;
  var lower = raw.toLowerCase().replace(/[\s\-_]+/g, "");
  var roots = [
    ["cis", 1], ["dis", 3], ["eis", 5], ["fis", 6], ["gis", 8], ["ais", 10],
    ["c", 0], ["d", 2], ["e", 4], ["f", 5], ["g", 7], ["a", 9], ["b", 10], ["h", 11]
  ];
  var pc = null, rest = "";
  for (var i = 0; i < roots.length; i++) {
    if (lower.indexOf(roots[i][0]) === 0) {
      pc = roots[i][1];
      rest = lower.slice(roots[i][0].length);
      break;
    }
  }
  if (pc === null) return null;
  var minor;
  if (rest.indexOf("mol") !== -1) minor = true;
  else if (rest.indexOf("dur") !== -1) minor = false;
  else minor = raw[0] === raw[0].toLowerCase();
  return { pc: pc, minor: minor };
}

export function formatKey(pc, minor) {
  return NOTE_NAMES[pc] + (minor ? "-mol" : "-dur");
}

export function selectedOctave() {
  return state.baseOctave;
}

function renderNoteLane(lane, song, trackName, pixelsPerSecond) {
  if (!lane) return;
  var track = (song && song.noteTracks && song.noteTracks[trackName]) || null;
  var events = track && Array.isArray(track.events) ? track.events : [];
  if (!events.length) {
    lane.classList.add("is-empty");
    return;
  }
  lane.classList.remove("is-empty");

  // Height carries the pitch, so the shape of the line is readable at any zoom.
  // Writing every note name instead would be unreadable at normal zoom: a
  // typical note is a fifth of a second, which is five pixels wide.
  var lowest = Infinity;
  var highest = -Infinity;
  for (var scan = 0; scan < events.length; scan += 1) {
    var pitch = Number(events[scan].midi);
    if (!isFinite(pitch)) continue;
    if (pitch < lowest) lowest = pitch;
    if (pitch > highest) highest = pitch;
  }
  if (!isFinite(lowest)) return;
  var span = Math.max(1, highest - lowest);
  var names = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];
  var topPadding = 15;
  var usableHeight = 22;
  var noteHeight = 7;

  var fragment = document.createDocumentFragment();
  for (var index = 0; index < events.length; index += 1) {
    var event = events[index];
    var startSeconds = Number(event.t);
    var durationSeconds = Number(event.d);
    var midi = Number(event.midi);
    if (!isFinite(startSeconds) || !isFinite(midi)) continue;
    if (!isFinite(durationSeconds) || durationSeconds <= 0) durationSeconds = 0.15;

    var width = Math.max(3, durationSeconds * pixelsPerSecond);
    var note = document.createElement("span");
    note.className = "chart-note";
    note.style.left = (startSeconds * pixelsPerSecond) + "px";
    note.style.width = width + "px";
    note.style.top = (topPadding + (1 - (midi - lowest) / span) * usableHeight) + "px";
    note.style.height = noteHeight + "px";
    note.dataset.t = String(startSeconds);
    note.dataset.midi = String(midi);
    var name = names[((midi % 12) + 12) % 12];
    // Only label a note that has room for the label; the rest are read by
    // position, and by the piano at the bottom.
    if (width >= 20) {
      note.textContent = name;
      note.classList.add("has-name");
      note.style.height = "12px";
      note.style.lineHeight = "12px";
    }
    note.setAttribute("role", "listitem");
    note.title = name + Math.floor(midi / 12 - 1) + " · " + fmtChordTime(startSeconds);
    fragment.appendChild(note);
  }
  lane.appendChild(fragment);
}

function normalizePc(pc) {
  return ((Number(pc) % 12) + 12) % 12;
}

function selectedRootMidi(rootPc, options) {
  var root = normalizePc(rootPc);
  var octaveBase = (selectedOctave() + 1) * 12;
  if (state.octaveLocked) return octaveBase + root;
  var anchor = options && options.anchorPc !== undefined ? normalizePc(options.anchorPc) : root;
  return octaveBase + anchor + ((root - anchor + 12) % 12);
}

function uniqueSortedIntervals(intervals) {
  return Array.from(new Set(intervals)).sort(function (a, b) { return a - b; });
}

function chordIntervals(quality, variantId) {
  if (variantId === "sus") return [0, 5, 7];
  if (variantId === "dim") return [0, 3, 6];
  if (variantId === "maj7") return [0, quality === "min" ? 3 : 4, quality === "dim" ? 6 : 7, 11];

  var base = TRIAD[quality] || TRIAD.maj;
  if (variantId === "7" || variantId === "9") {
    var seventh = 10;
    var out = base.concat([seventh]);
    if (variantId === "9") out.push(14);
    return uniqueSortedIntervals(out);
  }
  return base.slice();
}

function chordName(rootPc, quality, variantId) {
  var variant = CHORD_VARIANTS[variantId] || CHORD_VARIANTS.triad;
  return NOTE_NAMES[rootPc] + (variant.suffix[quality] || variant.suffix.maj || "");
}

function inversionLabel(step) {
  if (!step) return "osnovni hvat";
  return step + ". obrt";
}

function applyInversion(intervals, step) {
  var out = uniqueSortedIntervals(intervals);
  var maxStep = Math.max(0, out.length - 1);
  var count = Math.max(0, Math.min(maxStep, Number(step) || 0));
  for (var i = 0; i < count; i++) {
    out.push(out.shift() + 12);
  }
  return out;
}

function chordMidisFromIntervals(rootPc, intervals, inversion, options) {
  var base = selectedRootMidi(rootPc, options);
  return applyInversion(intervals, inversion).map(function (iv) { return base + iv; });
}

function chordMidis(rootPc, type) {
  return chordMidisFromIntervals(rootPc, TRIAD[type] || TRIAD.maj, 0);
}

function noteNamesForIntervals(rootPc, intervals) {
  return uniqueSortedIntervals(intervals).map(function (iv) { return NOTE_NAMES[(rootPc + iv) % 12]; }).join(" ");
}

export function pressKeys(midis, holdMs, card) {
  var keys = midis.map(function (m) { return document.querySelector('.key[data-midi="' + m + '"]'); }).filter(Boolean);
  if (!keys.length) return;
  if (card) card.classList.add("playing");
  keys.forEach(function (k) {
    k.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerId: 900 + Number(k.dataset.midi) }));
  });
  setTimeout(function () {
    keys.forEach(function (k) {
      k.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 900 + Number(k.dataset.midi) }));
    });
    if (card) card.classList.remove("playing");
  }, holdMs || 650);
}

// Oznacavanje na virtuelnom klaviru
let activeHint = null;
let hintClearTimer = null;

function clearHintTimer() {
  if (hintClearTimer) {
    window.clearTimeout(hintClearTimer);
    hintClearTimer = null;
  }
}

export function renderHint(hint) {
  if (!hint) return;
  var base = selectedRootMidi(hint.rootPc, { anchorPc: hint.anchorPc });
  var midis = hint.midis ? hint.midis.slice() : hint.intervals.map(function (iv) { return base + iv; });
  var pcs = new Set(midis.map(function (m) { return ((m % 12) + 12) % 12; }));
  
  document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
    key.classList.remove("root-hint", "scale-hint");
  });
  
  if (hint.allOctaves) {
    document.querySelectorAll("#keyboard .key").forEach(function (key) {
      var pc = ((Number(key.dataset.midi) % 12) + 12) % 12;
      if (pcs.has(pc)) key.classList.add("scale-hint");
    });
  } else {
    midis.forEach(function (m) {
      var key = document.querySelector('.key[data-midi="' + m + '"]');
      if (key) key.classList.add("scale-hint");
    });
  }
  
  const dockScaleName = document.getElementById("dockScaleName");
  if (dockScaleName) dockScaleName.textContent = hint.label || "";
}

export function paintScale(rootPc, intervals, label, options) {
  clearHintTimer();
  activeHint = {
    rootPc: rootPc,
    intervals: intervals.slice(),
    label: label || "",
    autoClear: !!(options && options.autoClear),
    allOctaves: !!(options && options.allOctaves),
    anchorPc: options && options.anchorPc !== undefined ? normalizePc(options.anchorPc) : rootPc
  };
  renderHint(activeHint);
  if (activeHint.autoClear) {
    hintClearTimer = window.setTimeout(clearScale, options && options.holdMs ? options.holdMs : 900);
  }
}

export function paintMidis(midis, label, options) {
  clearHintTimer();
  activeHint = {
    rootPc: midis.length ? ((midis[0] % 12) + 12) % 12 : 0,
    intervals: [],
    midis: midis.slice(),
    label: label || "",
    autoClear: !!(options && options.autoClear),
    allOctaves: !!(options && options.allOctaves)
  };
  renderHint(activeHint);
  if (activeHint.autoClear) {
    hintClearTimer = window.setTimeout(clearScale, options && options.holdMs ? options.holdMs : 900);
  }
}

export function clearScale() {
  clearHintTimer();
  activeHint = null;
  document.querySelectorAll("#keyboard .key.root-hint, #keyboard .key.scale-hint").forEach(function (key) {
    key.classList.remove("root-hint", "scale-hint");
  });
  const dockScaleName = document.getElementById("dockScaleName");
  if (dockScaleName) dockScaleName.textContent = "";
}

export function getActiveHint() {
  return activeHint;
}

// ---------------- METRONOM & DRUM MACHINE ----------------
export const metro = {
  bpm: 96,
  sig: "4/4",
  rhythm: "click",
  subdivision: 1,
  swingPercent: 66,
  countInBars: 1,
  beatIndex: -1,
  stepIndex: -1,
  timer: null,
  audio: null,
  master: null,
  noiseBuffer: null,
  taps: [],
  pattern: null,
  countInPattern: null,
  patternCursor: 0,
  countInCursor: 0,
  nextStepTime: 0,
  visualTimers: []
};

const METRO_LOOKAHEAD_MS = 25;
const METRO_SCHEDULE_AHEAD_SECONDS = 0.12;

function ensureMetroAudio() {
  if (!metro.audio) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    metro.audio = new AudioContext();
  }
  if (!metro.master) {
    metro.master = metro.audio.createGain();
    metro.master.gain.value = 0.72;
    metro.master.connect(metro.audio.destination);
  }
  if (metro.audio.state === "suspended") metro.audio.resume();
  return metro.audio;
}

function getMetroNoiseBuffer(audioContext) {
  if (metro.noiseBuffer && metro.noiseBuffer.sampleRate === audioContext.sampleRate) return metro.noiseBuffer;
  const buffer = audioContext.createBuffer(1, Math.round(audioContext.sampleRate * 0.35), audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  metro.noiseBuffer = buffer;
  return buffer;
}

function playClick(audioContext, time, sound) {
  const accent = Number(sound.level) || 1;
  const subdivision = !!sound.subdivision;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = accent >= 1.8 ? "triangle" : "sine";
  const startFrequency = accent >= 1.8 ? 1480 : (subdivision ? 690 : 990);
  oscillator.frequency.setValueAtTime(startFrequency, time);
  oscillator.frequency.exponentialRampToValueAtTime(startFrequency * 0.72, time + 0.038);
  const peak = subdivision ? 0.055 : (accent >= 1.8 ? 0.23 : 0.14);
  gain.gain.setValueAtTime(0.0001, Math.max(0, time - 0.002));
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + (subdivision ? 0.035 : 0.065));
  oscillator.connect(gain);
  gain.connect(metro.master);
  oscillator.start(time);
  oscillator.stop(time + 0.075);

  if (!subdivision) {
    const noise = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const noiseGain = audioContext.createGain();
    noise.buffer = getMetroNoiseBuffer(audioContext);
    filter.type = "bandpass";
    filter.frequency.value = accent >= 1.8 ? 2600 : 2100;
    filter.Q.value = 1.8;
    noiseGain.gain.setValueAtTime(accent >= 1.8 ? 0.045 : 0.025, time);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.022);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(metro.master);
    noise.start(time);
    noise.stop(time + 0.025);
  }
}

function playKick(audioContext, time) {
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.connect(gain);
  gain.connect(metro.master);

  osc.frequency.setValueAtTime(145, time);
  osc.frequency.exponentialRampToValueAtTime(48, time + 0.11);

  gain.gain.setValueAtTime(0.72, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

  osc.start(time);
  osc.stop(time + 0.16);
}

function playSnare(audioContext, time, volume = 0.7) {
  const noise = audioContext.createBufferSource();
  noise.buffer = getMetroNoiseBuffer(audioContext);

  const filter = audioContext.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1450;
  filter.Q.value = 0.8;

  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(volume * 0.52, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.11);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(metro.master);

  const osc = audioContext.createOscillator();
  const oscGain = audioContext.createGain();
  osc.frequency.setValueAtTime(180, time);
  oscGain.gain.setValueAtTime(volume * 0.18, time);
  oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.07);

  osc.connect(oscGain);
  oscGain.connect(metro.master);

  noise.start(time);
  noise.stop(time + 0.12);
  osc.start(time);
  osc.stop(time + 0.08);
}

function playHiHat(audioContext, time, open = false, level = 0.4) {
  const duration = open ? 0.25 : 0.05;
  const noise = audioContext.createBufferSource();
  noise.buffer = getMetroNoiseBuffer(audioContext);

  const filter = audioContext.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 6800;

  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(Math.max(0.03, level * 0.30), time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration - 0.005);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(metro.master);

  noise.start(time);
  noise.stop(time + duration);
}

function scheduleMetroSound(sound, time) {
  const audioContext = ensureMetroAudio();
  if (sound.type === "click") playClick(audioContext, time, sound);
  else if (sound.type === "kick") playKick(audioContext, time);
  else if (sound.type === "snare") playSnare(audioContext, time, Number(sound.level) || 0.7);
  else if (sound.type === "hat") playHiHat(audioContext, time, !!sound.open, Number(sound.level) || 0.4);
}

function clearMetroVisualTimers() {
  metro.visualTimers.forEach((timer) => window.clearTimeout(timer));
  metro.visualTimers = [];
}

function scheduleMetroVisual(step, time, isCountIn, drawBeats, mtPlay) {
  const delay = Math.max(0, (time - metro.audio.currentTime) * 1000);
  const timer = window.setTimeout(() => {
    metro.visualTimers = metro.visualTimers.filter((candidate) => candidate !== timer);
    metro.beatIndex = step.beatIndex;
    metro.stepIndex = isCountIn ? -1 : step.stepIndex;
    drawBeats(isCountIn);
    if (isCountIn) {
      const bar = Math.min(metro.countInPattern.bars, (step.barIndex || 0) + 1);
      mtPlay.textContent = `Uvod ${bar}/${metro.countInPattern.bars}`;
    } else {
      mtPlay.textContent = "Stop";
    }
  }, delay);
  metro.visualTimers.push(timer);
}

function scheduleNextMetroStep(drawBeats, mtPlay) {
  let step;
  let isCountIn = false;
  if (metro.countInPattern && metro.countInCursor < metro.countInPattern.steps.length) {
    step = metro.countInPattern.steps[metro.countInCursor];
    metro.countInCursor += 1;
    isCountIn = true;
  } else {
    step = metro.pattern.steps[metro.patternCursor];
    metro.patternCursor = (metro.patternCursor + 1) % metro.pattern.steps.length;
  }
  step.sounds.forEach((sound) => scheduleMetroSound(sound, metro.nextStepTime));
  scheduleMetroVisual(step, metro.nextStepTime, isCountIn, drawBeats, mtPlay);
  metro.nextStepTime += (60 / metro.bpm) * step.durationPulses;
}

function runMetroScheduler(drawBeats, mtPlay) {
  if (!metro.audio || !metro.pattern?.steps?.length) return;
  while (metro.nextStepTime < metro.audio.currentTime + METRO_SCHEDULE_AHEAD_SECONDS) {
    scheduleNextMetroStep(drawBeats, mtPlay);
  }
}

export function initMetronome() {
  const mtPlay = document.getElementById("mtPlay");
  if (!mtPlay) return;

  function drawBeats(isCountIn = false) {
    const wrap = document.getElementById("mtBeats");
    if (!wrap) return;
    const n = buildMetronomePattern({ signature: metro.sig }).beats;
    wrap.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const dot = document.createElement("span");
      const accented = beatAccentLevel(i, metro.sig) > 1;
      dot.className = "beat" + (accented ? " strong" : "") + (i === metro.beatIndex ? " hit" : "") + (isCountIn ? " count-in" : "");
      wrap.appendChild(dot);
    }
  }

  function updateBpm() {
    const mtVal = document.getElementById("mtVal");
    if (mtVal) mtVal.textContent = metro.bpm;
  }

  function syncOptionsUi() {
    const subdivision = document.getElementById("mtSubdivision");
    const swing = document.getElementById("mtSwing");
    const swingValue = document.getElementById("mtSwingValue");
    if (subdivision) subdivision.disabled = metro.rhythm !== "click";
    if (swing) swing.disabled = metro.rhythm !== "swing";
    if (swingValue) swingValue.textContent = `${metro.swingPercent}%`;
  }

  function stop() {
    if (metro.timer) {
      window.clearInterval(metro.timer);
      metro.timer = null;
    }
    clearMetroVisualTimers();
    // Every look-ahead sound is routed through this run's master. Dropping
    // that node silences future scheduled clicks immediately, so Stop and a
    // tempo/pattern restart cannot leave one stale off-grid hit behind.
    if (metro.master) {
      try { metro.master.disconnect(); } catch (_error) {}
      metro.master = null;
    }
    metro.beatIndex = -1;
    metro.stepIndex = -1;
    drawBeats();
    mtPlay.textContent = "Start";
    mtPlay.setAttribute("aria-pressed", "false");
  }

  function start(useCountIn = true) {
    if (metro.timer) return;
    const audioContext = ensureMetroAudio();
    metro.pattern = buildMetronomePattern({
      signature: metro.sig,
      rhythm: metro.rhythm,
      subdivision: metro.subdivision,
      swingPercent: metro.swingPercent
    });
    metro.countInPattern = buildCountInPattern(metro.sig, useCountIn ? metro.countInBars : 0);
    metro.patternCursor = 0;
    metro.countInCursor = 0;
    metro.beatIndex = -1;
    metro.stepIndex = -1;
    metro.nextStepTime = audioContext.currentTime + 0.055;
    mtPlay.textContent = metro.countInPattern.steps.length ? "Uvod..." : "Stop";
    mtPlay.setAttribute("aria-pressed", "true");
    runMetroScheduler(drawBeats, mtPlay);
    metro.timer = window.setInterval(() => runMetroScheduler(drawBeats, mtPlay), METRO_LOOKAHEAD_MS);
  }

  function restart() {
    const wasRunning = !!metro.timer;
    stop();
    if (wasRunning) start(false);
  }

  const mtUp = document.getElementById("mtUp");
  if (mtUp) mtUp.addEventListener("click", () => {
    metro.bpm = Math.min(240, metro.bpm + 1);
    updateBpm();
    restart();
  });

  const mtDown = document.getElementById("mtDown");
  if (mtDown) mtDown.addEventListener("click", () => {
    metro.bpm = Math.max(30, metro.bpm - 1);
    updateBpm();
    restart();
  });

  const mtSig = document.getElementById("mtSig");
  const mtRhythm = document.getElementById("mtRhythm");

  if (mtSig) mtSig.addEventListener("change", (event) => {
    metro.sig = event.target.value;
    // Ako se izabere bilo koji takt osim 4/4, drum machine ritmovi se vracaju na obican metronom klik
    if (metro.sig !== "4/4" && mtRhythm) {
      mtRhythm.value = "click";
      metro.rhythm = "click";
    }
    syncOptionsUi();
    restart();
  });

  if (mtRhythm) mtRhythm.addEventListener("change", (event) => {
    metro.rhythm = event.target.value;
    // Ako se izabere drum machine ritam, automatski prebaci takt na 4/4
    if (metro.rhythm !== "click" && mtSig) {
      mtSig.value = "4/4";
      metro.sig = "4/4";
    }
    syncOptionsUi();
    restart();
  });

  const mtSubdivision = document.getElementById("mtSubdivision");
  if (mtSubdivision) mtSubdivision.addEventListener("change", (event) => {
    metro.subdivision = Math.max(1, Math.min(4, Number(event.target.value) || 1));
    restart();
  });

  const mtSwing = document.getElementById("mtSwing");
  if (mtSwing) mtSwing.addEventListener("input", (event) => {
    metro.swingPercent = Math.max(50, Math.min(75, Number(event.target.value) || 66));
    syncOptionsUi();
    restart();
  });

  const mtCountIn = document.getElementById("mtCountIn");
  if (mtCountIn) mtCountIn.addEventListener("change", (event) => {
    metro.countInBars = Math.max(0, Math.min(2, Number(event.target.value) || 0));
  });

  const mtTap = document.getElementById("mtTap");
  if (mtTap) mtTap.addEventListener("click", () => {
    const now = performance.now();
    metro.taps.push(now);
    metro.taps = metro.taps.filter((t) => now - t < 3200);
    if (metro.taps.length > 1) {
      const avg = (metro.taps[metro.taps.length - 1] - metro.taps[0]) / (metro.taps.length - 1);
      metro.bpm = Math.max(30, Math.min(240, Math.round(60000 / avg)));
      updateBpm();
      restart();
    }
  });

  mtPlay.addEventListener("click", () => {
    if (metro.timer) stop();
    else start(true);
  });

  updateBpm();
  syncOptionsUi();
  drawBeats();
}

const CHART_MANUAL_SCROLL_PAUSE_MS = 2600;

function markChartManualScroll(scroll, duration = CHART_MANUAL_SCROLL_PAUSE_MS) {
  if (!scroll) return;
  scroll.dataset.userScrollUntil = String(performance.now() + duration);
}

function setChartPlayheadPreview(strip, seconds) {
  const playhead = strip.querySelector("#chartPlayhead");
  if (!playhead) return;
  const pixelsPerSecond = Number(strip.dataset.pixelsPerSecond) || 23;
  const duration = Number(strip.dataset.duration) || 0;
  const time = Math.max(0, Math.min(duration, Number(seconds) || 0));
  // Keep the edit cursor synchronously available to the controller. A paused
  // local recSeek may finish only after its audio buffer has loaded, while the
  // user can click "+ Akord" immediately after releasing the playhead.
  strip.dataset.chartCursorTime = String(time);
  playhead.style.left = `${time * pixelsPerSecond}px`;
  playhead.setAttribute("aria-valuenow", String(Math.round(time * 10) / 10));
  playhead.setAttribute("aria-valuemax", String(duration));
  playhead.setAttribute("aria-label", `Pozicija ${fmtChordTime(time)}`);
}

let chordEditorPreviewTimer = 0;

function previewChordInEditor(name) {
  const midis = chordPreviewMidis(name, 48);
  if (!midis.length) return;
  if (chordEditorPreviewTimer) window.clearTimeout(chordEditorPreviewTimer);
  setAssistedMidiSet("chord-editor", new Set(midis), new Set(midis));
  paintMidis(midis, `Provera: ${name}`, { autoClear: true, holdMs: 1050 });
  chordEditorPreviewTimer = window.setTimeout(() => {
    chordEditorPreviewTimer = 0;
    setAssistedMidiSet("chord-editor", new Set());
  }, 900);
}

export function openTimelineChordPicker(song, time) {
  if (!song) return;
  openChordPicker({
    mode: "add",
    timeLabel: fmtChordTime(time),
    key: song.key || "",
    chords: song.chords || [],
    index: -1,
    onPreview: previewChordInEditor,
    onConfirm(name) {
      window.FGRBridge?.addChordToSelected(name, time);
    }
  });
}

function openExistingChordPicker(song, index, returnFocus) {
  const chord = song?.chords?.[index];
  if (!chord) return;
  openChordPicker({
    mode: "edit",
    currentName: chord.n,
    timeLabel: fmtChordTime(chord.t),
    key: song.key || "",
    chords: song.chords,
    index,
    onPreview: previewChordInEditor,
    onConfirm(name) {
      const updated = song.chords.map((entry, entryIndex) => entryIndex === index ? { ...entry, n: name } : { ...entry });
      if (window.FGRBridge?.setChordsForSelected(updated) && state.tool === "chart") renderTool();
    },
    returnFocus
  });
}

function requestChordDeletion(song, index) {
  const chord = song?.chords?.[index];
  if (!chord) return;
  if (!window.confirm(`Obriši ${chord.n} (${fmtChordTime(chord.t)})? Ova izmena će biti sačuvana.`)) return;
  if (window.FGRBridge?.removeChordFromSelected(index) && state.tool === "chart") renderTool();
}

function commitChordListUpdate(chords) {
  if (window.FGRBridge?.setChordsForSelected(chords) && state.tool === "chart") renderTool();
}

function stripSplitOptions(strip) {
  return {
    duration: Math.max(0, Number(strip?.dataset.duration) || 0),
    chordEndTime: Number(strip?.dataset.chordEndTime),
    minimumGap: 0.05
  };
}

function stripPlayheadTime(strip) {
  const duration = Math.max(0, Number(strip?.dataset.duration) || 0);
  const clampTime = (value) => Math.max(0, Math.min(duration, value));
  const cursor = Number(strip?.dataset.chartCursorTime);
  if (strip?.dataset.chartCursorTime !== undefined && Number.isFinite(cursor)) return clampTime(cursor);
  // Right after a re-render the playhead element exists but has no position
  // yet, so the live playback clock is the only reliable fallback.
  const playheadLeft = Number.parseFloat(strip?.querySelector("#chartPlayhead")?.style.left);
  if (Number.isFinite(playheadLeft)) {
    return clampTime(playheadLeft / normalizeTimelineZoom(strip?.dataset.pixelsPerSecond));
  }
  const live = Number(window.FGRBridge?.getTime?.());
  return clampTime(Number.isFinite(live) ? live : 0);
}

function requestChordSplit(song, index, time, strip) {
  if (!song?.chords?.[index]) return;
  const result = splitChordSegment(song.chords, index, time, stripSplitOptions(strip));
  if (!result.changed) return;
  commitChordListUpdate(result.chords);
}

function openPlayheadChordInsert(song, index, strip) {
  const chord = song?.chords?.[index];
  if (!chord) return;
  const time = stripPlayheadTime(strip);
  openChordPicker({
    mode: "add",
    timeLabel: fmtChordTime(time),
    key: song.key || "",
    chords: song.chords,
    index,
    onPreview: previewChordInEditor,
    onConfirm(name) {
      const result = splitChordSegment(song.chords, index, time, { ...stripSplitOptions(strip), name });
      if (result.changed) {
        commitChordListUpdate(result.chords);
        return;
      }
      // The segment is too short to split; replacing the whole chord keeps
      // the user's intent (the chosen chord sounds from here) without
      // creating an inaudible sliver.
      commitChordListUpdate(song.chords.map((entry, entryIndex) => (
        entryIndex === index ? { ...entry, n: name } : { ...entry }
      )));
    }
  });
}

function readTimelineZoom() {
  const saved = readJsonStorage(TIMELINE_ZOOM_STORAGE_KEY, {});
  return normalizeTimelineZoom(saved && saved.pixelsPerSecond);
}

function saveTimelineZoom(pixelsPerSecond) {
  writeJsonStorage(TIMELINE_ZOOM_STORAGE_KEY, {
    pixelsPerSecond: normalizeTimelineZoom(pixelsPerSecond)
  });
}

function renderChartTimelineScale(strip, chords) {
  const pixelsPerSecond = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
  const duration = Math.max(0, Number(strip.dataset.duration) || 0);
  const displayDuration = Math.max(40, Math.ceil(duration / 5) * 5);
  const canvasWidth = Math.max(840, Math.round(displayDuration * pixelsPerSecond));
  const chordEndTime = resolveChordEndTime(chords, duration, Number(strip.dataset.chordEndTime));
  const ruler = strip.querySelector(".chart-ruler");
  const grid = strip.querySelector(".chart-grid");
  const tickSeconds = timelineTickSeconds(pixelsPerSecond);

  strip.dataset.pixelsPerSecond = String(pixelsPerSecond);
  strip.dataset.tickSeconds = String(tickSeconds);
  strip.style.width = canvasWidth + "px";

  if (ruler && grid) {
    ruler.replaceChildren();
    grid.replaceChildren();
    for (let second = 0; second <= displayDuration; second += tickSeconds) {
      const left = second * pixelsPerSecond;
      const tick = document.createElement("span");
      tick.style.left = left + "px";
      tick.textContent = fmtTime(second);
      ruler.appendChild(tick);
      const line = document.createElement("i");
      line.style.left = left + "px";
      grid.appendChild(line);
    }
  }

  chords.forEach((chord, index) => {
    const cell = strip.querySelector('.cc[data-index="' + index + '"]');
    if (!cell) return;
    const geometry = chordSegmentGeometry(chords, index, duration, pixelsPerSecond, chordEndTime);
    cell.style.left = geometry.left + "px";
    cell.style.width = geometry.width + "px";
    const durationLabel = cell.querySelector(".cc-duration");
    if (durationLabel) durationLabel.textContent = geometry.duration.toFixed(1) + " s";
  });

  const playhead = strip.querySelector("#chartPlayhead");
  if (playhead) {
    setChartPlayheadPreview(strip, Number(playhead.getAttribute("aria-valuenow")) || 0);
  }
  return canvasWidth;
}

function bindChartZoomControls(options) {
  const { shell, strip, chords } = options;
  const scroll = shell.querySelector(".chart-timeline-scroll");
  const controls = shell.querySelector(".chart-zoom-controls");
  const output = shell.querySelector(".chart-zoom-value");
  if (!scroll || !controls || !output) return;

  const syncOutput = () => {
    const pixelsPerSecond = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
    output.value = Math.round(pixelsPerSecond / TIMELINE_ZOOM_DEFAULT * 100) + "%";
    output.textContent = output.value;
  };

  const applyZoom = (nextValue, anchorClientX) => {
    const oldPixelsPerSecond = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
    const nextPixelsPerSecond = normalizeTimelineZoom(nextValue);
    if (Math.abs(nextPixelsPerSecond - oldPixelsPerSecond) < 0.001) {
      syncOutput();
      return;
    }
    const rect = scroll.getBoundingClientRect();
    const anchorViewportX = Number.isFinite(Number(anchorClientX))
      ? Math.max(0, Math.min(rect.width, Number(anchorClientX) - rect.left))
      : rect.width / 2;
    const duration = Math.max(0, Number(strip.dataset.duration) || 0);
    const displayDuration = Math.max(40, Math.ceil(duration / 5) * 5);
    const newContentWidth = Math.max(840, Math.round(displayDuration * nextPixelsPerSecond));
    const nextScrollLeft = timelineZoomScrollLeft({
      scrollLeft: scroll.scrollLeft,
      viewportWidth: scroll.clientWidth,
      anchorViewportX,
      oldPixelsPerSecond,
      newPixelsPerSecond: nextPixelsPerSecond,
      newContentWidth
    });

    strip.dataset.pixelsPerSecond = String(nextPixelsPerSecond);
    renderChartTimelineScale(strip, chords);
    saveTimelineZoom(nextPixelsPerSecond);
    syncOutput();
    markChartManualScroll(scroll);
    requestAnimationFrame(() => {
      scroll.scrollLeft = nextScrollLeft;
    });
  };

  controls.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-chart-zoom]");
    if (!button) return;
    const action = button.dataset.chartZoom;
    const current = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
    if (action === "reset") applyZoom(TIMELINE_ZOOM_DEFAULT);
    else applyZoom(stepTimelineZoom(current, action === "in" ? 1 : -1));
  });

  scroll.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const current = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
    applyZoom(stepTimelineZoom(current, event.deltaY < 0 ? 1 : -1), event.clientX);
  }, { passive: false });

  const jumpButton = shell.querySelector("#chartJumpToPlayhead");
  if (jumpButton) jumpButton.addEventListener("click", () => {
    const pixelsPerSecond = normalizeTimelineZoom(strip.dataset.pixelsPerSecond);
    const left = stripPlayheadTime(strip) * pixelsPerSecond;
    // Clearing the manual-scroll pause re-enables auto-follow during
    // playback; the auto-scroll window keeps this programmatic jump from
    // being re-classified as a manual scroll.
    delete scroll.dataset.userScrollUntil;
    scroll.dataset.autoScrollUntil = String(performance.now() + 400);
    scroll.scrollLeft = Math.max(0, left - scroll.clientWidth * 0.5);
  });
}

function bindChartTimelineInteractions(strip) {
  const scroll = strip.closest(".chart-timeline-scroll");
  const playhead = strip.querySelector("#chartPlayhead");
  if (!scroll || !playhead || strip.dataset.scrubBound === "true") return;
  strip.dataset.scrubBound = "true";
  let pointerId = null;
  let pendingTime = null;
  let seekFrame = 0;

  const timeAtPointer = (event) => {
    const rect = strip.getBoundingClientRect();
    return timelineSecondsFromClientX({
      clientX: event.clientX,
      timelineLeft: rect.left,
      pixelsPerSecond: Number(strip.dataset.pixelsPerSecond) || 23,
      duration: Number(strip.dataset.duration) || 0
    });
  };

  const flushSeek = () => {
    seekFrame = 0;
    if (pendingTime === null) return;
    const time = pendingTime;
    pendingTime = null;
    setChartPlayheadPreview(strip, time);
    window.FGRBridge?.seekTo(time);
  };

  const requestSeek = (time, immediate = false) => {
    pendingTime = time;
    setChartPlayheadPreview(strip, time);
    if (immediate) {
      if (seekFrame) cancelAnimationFrame(seekFrame);
      flushSeek();
    } else if (!seekFrame) {
      seekFrame = requestAnimationFrame(flushSeek);
    }
  };

  const finishScrub = (event, commitPointerPosition = false) => {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    if (commitPointerPosition && event) {
      requestSeek(timeAtPointer(event), true);
    } else if (pendingTime !== null) {
      if (seekFrame) cancelAnimationFrame(seekFrame);
      flushSeek();
    } else if (seekFrame) {
      cancelAnimationFrame(seekFrame);
      seekFrame = 0;
    }
    const capturedPointerId = pointerId;
    pointerId = null;
    strip.classList.remove("is-scrubbing");
    playhead.setAttribute("aria-grabbed", "false");
    markChartManualScroll(scroll);
    try { strip.releasePointerCapture(capturedPointerId); } catch (_error) {}
  };

  strip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".cc")) return;
    event.preventDefault();
    pointerId = event.pointerId;
    strip.setPointerCapture(pointerId);
    strip.classList.add("is-scrubbing");
    playhead.setAttribute("aria-grabbed", "true");
    markChartManualScroll(scroll);
    requestSeek(timeAtPointer(event), true);
  });
  strip.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    requestSeek(timeAtPointer(event));
  });
  strip.addEventListener("pointerup", (event) => finishScrub(event, true));
  strip.addEventListener("pointercancel", (event) => finishScrub(event, false));
  strip.addEventListener("lostpointercapture", (event) => finishScrub(event, false));

  strip.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".cc")) return;
    event.preventDefault();
    const song = state.repertoire.find((entry) => entry.id === state.selectedSongId) || null;
    if (!song) return;
    const time = timeAtPointer(event);
    setChartPlayheadPreview(strip, time);
    markChartManualScroll(scroll);
    showTimelineContextMenu({
      x: event.clientX,
      y: event.clientY,
      timeLabel: fmtChordTime(time),
      onAdd: () => openTimelineChordPicker(song, time)
    });
  });

  playhead.addEventListener("keydown", (event) => {
    const current = Number(playhead.getAttribute("aria-valuenow")) || 0;
    const duration = Number(strip.dataset.duration) || 0;
    const amount = event.shiftKey ? 5 : 1;
    let next = current;
    if (event.key === "ArrowLeft") next -= amount;
    else if (event.key === "ArrowRight") next += amount;
    else if (event.key === "PageDown") next -= 10;
    else if (event.key === "PageUp") next += 10;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = duration;
    else return;
    event.preventDefault();
    markChartManualScroll(scroll);
    requestSeek(Math.max(0, Math.min(duration, next)), true);
  });

  scroll.addEventListener("wheel", () => markChartManualScroll(scroll), { passive: true });
  scroll.addEventListener("pointerdown", () => markChartManualScroll(scroll), { passive: true });
  scroll.addEventListener("scroll", () => {
    if (performance.now() > (Number(scroll.dataset.autoScrollUntil) || 0)) markChartManualScroll(scroll);
  }, { passive: true });
}

function bindChordBoundaryInteractions(options) {
  const { strip, cell, chord, index, chords, duration, pixelsPerSecond, currentSong } = options;
  const scroll = strip.closest(".chart-timeline-scroll");
  const moveSurface = cell.querySelector(".cc-move-surface");
  const leftHandle = cell.querySelector(".cc-edge-left");
  const rightHandle = cell.querySelector(".cc-edge-right");
  let activeInput = null;
  let pointerId = null;
  let editMode = "move";
  let startClientX = 0;
  let previewEdit = null;
  let dragged = false;
  let ignoreClickUntil = 0;
  const currentDuration = () => Number(strip.dataset.duration) || duration;
  const currentPixelsPerSecond = () => normalizeTimelineZoom(strip.dataset.pixelsPerSecond || pixelsPerSecond);
  const currentChordEndTime = () => resolveChordEndTime(
    chords,
    currentDuration(),
    Number(strip.dataset.chordEndTime)
  );
  const buildEdit = (deltaSeconds) => editChordSegment(chords, index, editMode, deltaSeconds, {
    duration: currentDuration(),
    chordEndTime: currentChordEndTime(),
    minimumGap: 0.05
  });

  const renderPreview = (edit) => {
    previewEdit = edit;
    edit.chords.forEach((entry, entryIndex) => {
      const target = strip.querySelector(`.cc[data-index="${entryIndex}"]`);
      if (!target) return;
      const geometry = chordSegmentGeometry(
        edit.chords,
        entryIndex,
        currentDuration(),
        currentPixelsPerSecond(),
        edit.chordEndTime
      );
      target.style.left = `${geometry.left}px`;
      target.style.width = `${geometry.width}px`;
      const durationLabel = target.querySelector(".cc-duration");
      if (durationLabel) durationLabel.textContent = `${geometry.duration.toFixed(1)} s`;
      target.dataset.t = String(entry.t);
      target.setAttribute("aria-label", `${transposeChordName(entry.n || "")}, od ${fmtChordTime(geometry.start)} do ${fmtChordTime(geometry.end)}`);
      const timeLabel = target.querySelector(".t");
      if (timeLabel) timeLabel.textContent = fmtChordTime(entry.t);
    });
    const activeGeometry = chordSegmentGeometry(
      edit.chords,
      index,
      currentDuration(),
      currentPixelsPerSecond(),
      edit.chordEndTime
    );
    const liveTime = cell.querySelector(".cc-live-time");
    if (liveTime) {
      liveTime.textContent = editMode === "move"
        ? `${fmtChordTime(activeGeometry.start)}–${fmtChordTime(activeGeometry.end)} · ${activeGeometry.duration.toFixed(2)} s`
        : editMode === "right"
          ? `Kraj ${fmtChordTime(activeGeometry.end)} · ${activeGeometry.duration.toFixed(2)} s`
          : `Početak ${fmtChordTime(activeGeometry.start)} · ${activeGeometry.duration.toFixed(2)} s`;
    }
    cell.dataset.previewTime = String(edit.chords[index]?.t || 0);
    cell.setAttribute("aria-label", `${transposeChordName(chord.n)}, od ${fmtChordTime(activeGeometry.start)} do ${fmtChordTime(activeGeometry.end)}`);
    return edit;
  };

  const commit = (edit, input) => {
    window.dispatchEvent(new CustomEvent("fgr:movechordrequest", {
      detail: {
        index,
        mode: editMode,
        deltaSeconds: edit.appliedDelta,
        duration: currentDuration(),
        chordEndTime: currentChordEndTime(),
        input
      }
    }));
  };

  const updateFromClientX = (clientX) => {
    const position = Number(clientX);
    if (!Number.isFinite(position)) return;
    const deltaPixels = position - startClientX;
    if (!dragged && Math.abs(deltaPixels) < 3) return;
    dragged = true;
    renderPreview(buildEdit(deltaPixels / currentPixelsPerSecond()));
  };

  const detachGlobalDragListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("pointercancel", handlePointerCancel, true);
    window.removeEventListener("mousemove", handleMouseMove, true);
    window.removeEventListener("mouseup", handleMouseUp, true);
    window.removeEventListener("blur", handleWindowBlur, true);
  };

  const finishDrag = (event, shouldCommit) => {
    if (!activeInput) return;
    if (activeInput === "pointer" && event?.pointerId !== undefined && event.pointerId !== pointerId) return;
    if (shouldCommit && event) updateFromClientX(event.clientX);
    const completedInput = activeInput;
    const completedPointerId = pointerId;
    activeInput = null;
    pointerId = null;
    detachGlobalDragListeners();
    cell.classList.remove("is-adjusting", "is-moving", "is-resizing-left", "is-resizing-right");
    cell.setAttribute("aria-grabbed", "false");
    cell.dataset.dragState = "idle";
    markChartManualScroll(scroll);
    if (completedInput === "pointer" && completedPointerId !== null) {
      try { cell.releasePointerCapture(completedPointerId); } catch (_error) {}
    }

    if (shouldCommit && dragged) {
      ignoreClickUntil = performance.now() + 650;
      if (previewEdit?.changed) commit(previewEdit, completedInput);
    } else {
      renderPreview(buildEdit(0));
    }
  };

  function handlePointerMove(event) {
    if (activeInput !== "pointer" || event.pointerId !== pointerId) return;
    event.preventDefault();
    updateFromClientX(event.clientX);
  }

  function handlePointerUp(event) {
    if (activeInput !== "pointer" || event.pointerId !== pointerId) return;
    event.preventDefault();
    finishDrag(event, true);
  }

  function handlePointerCancel(event) {
    if (activeInput !== "pointer" || event.pointerId !== pointerId) return;
    finishDrag(event, false);
  }

  function handleMouseMove(event) {
    if (!activeInput) return;
    event.preventDefault();
    updateFromClientX(event.clientX);
  }

  function handleMouseUp(event) {
    if (!activeInput) return;
    event.preventDefault();
    finishDrag(event, true);
  }

  function handleWindowBlur() {
    finishDrag(null, false);
  }

  const attachGlobalDragListeners = () => {
    // Listen outside the card while dragging. This keeps mouse input working
    // even when pointer capture is unavailable or an injected drag only emits
    // the classic mouse event sequence.
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", handlePointerUp, { capture: true, passive: false });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true, passive: false });
    window.addEventListener("mousemove", handleMouseMove, { capture: true, passive: false });
    window.addEventListener("mouseup", handleMouseUp, { capture: true, passive: false });
    window.addEventListener("blur", handleWindowBlur, true);
  };

  const beginDrag = (event, input, mode) => {
    if (activeInput || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activeInput = input;
    editMode = mode;
    pointerId = input === "pointer" ? event.pointerId : null;
    startClientX = Number(event.clientX) || 0;
    previewEdit = buildEdit(0);
    dragged = false;
    cell.classList.add("is-adjusting", mode === "right" ? "is-resizing-right" : mode === "left" ? "is-resizing-left" : "is-moving");
    cell.setAttribute("aria-grabbed", "true");
    cell.dataset.dragState = "dragging";
    renderPreview(previewEdit);
    cell.focus({ preventScroll: true });
    markChartManualScroll(scroll);
    attachGlobalDragListeners();
    if (input === "pointer") {
      try { cell.setPointerCapture(pointerId); } catch (_error) {}
    }
  };

  cell.dataset.boundaryAdjustable = "true";
  cell.dataset.dragState = "idle";
  cell.title = "Sredina pomera ceo akord; leva i desna ivica menjaju trajanje. Desni klik otvara izmene.";
  cell.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight Shift+ArrowLeft Shift+ArrowRight");
  cell.setAttribute("aria-grabbed", "false");

  const bindDragStart = (target, mode) => {
    if (!target || target.disabled) return;
    target.addEventListener("pointerdown", (event) => beginDrag(event, "pointer", mode));
    target.addEventListener("mousedown", (event) => beginDrag(event, "mouse", mode));
  };
  bindDragStart(moveSurface, "move");
  bindDragStart(leftHandle, "left");
  bindDragStart(rightHandle, "right");
  cell.addEventListener("dragstart", (event) => event.preventDefault());

  cell.addEventListener("keydown", (event) => {
    const edgeMode = event.target.closest?.(".cc-edge-right") ? "right" : event.target.closest?.(".cc-edge-left") ? "left" : "move";
    const edgeHasFocus = edgeMode !== "move";
    if ((!edgeHasFocus && !(event.altKey || event.shiftKey)) || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    editMode = edgeMode;
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const edit = renderPreview(buildEdit(direction * 0.05));
    if (edit.changed) commit(edit, "keyboard");
    markChartManualScroll(scroll);
  });

  moveSurface?.addEventListener("click", (event) => {
    if (performance.now() < ignoreClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    window.dispatchEvent(new CustomEvent("fgr:seekrequest", {
      detail: { time: Number(cell.dataset.t) || 0 }
    }));
    paintChordName(transposeChordName(chord.n), false);
  });
  cell.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const pointerTime = timelineSecondsFromClientX({
      clientX: event.clientX,
      timelineLeft: strip.getBoundingClientRect().left,
      pixelsPerSecond: currentPixelsPerSecond(),
      duration: currentDuration()
    });
    showChordContextMenu({
      x: event.clientX,
      y: event.clientY,
      name: chord.n,
      onEdit: () => openExistingChordPicker(currentSong, index, cell),
      onSplit: () => requestChordSplit(currentSong, index, pointerTime, strip),
      onAddAtPlayhead: () => openPlayheadChordInsert(currentSong, index, strip),
      onDelete: () => requestChordDeletion(currentSong, index)
    });
  });
}

// ---------------- ALATI (akordi, skale, vezba, chart) ----------------
export const TOOLS = {
  akordi: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="scale-head">' + keyPickerHTML("ak") +
      '<label>Tip <select id="akVariant">' +
      '<option value="all">Sve</option><option value="triad">Osnovni</option><option value="7">7</option><option value="9">9</option>' +
      '<option value="sus">sus</option><option value="maj7">maj7</option><option value="dim">dim</option></select></label>' +
      '<label>Hvat <select id="akInversion">' +
      '<option value="0">osnovni</option><option value="1">1. obrt</option><option value="2">2. obrt</option><option value="3">3. obrt</option></select></label>' +
      '<span class="tool-note" style="margin:0 0 0 auto">klik na akord - odsvira se izabrani hvat na klaviru dole</span></div>' +
      '<div class="deg-row expanded" id="akRow"></div>';
    
    var read = initKeyPicker("ak", renderRow);
    var akVariant = document.getElementById("akVariant");
    var akInversion = document.getElementById("akInversion");
    akVariant.addEventListener("change", renderRow);
    akInversion.addEventListener("change", renderRow);

    function renderRow() {
      var k = read();
      var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
      var variantIds = CHORD_VARIANT_GROUPS[akVariant.value] || CHORD_VARIANT_GROUPS.all;
      var inversion = Number(akInversion.value) || 0;
      var row = document.getElementById("akRow");
      row.innerHTML = "";
      degrees.forEach(function (d) {
        var pc = (k.pc + d[2]) % 12;
        variantIds.forEach(function (variantId) {
          var intervals = chordIntervals(d[1], variantId);
          var midis = chordMidisFromIntervals(pc, intervals, inversion, { anchorPc: k.pc });
          var name = chordName(pc, d[1], variantId);
          var actualInversion = Math.min(inversion, Math.max(0, midis.length - 1));
          var card = document.createElement("button");
          card.type = "button";
          card.className = "deg" + (d[3] ? " alt" : "");
          card.dataset.midis = midis.join(",");
          card.innerHTML = '<span class="r">' + d[0] + (variantId === "triad" ? "" : " · " + CHORD_VARIANTS[variantId].label) + '</span>' +
            '<span class="nm">' + name + "</span>" +
            '<span class="nt">' + noteNamesForIntervals(pc, intervals) + " · " + inversionLabel(actualInversion) + "</span>";
          card.addEventListener("click", function () {
            pressKeys(midis, 700, card);
            paintMidis(midis, name + " · " + inversionLabel(actualInversion), { autoClear: true, holdMs: 900 });
          });
          row.appendChild(card);
        });
      });
    }
    renderRow();
  },

  skale: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="scale-head"><label>Osnova <select id="scRoot"></select></label>' +
      '<label>Skala <select id="scType"></select></label>' +
      '<label class="toggle-row inline-toggle"><input id="scAllOctaves" type="checkbox"><span>Ceo klavir</span></label>' +
      '<button class="text-button mini" id="scPlay" type="button">&#9654; Odsviraj</button>' +
      '<button class="text-button mini" id="scClear" type="button">Obrisi oznake</button></div>' +
      '<div class="formula" id="scFormula"></div>' +
      '<p class="tool-note">Oznaceni tonovi su prikazani jednako. Opcija <b>Ceo klavir</b> ponavlja iste tonove kroz sve oktave.</p>';
    
    var scRoot = document.getElementById("scRoot");
    var scType = document.getElementById("scType");
    var scAllOctaves = document.getElementById("scAllOctaves");
    
    NOTE_NAMES.forEach(function (n, i) { scRoot.add(new Option(n, i)); });
    Object.keys(SCALES).forEach(function (k) { scType.add(new Option(k, k)); });
    var k = shownKey();
    scRoot.value = String(k.pc);
    scType.value = k.minor ? "harmonijski mol" : "dur";
    scAllOctaves.checked = state.scaleAllOctaves;

    function update() {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value];
      paintScale(pc, ivs, NOTE_NAMES[pc] + " " + scType.value, { allOctaves: state.scaleAllOctaves, anchorPc: pc });
      document.getElementById("scFormula").innerHTML = ivs.map(function (iv) {
        return '<span class="fstep">' + NOTE_NAMES[(pc + iv) % 12] + "</span>";
      }).join("");
    }
    scRoot.addEventListener("change", update);
    scType.addEventListener("change", update);
    scAllOctaves.addEventListener("change", function () {
      state.scaleAllOctaves = scAllOctaves.checked;
      writeJsonStorage("fgr-ui-v1", { 
        theme: state.theme, 
        tool: state.tool, 
        scaleAllOctaves: state.scaleAllOctaves, 
        octaveLocked: state.octaveLocked 
      });
      update();
    });
    document.getElementById("scClear").addEventListener("click", clearScale);
    document.getElementById("scPlay").addEventListener("click", function () {
      var pc = Number(scRoot.value) || 0;
      var ivs = SCALES[scType.value].concat([12]);
      var base = selectedRootMidi(pc, { anchorPc: pc });
      ivs.forEach(function (iv, i) {
        setTimeout(function () { pressKeys([base + iv], 240); }, i * 280);
      });
    });
    update();
  },

  vezba: function () {
    const toolBody = document.getElementById("toolBody");
    toolBody.innerHTML = '<div class="practice expanded-practice">' +
      '<div class="practice-controls"><label>Tip vezbe <select id="vzMode">' +
      '<option value="all">Sve</option><option value="chord">Akordi i obrtaji</option><option value="scale">Skale</option>' +
      '<option value="interval">Intervali</option><option value="degree">Stepeni tonaliteta</option>' +
      '<option value="trans_drill">Transpozicija akorda</option></select></label>' +
      '<button class="text-button mini" id="vzNew" type="button">Novi zadatak</button>' +
      '<button class="text-button mini" id="vzSkip" type="button">Preskoci</button></div>' +
      '<div class="streak"><span>Niz: <b id="vzStreak">0</b></span><span>Tacno: <b id="vzScore">0/0</b></span>' +
      '<span>Tonalitet: <b id="vzKey"></b></span></div>' +
      '<div class="task"><div><div class="q" id="vzPrompt">Zadatak</div><div class="big" id="vzTask">-</div>' +
      '<div class="practice-answer" id="vzAnswer"></div></div><span class="st" id="vzState">ceka...</span></div>' +
      '<div class="practice-progress" id="vzProgress"></div>' +
      '<p class="tool-note"><b>Vezbe:</b> akordi sa 7/9/sus/maj/dim i obrtajima, skale, intervali, stepeni tonaliteta i transpozicioni izazovi. Radi preko MIDI klavijature i preko klavira dole.</p></div>';

    var k = shownKey();
    var modeSelect = document.getElementById("vzMode");
    var degrees = k.minor ? MINOR_DEGREES : MAJOR_DEGREES;
    var streak = 0, good = 0, total = 0, target = null, lock = false, inputHistory = new Set();
    document.getElementById("vzKey").textContent = formatKey(k.pc, k.minor);

    function rand(items) {
      return items[Math.floor(Math.random() * items.length)];
    }
    function pcsFrom(rootPc, intervals) {
      return Array.from(new Set(intervals.map(function (iv) { return (rootPc + iv) % 12; })));
    }
    function degreeName(d) {
      return d[0].replace(" dur", "");
    }
    function taskKinds() {
      return modeSelect.value === "all" ? ["chord", "scale", "interval", "degree", "trans_drill"] : [modeSelect.value];
    }
    function makeChordTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      var variantId = rand(["triad", "7", "9", "sus", "maj7", "dim"]);
      var intervals = chordIntervals(d[1], variantId);
      var inversion = Math.min(rand([0, 1, 2, 3]), Math.max(0, intervals.length - 1));
      var midis = chordMidisFromIntervals(pc, intervals, inversion, { anchorPc: k.pc });
      var name = chordName(pc, d[1], variantId);
      return {
        kind: "chord",
        prompt: "Odsviraj akord",
        title: name + " · " + inversionLabel(inversion),
        answer: degreeName(d) + " stepen · " + noteNamesForIntervals(pc, intervals),
        pcs: pcsFrom(pc, intervals),
        exact: true,
        bassPc: ((midis[0] % 12) + 12) % 12,
        midis: midis
      };
    }
    function makeTransDrillTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      var variantId = rand(["triad", "7", "maj7", "sus"]);
      var intervals = chordIntervals(d[1], variantId);
      var shift = rand([-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6]);
      var shiftedPc = (pc + shift + 12) % 12;
      var name = chordName(pc, d[1], variantId);
      var shiftedName = chordName(shiftedPc, d[1], variantId);
      var midis = chordMidisFromIntervals(shiftedPc, intervals, 0, { anchorPc: k.pc });
      return {
        kind: "trans_drill",
        prompt: "Transponuj akord na brzinu",
        title: name + " transponovano za " + (shift > 0 ? "+" + shift : shift) + " polust.",
        answer: shiftedName + " (" + noteNamesForIntervals(shiftedPc, intervals) + ")",
        pcs: pcsFrom(shiftedPc, intervals),
        exact: true,
        bassPc: shiftedPc,
        midis: midis
      };
    }
    function makeScaleTask() {
      var names = Object.keys(SCALES);
      var scaleName = rand(names);
      var rootPc = Math.random() < 0.65 ? k.pc : (k.pc + rand(degrees)[2]) % 12;
      var intervals = SCALES[scaleName];
      return {
        kind: "scale",
        prompt: "Odsviraj tonove skale",
        title: NOTE_NAMES[rootPc] + " " + scaleName,
        answer: intervals.map(function (iv) { return NOTE_NAMES[(rootPc + iv) % 12]; }).join(" "),
        pcs: pcsFrom(rootPc, intervals),
        accumulate: true,
        rootPc: rootPc,
        intervals: intervals
      };
    }
    function makeIntervalTask() {
      var d = rand(degrees);
      var rootPc = (k.pc + d[2]) % 12;
      var interval = rand(INTERVAL_DRILLS);
      return {
        kind: "interval",
        prompt: "Odsviraj interval",
        title: NOTE_NAMES[rootPc] + " + " + interval[0],
        answer: NOTE_NAMES[rootPc] + " - " + NOTE_NAMES[(rootPc + interval[1]) % 12],
        pcs: pcsFrom(rootPc, [0, interval[1]]),
        accumulate: true,
        midis: chordMidisFromIntervals(rootPc, [0, interval[1]], 0, { anchorPc: rootPc })
      };
    }
    function makeDegreeTask() {
      var d = rand(degrees);
      var pc = (k.pc + d[2]) % 12;
      return {
        kind: "degree",
        prompt: "Pronađi stepen tonaliteta",
        title: degreeName(d) + " u " + formatKey(k.pc, k.minor),
        answer: NOTE_NAMES[pc],
        pcs: [pc],
        accumulate: true,
        midis: [selectedRootMidi(pc, { anchorPc: k.pc })]
      };
    }
    function makeTask() {
      var kind = rand(taskKinds());
      if (kind === "scale") return makeScaleTask();
      if (kind === "interval") return makeIntervalTask();
      if (kind === "degree") return makeDegreeTask();
      if (kind === "trans_drill") return makeTransDrillTask();
      return makeChordTask();
    }
    function updateProgress() {
      if (!target) return;
      var done = target.pcs.filter(function (pc) { return inputHistory.has(pc); });
      document.getElementById("vzProgress").textContent = target.accumulate && done.length
        ? "Pogođeno: " + done.map(function (pc) { return NOTE_NAMES[pc]; }).join(" ") + " (" + done.length + "/" + target.pcs.length + ")"
        : "";
    }
    function paintTask() {
      if (target.kind === "scale") {
        paintScale(target.rootPc, target.intervals, target.title, { allOctaves: state.scaleAllOctaves, anchorPc: target.rootPc });
      } else {
        paintMidis(target.midis || target.pcs.map(selectedRootMidi), target.title);
      }
    }
    function newTask() {
      inputHistory = new Set();
      target = makeTask();
      lock = false;
      document.getElementById("vzPrompt").textContent = target.prompt;
      document.getElementById("vzTask").textContent = target.title;
      document.getElementById("vzAnswer").textContent = target.answer;
      document.getElementById("vzState").textContent = "čeka...";
      document.getElementById("vzState").classList.remove("good", "bad");
      document.getElementById("vzProgress").textContent = "";
      paintTask();
    }
    function markDone() {
      lock = true;
      streak++; good++; total++;
      document.getElementById("vzStreak").textContent = streak;
      document.getElementById("vzScore").textContent = good + "/" + total;
      document.getElementById("vzState").textContent = "Tačno!";
      document.getElementById("vzState").classList.remove("bad");
      document.getElementById("vzState").classList.add("good");
      window.setTimeout(newTask, 850);
    }
    function check(pcSet, meta) {
      if (lock || !target) return;
      if (meta && meta.down && Number.isFinite(meta.pc)) inputHistory.add(meta.pc);
      pcSet.forEach(function (pc) { inputHistory.add(pc); });
      updateProgress();

      var ok = false;
      if (target.exact) {
        ok = target.pcs.every(function (pc) { return pcSet.has(pc); }) && pcSet.size === target.pcs.length;
        if (ok && target.bassPc !== undefined && meta && Array.isArray(meta.midis) && meta.midis.length) {
          var bassMidi = meta.midis.reduce(function (a, b) { return a < b ? a : b; });
          ok = ((bassMidi % 12) + 12) % 12 === target.bassPc;
        }
        if (!ok && pcSet.size >= target.pcs.length) {
          document.getElementById("vzState").textContent = "probaj drugi hvat / obrt";
          document.getElementById("vzState").classList.add("bad");
        }
      } else {
        ok = target.pcs.every(function (pc) { return inputHistory.has(pc); });
      }
      if (ok) markDone();
    }

    setMidiOnChordCallback(check);
    modeSelect.addEventListener("change", newTask);
    document.getElementById("vzNew").addEventListener("click", newTask);
    document.getElementById("vzSkip").addEventListener("click", function () {
      streak = 0; total++;
      document.getElementById("vzStreak").textContent = "0";
      document.getElementById("vzScore").textContent = good + "/" + total;
      newTask();
    });
    connectMidi(true);
    newTask();
  },

  chart: function () {
    const toolBody = document.getElementById("toolBody");
    const currentSong = state.repertoire.find((song) => song.id === state.selectedSongId) || null;
    var chords = currentSong && Array.isArray(currentSong.chords) ? currentSong.chords : [];
    var lastTime = chords.reduce(function (maximum, chord) {
      return Math.max(maximum, Number(chord.t) || 0);
    }, 0);
    var knownDuration = currentSong && window.FGRBridge?.getDuration
      ? Number(window.FGRBridge.getDuration()) || 0
      : Number(currentSong?.duration || currentSong?.source?.duration) || 0;
    var duration = knownDuration > 0
      ? Math.max(knownDuration, lastTime + 0.05)
      : Math.max(40, lastTime + 8);
    var displayDuration = Math.max(40, Math.ceil(duration / 5) * 5);
    var chordEndTime = resolveChordEndTime(chords, duration, currentSong?.chordEndTime);
    var pixelsPerSecond = readTimelineZoom();
    var canvasWidth = Math.max(840, Math.round(displayDuration * pixelsPerSecond));

    toolBody.innerHTML =
      '<div class="chart-timeline-shell">' +
        '<div class="chart-zoom-bar">' +
          '<button type="button" class="chart-playhead-jump" id="chartJumpToPlayhead" title="Skroluj timeline na trenutnu poziciju plejheda">⌖ Na plejhed</button>' +
          '<span>Zum timelinea</span>' +
          '<div class="chart-zoom-controls" role="group" aria-label="Zum timelinea">' +
            '<button type="button" data-chart-zoom="out" aria-label="Umanji timeline">&minus;</button>' +
            '<button class="chart-zoom-value" type="button" data-chart-zoom="reset" title="Vrati na 100%">100%</button>' +
            '<button type="button" data-chart-zoom="in" aria-label="Uvećaj timeline">+</button>' +
          '</div>' +
          '<small>Ctrl + točkić</small>' +
        '</div>' +
        '<div class="chart-timeline-scroll">' +
          '<div class="chart-timeline" id="ccStrip" data-duration="' + duration + '" data-chord-end-time="' + chordEndTime + '" data-pixels-per-second="' + pixelsPerSecond + '" style="width:' + canvasWidth + 'px">' +
            '<div class="chart-ruler" aria-hidden="true"></div>' +
            '<div class="chart-grid" aria-hidden="true"></div>' +
            '<div class="chart-chords" role="list" aria-label="Akordi pesme"></div>' +
            '<div class="chart-line chart-line-melody" role="list" aria-label="Melodija"><span class="chart-line-tag">Melodija</span></div>' +
            '<div class="chart-line chart-line-bass" role="list" aria-label="Bas linija"><span class="chart-line-tag">Bas</span></div>' +
            '<button class="chart-playhead" id="chartPlayhead" type="button" role="slider" aria-label="Pozicija 0:00.0" aria-valuemin="0" aria-valuemax="' + duration + '" aria-valuenow="0" aria-grabbed="false"></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var strip = document.getElementById("ccStrip");
    var ruler = strip.querySelector(".chart-ruler");
    var grid = strip.querySelector(".chart-grid");
    var chordLayer = strip.querySelector(".chart-chords");
    renderNoteLane(strip.querySelector(".chart-line-melody"), currentSong, "melody", pixelsPerSecond);
    renderNoteLane(strip.querySelector(".chart-line-bass"), currentSong, "bass", pixelsPerSecond);

    var tickSeconds = timelineTickSeconds(pixelsPerSecond);
    for (var second = 0; second <= displayDuration; second += tickSeconds) {
      var left = second * pixelsPerSecond;
      var tick = document.createElement("span");
      tick.style.left = left + "px";
      tick.textContent = fmtTime(second);
      ruler.appendChild(tick);
      var line = document.createElement("i");
      line.style.left = left + "px";
      grid.appendChild(line);
    }

    if (!chords.length) {
      var empty = document.createElement("div");
      empty.className = "chart-empty chart-timeline-empty";
      empty.innerHTML = currentSong
        ? 'Još nema akorda. Pusti pesmu i klikni <b>+ Akord</b>, ili pokreni AI prepoznavanje u koraku 3.'
        : "Izaberi pesmu iz repertoara da otvoriš njen chart.";
      chordLayer.appendChild(empty);
    } else {
      chords.forEach(function (chord, index) {
        var cell = document.createElement("div");
        cell.className = "cc";
        cell.tabIndex = 0;
        cell.dataset.t = chord.t;
        cell.dataset.index = String(index);
        var geometry = chordSegmentGeometry(chords, index, duration, pixelsPerSecond, chordEndTime);
        cell.style.left = geometry.left + "px";
        cell.style.width = geometry.width + "px";
        cell.style.top = "8px";
        cell.setAttribute("role", "listitem");
        cell.setAttribute("aria-label", transposeChordName(chord.n) + " od " + fmtChordTime(geometry.start) + " do " + fmtChordTime(geometry.end));
        cell.innerHTML =
          '<button class="cc-edge cc-edge-left" type="button" aria-label="Promeni početak akorda"></button>' +
          '<button class="cc-move-surface" type="button" aria-label="Pomeri akord"><span class="n">' + transposeChordName(chord.n) + '</span><span class="t">' + fmtChordTime(chord.t) + '</span><span class="cc-duration">' + geometry.duration.toFixed(1) + ' s</span></button>' +
          '<button class="cc-edge cc-edge-right" type="button" aria-label="Promeni kraj akorda"></button>' +
          '<output class="cc-live-time" aria-hidden="true"></output>';
        bindChordBoundaryInteractions({ strip, cell, chord, index, chords, duration, pixelsPerSecond, currentSong });
        chordLayer.appendChild(cell);
      });
      strip.dataset.lanes = "1";
    }
    bindChartTimelineInteractions(strip);
    bindChartZoomControls({ shell: strip.closest(".chart-timeline-shell"), strip, chords });
  },
  
  // Krug kvinti
  krug: function() {
    const toolBody = document.getElementById("toolBody");
    const live = state.currentPlaybackChordName ? "Live: " + state.currentPlaybackChordName : "Live: nema akorda";
    toolBody.innerHTML = '<div class="scale-head"><b>Krug kvinti</b><span class="tool-note" style="margin:0 0 0 auto">' + live + '</span></div>' +
      '<div class="circle-shell"><div id="circleContainer" style="max-width:340px;margin:0 auto;"></div></div>';
    renderCircleOfFifths();
  }
};

export function renderTool() {
  const toolBody = document.getElementById("toolBody");
  if (!toolBody) return;
  if (!TOOLS[state.tool]) {
    state.tool = "akordi";
    writeJsonStorage("fgr-ui-v1", { 
      theme: state.theme, 
      tool: state.tool, 
      scaleAllOctaves: state.scaleAllOctaves, 
      octaveLocked: state.octaveLocked 
    });
  }
  
  const chipsWrap = document.getElementById("toolChips");
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === state.tool);
    });
  }
  const addChordButton = document.getElementById("learnAddChord");
  if (addChordButton) addChordButton.hidden = state.tool !== "chart";
  const octaveControl = document.querySelector(".tool-octave");
  if (octaveControl) octaveControl.hidden = state.tool === "chart";
  if (state.tool !== "vezba") {
    setMidiOnChordCallback(null);
  }
  TOOLS[state.tool]();
}

export function selectTool(name) {
  if (!TOOLS[name]) name = "akordi";
  state.tool = name;
  writeJsonStorage("fgr-ui-v1", { 
    theme: state.theme, 
    tool: state.tool, 
    scaleAllOctaves: state.scaleAllOctaves, 
    octaveLocked: state.octaveLocked 
  });
  
  const chipsWrap = document.getElementById("toolChips");
  if (chipsWrap) {
    Array.prototype.forEach.call(chipsWrap.children, function (chip) {
      chip.classList.toggle("on", chip.dataset.m === name);
    });
  }
  clearScale();
  renderTool();
}

// ---------------- KRUG KVINTI CRTANJE ----------------
// Globalna funkcija za reprodukciju akorada iz kruga kvinti
window.playCircleChord = function(pc, quality) {
  const intervals = quality === "minor" ? [0, 3, 7] : [0, 4, 7];
  const baseMidi = 12 * 3 + pc; // Oktava niže za puniji zvuk akorda (C3..)
  const midis = intervals.map(iv => baseMidi + iv);
  const label = NOTE_NAMES[pc] + (quality === "minor" ? "m" : "");
  
  pressKeys(midis, 800);
  paintMidis(midis, label, { autoClear: true, holdMs: 1000 });
};

function chordQualityFromName(name) {
  var m = String(name || "").trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return "major";
  var suffix = m[2].split("/")[0].trim();
  return suffix.indexOf("m") === 0 && suffix.indexOf("maj") !== 0 ? "minor" : "major";
}

function renderCircleOfFifths() {
  const container = document.getElementById("circleContainer");
  if (!container) return;

  const currentKey = shownKey();
  const circleMajor = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
  const liveChord = parseChordName(state.currentPlaybackChordName || "");
  const liveQuality = chordQualityFromName(state.currentPlaybackChordName || "");
  const livePc = liveChord ? liveChord.pc : null;
  const keyMajorPc = currentKey.minor ? (currentKey.pc + 3) % 12 : currentKey.pc;
  const keyMinorPc = currentKey.minor ? currentKey.pc : (currentKey.pc + 9) % 12;

  let html = `<svg viewBox="0 0 300 300" width="100%" height="100%" aria-label="Krug kvinti">
    <circle cx="150" cy="150" r="142" fill="none" stroke="var(--line)" stroke-width="1" />
    <circle cx="150" cy="150" r="110" fill="none" stroke="var(--line)" stroke-width="1" />
    <circle cx="150" cy="150" r="78" fill="none" stroke="var(--line)" stroke-width="1" />
    <text x="150" y="144" text-anchor="middle" font-size="10" font-weight="800" fill="var(--muted)">TONALITET</text>
    <text x="150" y="160" text-anchor="middle" font-size="15" font-weight="900" fill="var(--ink)">${formatKey(currentKey.pc, currentKey.minor)}</text>`;

  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const xMajor = 150 + 126 * Math.cos(angle);
    const yMajor = 150 + 126 * Math.sin(angle);
    const pcMajor = circleMajor[i];

    const pcMinor = (pcMajor + 9) % 12;
    const xMinor = 150 + 94 * Math.cos(angle);
    const yMinor = 150 + 94 * Math.sin(angle);

    const isKeyMajor = pcMajor === keyMajorPc;
    const isKeyMinor = pcMinor === keyMinorPc;
    const isLiveMajor = livePc === pcMajor && liveQuality === "major";
    const isLiveMinor = livePc === pcMinor && liveQuality === "minor";

    let fillMajor = "transparent";
    let strokeMajor = "var(--line)";
    let textMajorColor = "var(--ink-2)";
    if (isLiveMajor) {
      fillMajor = "#2f9bff";
      strokeMajor = "#2f9bff";
      textMajorColor = "#ffffff";
    } else if (isKeyMajor) {
      fillMajor = "var(--accent)";
      strokeMajor = "var(--accent)";
      textMajorColor = "var(--accent-contrast)";
    }

    let fillMinor = "transparent";
    let strokeMinor = "var(--line)";
    let textMinorColor = "var(--muted)";
    if (isLiveMinor) {
      fillMinor = "#2f9bff";
      strokeMinor = "#2f9bff";
      textMinorColor = "#ffffff";
    } else if (isKeyMinor) {
      fillMinor = "var(--accent-soft)";
      strokeMinor = "color-mix(in srgb, var(--accent) 55%, transparent)";
      textMinorColor = "var(--accent-strong)";
    }

    html += `<g class="circle-chord-btn" onclick="window.playCircleChord(${pcMajor}, 'major')">
      <circle cx="${xMajor}" cy="${yMajor}" r="14" fill="${fillMajor}" stroke="${strokeMajor}" stroke-width="1.5" />
      <text x="${xMajor}" y="${yMajor + 4}" font-size="11" font-weight="800" text-anchor="middle" fill="${textMajorColor}">${NOTE_NAMES[pcMajor]}</text>
    </g>`;

    html += `<g class="circle-chord-btn" onclick="window.playCircleChord(${pcMinor}, 'minor')">
      <circle cx="${xMinor}" cy="${yMinor}" r="12" fill="${fillMinor}" stroke="${strokeMinor}" stroke-width="1.5" />
      <text x="${xMinor}" y="${yMinor + 4}" font-size="9" font-weight="700" text-anchor="middle" fill="${textMinorColor}">${NOTE_NAMES[pcMinor].toLowerCase()}m</text>
    </g>`;
  }

  html += `</svg>`;
  container.innerHTML = html;
}
// ---------------- POMOCNE ZA KEY PICKER ----------------
function keyPickerHTML(idPrefix) {
  return '<label>Tonalitet <select id="' + idPrefix + 'Root"></select></label>' +
    '<div class="segmented compact" role="radiogroup"><label><input type="radio" name="' + idPrefix + 'Q" value="major"><span>Dur</span></label>' +
    '<label><input type="radio" name="' + idPrefix + 'Q" value="minor"><span>Mol</span></label></div>';
}

function initKeyPicker(idPrefix, onChange) {
  var sel = document.getElementById(idPrefix + "Root");
  NOTE_NAMES.forEach(function (n, i) { sel.add(new Option(n, i)); });
  var k = shownKey();
  sel.value = String(k.pc);
  var radios = document.querySelectorAll('input[name="' + idPrefix + 'Q"]');
  radios.forEach(function (r) {
    r.checked = (r.value === "minor") === k.minor;
    r.addEventListener("change", onChange);
  });
  sel.addEventListener("change", onChange);
  return function read() {
    var minor = true;
    radios.forEach(function (r) { if (r.checked) minor = r.value === "minor"; });
    return { pc: Number(sel.value) || 0, minor: minor };
  };
}

function songKey() {
  const currentSong = state.repertoire.find((song) => song.id === state.selectedSongId) || null;
  var parsed = currentSong ? parseKey(currentSong.key) : null;
  return parsed || { pc: 9, minor: true }; // a-mol
}

export function shownKey() {
  var k = songKey();
  return { pc: ((k.pc + state.transpose) % 12 + 12) % 12, minor: k.minor };
}

export function transposeChordName(name) {
  if (state.transpose === 0) return name;
  var m = String(name).match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return name;
  var pc = NOTE_NAMES.indexOf(m[1]);
  if (pc < 0) return name;
  return NOTE_NAMES[((pc + state.transpose) % 12 + 12) % 12] + m[2];
}

export function parseChordName(name) {
  var m = String(name || "").trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)(.*)$/);
  if (!m) return null;
  var pc = NOTE_NAMES.indexOf(m[1]);
  var suffix = m[2].split("/")[0].trim();
  const NAME_SUFFIX = {
    "": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6], "°": [0, 3, 6], "sus4": [0, 5, 7], "sus2": [0, 2, 7],
    "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11], "m7b5": [0, 3, 6, 10], "dim7": [0, 3, 6, 9], "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "aug": [0, 4, 8]
  };
  var ivs = NAME_SUFFIX[suffix];
  if (!ivs) ivs = suffix.indexOf("m") === 0 ? NAME_SUFFIX.m : NAME_SUFFIX[""];
  // Bas iz slash oznake (npr. "C/G") je potreban voicing motoru za levu ruku;
  // stari pozivaoci koriste samo pc/ivs i ne primećuju ovo polje.
  var slash = String(name || "").trim().split("/")[1];
  var bassPc = null;
  if (slash) {
    var bassMatch = slash.trim().match(/^(Cis|Dis|Fis|Gis|C|D|E|F|G|A|B|H)/);
    if (bassMatch) bassPc = NOTE_NAMES.indexOf(bassMatch[1]);
  }
  return { pc: pc, ivs: ivs, bassPc: bassPc };
}

export function paintChordName(name, weak) {
  var parsed = parseChordName(name);
  if (!parsed) return;
  paintScale(parsed.pc, parsed.ivs, (weak ? "prati pesmu: " : "") + name, {
    autoClear: true,
    holdMs: weak ? 900 : 1200
  });
}
