import { state, NOTE_NAMES, clamp, readJsonStorage, writeJsonStorage, KEYBOARD_SETTINGS_STORAGE_KEY, KEYBOARD_DOUBLE_TAP_SHARP_KEYS } from "./state.js";
import { ensureAudio, setActiveMidiSet, noteToMidi, pitchFromMidi, octaveFromMidi, recomputeSound } from "./audio.js";

// Konstante za mapiranje
export const KEYBOARD_MAP = new Map([
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
    "Slash", "Quote", "BracketRight", "Period", "Semicolon", "BracketLeft", "Comma", "KeyL", "KeyP", "KeyM", "KeyK", "KeyO",
    "KeyN", "KeyJ", "KeyI", "KeyB", "KeyH", "KeyU", "KeyV", "KeyG", "KeyY", "KeyC", "KeyF", "KeyT", "KeyX", "KeyR", "KeyZ",
    "KeyS", "KeyE", "KeyA", "KeyW", "KeyQ"
  ],
  "4": [
    "Slash", "Quote", "BracketRight", "Period", "Semicolon", "BracketLeft", "Equal", "Comma", "KeyL", "KeyP", "Minus",
    "KeyM", "KeyK", "KeyO", "Digit0", "KeyN", "KeyJ", "KeyI", "Digit9", "KeyB", "KeyH", "KeyU", "Digit8", "KeyV",
    "KeyG", "KeyY", "Digit7", "KeyC", "KeyF", "KeyT", "Digit6", "KeyX", "KeyD", "KeyR", "Digit5", "KeyZ", "KeyS",
    "KeyE", "Digit4", "KeyA", "KeyW", "Digit3"
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
const LOWEST_MIDI = 31; // noteToMidi(7, 1)
const HIGHEST_MIDI = 107; // noteToMidi(11, 7)

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

export function isMinorModifierActive() {
  return state.keyboardMinorKeys.size > 0;
}

export function isKeyboardLowerOctaveActive(rootKey = null) {
  return (
    state.keyboardLowerOctaves.size > 0 ||
    state.keyboardLowerOctaveLatched ||
    (rootKey !== null && state.keyboardLowerOctaveMemoryKeys.has(rootKey))
  );
}

function hasHeldChordRoot() {
  return state.heldBaseKeys.size > 0 || state.heldMouseChordRoots.size > 0;
}

function getKeyboardRootMemoryKey(pitch) {
  return getRootMemoryKeyFromMidi(noteToMidi(pitch, state.baseOctave) + getKeyboardPitchOffset());
}

function getRootMemoryKeyFromMidi(midi) {
  return ((midi % 12) + 12) % 12;
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

export function getKeyboardChord(options = {}) {
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

export function getMouseChord() {
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

export function getMobileChord() {
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
  const invLabel = getInversionLabel(shape.inversionStep);
  const closeLabel = state.closeVoicingEnabled ? " bliski" : "";
  const notes = shape.midis.map(noteLabel).join(" ");

  return {
    midis: shape.midis,
    description: `${rootName} ${qualityLabel}${closeLabel} (${invLabel}) - ${notes}`
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
      if (((intervals[index] % 12) + 12) % 12 === 0) {
        intervals.splice(index, 1);
      }
    }
  }

  if (color.raiseRoot) {
    const rootIndex = intervals.findIndex((interval) => ((interval % 12) + 12) % 12 === 0);
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
    return { octaveShift: step / 3, step, type: "root" };
  }
  if (normalized === 1) {
    return { octaveShift: Math.floor(step / 3), step, type: "right" };
  }
  return { octaveShift: Math.floor((step + 1) / 3), step, type: "left" };
}

function getInversionLabel(inversion) {
  const info = getInversionInfo(inversion);
  const base = info.type === "left" ? "donji" : info.type === "right" ? "gornji" : "normalan";
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
  if (inversion === "left") return -1;
  if (inversion === "right") return 1;
  return 0;
}

function getChordQualityLabel(quality, color) {
  const suffix = color.raiseRoot ? " +root" : "";

  if (color.dim) {
    if (color.nine) return `${color.maj ? "dim maj9" : "dim9"}${suffix}`;
    if (color.maj) return `dim maj7${suffix}`;
    return `${color.seven ? "dim7" : "dim"}${suffix}`;
  }

  if (color.sus) {
    if (color.nine) return `${color.maj ? "sus maj9" : "sus9"}${suffix}`;
    if (color.maj) return `sus maj7${suffix}`;
    return `${color.seven ? "sus7" : "sus"}${suffix}`;
  }

  const base = quality === "minor" ? "mol" : "dur";
  if (color.nine) return `${color.maj ? `${base} maj9` : `${base}9`}${suffix}`;
  if (color.maj) return `${base} maj7${suffix}`;
  if (color.seven) return `${base}7${suffix}`;
  return `${base}${suffix}`;
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

function latchLowerOctaveForCurrentChord(code) {
  if (KEYBOARD_LOWER_OCTAVE_LATCH_KEYS.has(code) && hasHeldChordRoot()) {
    state.keyboardLowerOctaveLatched = true;
    rememberLowerOctaveForActiveChordRoots();
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

function latchChordColorForCurrentChord(chordColor) {
  if (KEYBOARD_CHORD_COLOR_LATCHES.has(chordColor) && hasHeldChordRoot()) {
    state.keyboardChordColorLatched[chordColor] = true;
  }
}

function clearLatchedChordColorsIfNoChordRoot() {
  if (state.heldBaseKeys.size || state.heldMouseChordRoots.size) {
    return;
  }
  state.keyboardChordColorLatched.seven = false;
  state.keyboardChordColorLatched.nine = false;
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

export function clearKeyboardReleaseGuard() {
  if (state.keyboardReleaseGuardTimer) {
    window.clearTimeout(state.keyboardReleaseGuardTimer);
    state.keyboardReleaseGuardTimer = null;
  }
  state.keyboardFrozenChord = null;
}

export function clearKeyboardChordSettleTimer() {
  if (state.keyboardChordSettleTimer) {
    window.clearTimeout(state.keyboardChordSettleTimer);
    state.keyboardChordSettleTimer = null;
  }
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

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function noteLabel(midi) {
  return `${NOTE_NAMES[pitchFromMidi(midi)]}${octaveFromMidi(midi)}`;
}

// ---------------- DOGADJAJI TASTATURE & KOORDINACIJA ZVUKA ----------------

export function isPhysicalPianoModeActive() {
  return state.pianoKeyboardEnabled && state.desktopMouseMode === "tone";
}

function getDugmetaraKeyboardMidi(code) {
  const index = DUGMETARA_KEYBOARD_MAPS[state.dugmetaraRows]?.get(code) ?? DUGMETARA_KEYBOARD_MAPS["4"].get(code);
  if (index === undefined) {
    return null;
  }
  return noteToMidi(0, state.baseOctave - 2) + index;
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
  clearLatchedChordColorsIfNoChordRoot();
}

function rememberKeyboardBaseKeyRelease(code) {
  const keyState = state.heldBaseKeys.get(code) || state.pendingBaseKeyTaps.get(code);
  if (!keyState) {
    return;
  }

  state.lastBaseKeyTap = {
    code,
    time: performance.now()
  };
}

function setKeyboardBaseKey(code, pitch, order) {
  state.heldBaseKeys.set(code, { pitch, order });
}

function schedulePendingBaseKeyTap(code, pitch, order) {
  cancelPendingBaseKeyTap(code);

  const timerId = window.setTimeout(() => {
    const pending = state.pendingBaseKeyTaps.get(code);
    state.pendingBaseKeyTaps.delete(code);
    setKeyboardBaseKey(code, pitch, order);
    recomputeSound();
    if (pending && pending.released) {
      state.heldBaseKeys.delete(code);
      recomputeSound();
    }
  }, state.doubleTapSharpMs);

  state.pendingBaseKeyTaps.set(code, {
    pitch,
    order,
    timerId,
    released: false
  });
}

function cancelPendingBaseKeyTap(code) {
  const pending = state.pendingBaseKeyTaps.get(code);
  if (pending) {
    window.clearTimeout(pending.timerId);
    state.pendingBaseKeyTaps.delete(code);
  }
}

function clearPendingBaseKeyTaps() {
  state.pendingBaseKeyTaps.forEach((pending) => window.clearTimeout(pending.timerId));
  state.pendingBaseKeyTaps.clear();
}

function flushPendingBaseKeyTapsExcept(activeCode) {
  state.pendingBaseKeyTaps.forEach((pending, code) => {
    if (code === activeCode) {
      return;
    }
    window.clearTimeout(pending.timerId);
    state.pendingBaseKeyTaps.delete(code);
    setKeyboardBaseKey(code, pending.pitch, pending.order);
    if (pending.released) {
      state.heldBaseKeys.delete(code);
    }
  });
}

// ---------------- POZIVI IZ UI-CONTROLLERA ----------------

export function handleKeyDown(event) {
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

      ensureAudio();
      state.heldKeyboardTones.set(event.code, midi);
      recomputeSound();
    }
    return;
  }

  // Prečice za YouTube su izolovane u ui-controlleru kako se ne bi gomilao YouTube kod u unose
  if (["Backquote", "Digit1", "Digit2"].includes(event.code)) {
    return; // Propagiramo dalje ui-controlleru
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

  ensureAudio();

  if (isMappedBase) {
    pressKeyboardBaseKey(event.code);
  } else if (isMinor) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true; // requestChordRetrigger() in app.js
    state.inputOrder += 1;
    state.keyboardMinorKeys.set(event.code, state.inputOrder);
  } else if (inversion) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    state.keyboardInversions[inversion].set(event.code, state.inputOrder);
    rememberInversionForActiveChordRoots(inversionTypeToStep(inversion));
  } else if (hasInversionStep) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    stepInversionForActiveChordRoots(inversionStep);
  } else if (lowerOctave) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    state.keyboardLowerOctaves.set(event.code, state.inputOrder);
    latchLowerOctaveForCurrentChord(event.code);
  } else if (upperOctaveMemoryReset) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    clearLowerOctaveMemory();
  } else if (pitchOffset) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    state.keyboardPitchOffsets[pitchOffset].set(event.code, state.inputOrder);
  } else if (chordColor) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
    state.inputOrder += 1;
    state.keyboardChordColors[chordColor].set(event.code, state.inputOrder);
    latchChordColorForCurrentChord(chordColor);
  } else if (voiceModifier) {
    clearKeyboardReleaseGuard();
    state.retriggerChordRequested = true;
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

export function handleKeyUp(event) {
  if (!shouldHandleKeyboardEvent(event)) {
    return;
  }

  const physicalPianoActive = isPhysicalPianoModeActive();

  if (physicalPianoActive) {
    if (DUGMETARA_KEYBOARD_MAPS[state.dugmetaraRows]?.has(event.code) || DUGMETARA_KEYBOARD_MAPS["4"].has(event.code)) {
      event.preventDefault();
      state.heldKeyboardTones.delete(event.code);
      recomputeSound();
    }
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

export function handleMobileModifierDown(event) {
  const button = event.currentTarget;
  const modifier = button.dataset.mobileModifier;

  state.inputOrder += 1;
  ensureAudio();

  if (modifier === "minor") {
    state.mobileMinorPointers.add(event.pointerId);
  } else if (modifier === "left" || modifier === "right") {
    state.mobileArrowPointers[modifier].set(event.pointerId, state.inputOrder);
  }

  clearKeyboardChordSettleTimer();
  recomputeSound();
}

export function handleMobileModifierUp(event) {
  const button = event.currentTarget;
  const modifier = button.dataset.mobileModifier;

  if (modifier === "minor") {
    state.mobileMinorPointers.delete(event.pointerId);
  } else if (modifier === "left" || modifier === "right") {
    state.mobileArrowPointers[modifier].delete(event.pointerId);
  }

  recomputeSound();
}

export function clearAllHeldState() {
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
  
  state.heldMobileChordRoots.clear();
  state.mobileMinorPointers.clear();
  state.mobileArrowPointers.left.clear();
  state.mobileArrowPointers.right.clear();
  
  setActiveMidiSet(new Set()); // stop sounding notes
  recomputeSound();
}

export function resetChordMemory() {
  state.keyboardLowerOctaveMemoryKeys.clear();
  state.keyboardInversionMemory.clear();
  state.keyboardLowerOctaveLatched = false;
  state.closeVoicingReferenceMidis = null;
  clearKeyboardReleaseGuard();
  clearKeyboardChordSettleTimer();
  if (state.heldBaseKeys.size || state.heldMouseChordRoots.size) {
    state.retriggerChordRequested = true;
  }
  recomputeSound();
}

function scheduleKeyboardChordRecompute() {
  clearKeyboardChordSettleTimer();
  state.keyboardChordSettleTimer = window.setTimeout(() => {
    state.keyboardChordSettleTimer = null;
    recomputeSound();
  }, KEYBOARD_CHORD_SETTLE_MS);
}
