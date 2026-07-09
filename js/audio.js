import { state, NOTE_NAMES, clamp } from "./state.js";
import { getKeyboardChord, getMouseChord, getMobileChord } from "./keyboard.js";

// Semplovi i preseti instrumenata
const PIANO_SAMPLE_BASE_PATH = "samples/piano/";
const PIANO_SAMPLE_DEFS = [
  { name: "A", pitch: 9, firstOctave: 0, lastOctave: 7 },
  { name: "C", pitch: 0, firstOctave: 1, lastOctave: 8 },
  { name: "D#", pitch: 3, firstOctave: 1, lastOctave: 7 },
  { name: "F#", pitch: 6, firstOctave: 1, lastOctave: 7 }
];

export const PIANO_SAMPLES = PIANO_SAMPLE_DEFS.flatMap((definition) => {
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

// Pomocne audio funkcije
export function noteToMidi(pitch, octave) {
  return (octave + 1) * 12 + pitch;
}

export function pitchFromMidi(midi) {
  return ((midi % 12) + 12) % 12;
}

export function octaveFromMidi(midi) {
  return Math.floor(midi / 12) - 1;
}

export function frequencyFromMidi(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function ensureAudio(options = {}) {
  const shouldResume = options.resume !== false;

  if (!state.audioContext) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      console.error("Web Audio API is not supported in this browser");
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

export function loadPianoSamples() {
  const ctx = state.audioContext;
  if (!ctx || state.sampleLoadingPromise) {
    return state.sampleLoadingPromise;
  }

  state.sampleLoadingPromise = Promise.all(
    PIANO_SAMPLES.map(async (sample) => {
      const url = `${PIANO_SAMPLE_BASE_PATH}${encodeURIComponent(sample.file)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Sample failed to load: ${sample.file}`);
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
    .catch((err) => {
      console.error("Failed to load piano samples, falling back to synth", err);
      state.samplesFailed = true;
    });

  return state.sampleLoadingPromise;
}

export function startNote(midi) {
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
  const fileUrl = `${PIANO_SAMPLE_BASE_PATH}${encodeURIComponent(sample.file)}`;
  const audio = new Audio(fileUrl);
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
  audio.preservesPitch = false;
  audio.mozPreservesPitch = false;
  audio.webkitPreservesPitch = false;
  audio.playbackRate = 2 ** ((midi - sample.midi) / 12);
  audio.volume = clamp(state.volume * 0.92, 0, 1);
  audio.addEventListener("error", useFallback, { once: true });
  state.activeNotes.set(midi, note);

  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(useFallback);
  }
}

function shouldUseMediaPianoSamples() {
  return window.location.protocol === "file:" || state.samplesFailed;
}

export function updateMediaSampleVolumes() {
  const volume = clamp(state.volume * 0.92, 0, 1);
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
    const decayEnd = now + env.decay;

    oscillator.type = partial.type;
    oscillator.frequency.setValueAtTime(frequency * partial.multiple, now);
    if (lfoGain) {
      lfoGain.connect(oscillator.frequency);
    }
    oscillator.detune.setValueAtTime(partial.detune, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(partial.level, attackEnd);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, partial.level * env.sustain), decayEnd);

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

export function stopNote(midi) {
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
      // BufferSource moze biti zaustavljen samo jednom
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

export function setActiveMidiSet(desired, restartMidis = new Set()) {
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

export function releaseSustainedNotes() {
  state.sustainedMidiSet.forEach((midi) => {
    if (!state.activeMidiSet.has(midi)) {
      stopNote(midi);
    }
    clearSustainTimer(midi);
    clearInfiniteSustainLoop(midi);
  });
  state.sustainedMidiSet.clear();
}

export function rescheduleSustainedNotes() {
  state.sustainedMidiSet.forEach((midi) => {
    scheduleSustainRelease(midi);
  });
}

export function stopAllSoundingNotes() {
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
  return false;
}

export function recomputeSound() {
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
  
  // Azuriranje aktivnog teksta i obavestavanje
  const activeChordDisplay = document.getElementById("activeChordDisplay");
  if (activeChordDisplay) {
    activeChordDisplay.value = state.activeChordText;
    activeChordDisplay.textContent = state.activeChordText;
  }
  
  dispatchPlayChange();
}

function dispatchPlayChange() {
  const midis = [...state.activeMidiSet];
  const pcs = [...new Set(midis.map((midi) => pitchFromMidi(midi)))];
  window.dispatchEvent(new CustomEvent("fgr:playchange", {
    detail: { midis, pcs }
  }));
}

// ---------------- PITCH SHIFTER (JUNGLE) ----------------
export function createPitchShifter(context, pitchOffset, delayTime = 0.045) {
  const input = context.createGain();
  const output = context.createGain();

  if (Math.abs(pitchOffset) < 0.05) {
    input.connect(output);
    return { 
      input, 
      output, 
      disconnect() { 
        input.disconnect(); 
        output.disconnect(); 
      } 
    };
  }

  const pitchRatio = Math.pow(2, pitchOffset / 12);
  const delayWindow = clamp(Number(delayTime) || 0.045, 0.02, 0.12);
  
  const delay1 = context.createDelay(1.0);
  const delay2 = context.createDelay(1.0);

  const gain1 = context.createGain();
  const gain2 = context.createGain();

  input.connect(delay1);
  input.connect(delay2);

  delay1.connect(gain1);
  delay2.connect(gain2);

  gain1.connect(output);
  gain2.connect(output);

  // Modulation buffer containing ramps and crossfading windows
  const sampleRate = context.sampleRate;
  const bufferLen = 2.0;
  const size = sampleRate * bufferLen;
  const modBuffer = context.createBuffer(4, size, sampleRate);
  
  const ramp1 = modBuffer.getChannelData(0);
  const ramp2 = modBuffer.getChannelData(1);
  const win1 = modBuffer.getChannelData(2);
  const win2 = modBuffer.getChannelData(3);

  for (let i = 0; i < size; i++) {
    const x = i / size;
    ramp1[i] = x;
    ramp2[i] = (x + 0.5) % 1.0;
    
    // Smooth Hanning windowing to reduce vocoder-like artifacts
    win1[i] = 0.5 * (1 - Math.cos(2 * Math.PI * x));
    win2[i] = 0.5 * (1 - Math.cos(2 * Math.PI * ((x + 0.5) % 1.0)));
  }

  const modSource = context.createBufferSource();
  modSource.buffer = modBuffer;
  modSource.loop = true;

  const delayRate = 1 - pitchRatio;
  const freq = Math.abs(delayRate) / delayWindow;
  modSource.playbackRate.value = freq * bufferLen;

  const splitter = context.createChannelSplitter(4);
  modSource.connect(splitter);

  const rampScale1 = context.createGain();
  const rampScale2 = context.createGain();

  if (delayRate < 0) {
    // Pitch up: downward ramp
    rampScale1.gain.value = -delayWindow;
    rampScale2.gain.value = -delayWindow;
    delay1.delayTime.value = delayWindow;
    delay2.delayTime.value = delayWindow;
  } else {
    // Pitch down: upward ramp
    rampScale1.gain.value = delayWindow;
    rampScale2.gain.value = delayWindow;
    delay1.delayTime.value = 0;
    delay2.delayTime.value = 0;
  }

  splitter.connect(rampScale1, 0);
  rampScale1.connect(delay1.delayTime);

  splitter.connect(rampScale2, 1);
  rampScale2.connect(delay2.delayTime);

  splitter.connect(gain1.gain, 2);
  splitter.connect(gain2.gain, 3);

  modSource.start();

  return {
    input,
    output,
    disconnect() {
      try { modSource.stop(); } catch (e) {}
      input.disconnect();
      delay1.disconnect();
      delay2.disconnect();
      gain1.disconnect();
      gain2.disconnect();
      rampScale1.disconnect();
      rampScale2.disconnect();
      output.disconnect();
    }
  };
}

// ---------------- NAS SNIMAK (reproduktor) ----------------
export const rec = {
  ctx: null,
  buffer: null,
  bufferId: null,
  source: null,
  pitchShifter: null,
  gains: {
    bass: null,
    mid: null,
    guitar: null,
    vocals: null,
    high: null
  },
  playing: false,
  offset: 0,
  startedAt: 0,
  hasStems: false,
  stems: null,
  sources: [],
  pitchShifters: [],
  melodyAnalyser: null,
  melodyData: null,
  melodySourceName: ""
};

export function recRate() {
  return state.playbackRate;
}

export function recTime() {
  if (!rec.playing) return rec.offset;
  return rec.offset + (rec.ctx.currentTime - rec.startedAt) * recRate();
}

export function recStop(keepOffset) {
  if (rec.sources && rec.sources.length) {
    rec.sources.forEach((source) => {
      source.onended = null;
      try { source.stop(); } catch (e) {}
    });
    rec.sources = [];
  }
  if (rec.source) {
    rec.source.onended = null;
    try { rec.source.stop(); } catch (e) {}
    rec.source = null;
  }
  if (rec.pitchShifters && rec.pitchShifters.length) {
    rec.pitchShifters.forEach((shifter) => {
      try { shifter.disconnect(); } catch (e) {}
    });
    rec.pitchShifters = [];
  }
  if (rec.pitchShifter) {
    try { rec.pitchShifter.disconnect(); } catch (e) {}
    rec.pitchShifter = null;
  }
  resetMelodyAnalyser();
  if (rec.gains.bass) {
    try {
      rec.gains.bass.disconnect();
      rec.gains.mid.disconnect();
      if (rec.gains.guitar) rec.gains.guitar.disconnect();
      if (rec.gains.vocals) rec.gains.vocals.disconnect();
      rec.gains.high.disconnect();
    } catch (e) {}
    rec.gains.bass = null;
    rec.gains.mid = null;
    rec.gains.guitar = null;
    rec.gains.vocals = null;
    rec.gains.high = null;
  }
  if (rec.playing && keepOffset) {
    rec.offset = Math.min(recTime(), rec.buffer ? rec.buffer.duration : 0);
  }
  if (!keepOffset) rec.offset = 0;
  rec.playing = false;
  window.dispatchEvent(new CustomEvent("fgr:recupdate"));
}

export function updateMixerGains() {
  if (!rec.gains.bass || !rec.gains.mid || !rec.gains.guitar || !rec.gains.high) {
    return;
  }

  const { bass, mid, guitar, vocals, high } = state.mixer;
  const guitarState = guitar || { volume: 1.0, mute: false, solo: false };
  const vocalsState = vocals || { volume: 1.0, mute: false, solo: false };
  const isAnySolo = bass.solo || mid.solo || guitarState.solo || vocalsState.solo || high.solo;

  const calculateGain = (channelState) => {
    if (isAnySolo) {
      return channelState.solo ? (channelState.mute ? 0 : channelState.volume) : 0;
    }
    return channelState.mute ? 0 : channelState.volume;
  };

  const now = rec.ctx ? rec.ctx.currentTime : 0;
  rec.gains.bass.gain.setTargetAtTime(calculateGain(bass), now, 0.015);
  rec.gains.mid.gain.setTargetAtTime(calculateGain(mid), now, 0.015);
  rec.gains.guitar.gain.setTargetAtTime(calculateGain(guitarState), now, 0.015);
  if (rec.gains.vocals) {
    rec.gains.vocals.gain.setTargetAtTime(calculateGain(vocalsState), now, 0.015);
  }
  rec.gains.high.gain.setTargetAtTime(calculateGain(high), now, 0.015);
}

function resetMelodyAnalyser() {
  if (rec.melodyAnalyser) {
    try { rec.melodyAnalyser.disconnect(); } catch (e) {}
  }
  rec.melodyAnalyser = null;
  rec.melodyData = null;
  rec.melodySourceName = "";
  state.activePitchAnalyser = null;
}

function attachMelodyAnalyser(sourceNode, sourceName) {
  if (!state.trackMelody || !sourceNode || !rec.ctx) return;
  if (sourceName !== "mix" && state.melodyTrackSource !== sourceName) return;

  resetMelodyAnalyser();
  const analyser = rec.ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.08;
  sourceNode.connect(analyser);

  rec.melodyAnalyser = analyser;
  rec.melodyData = new Float32Array(analyser.fftSize);
  rec.melodySourceName = sourceName;
  state.activePitchAnalyser = analyser;
}

export function getMelodyPitch() {
  if (!rec.melodyAnalyser || !rec.melodyData) return null;
  rec.melodyAnalyser.getFloatTimeDomainData(rec.melodyData);
  return autoCorrelatePitch(rec.melodyData, rec.ctx.sampleRate);
}

function autoCorrelatePitch(samples, sampleRate) {
  let rms = 0;
  for (let i = 0; i < samples.length; i += 1) {
    rms += samples[i] * samples[i];
  }
  rms = Math.sqrt(rms / samples.length);
  if (rms < 0.015) return null;

  let start = 0;
  let end = samples.length - 1;
  const trimThreshold = 0.2;
  for (let i = 0; i < samples.length / 2; i += 1) {
    if (Math.abs(samples[i]) < trimThreshold) start = i;
    else break;
  }
  for (let i = 1; i < samples.length / 2; i += 1) {
    if (Math.abs(samples[samples.length - i]) < trimThreshold) end = samples.length - i;
    else break;
  }

  const size = end - start;
  if (size < 64) return null;

  const correlations = new Array(size).fill(0);
  for (let lag = 0; lag < size; lag += 1) {
    for (let i = 0; i < size - lag; i += 1) {
      correlations[lag] += samples[start + i] * samples[start + i + lag];
    }
  }

  let lag = 1;
  while (lag < size - 1 && correlations[lag] > correlations[lag + 1]) {
    lag += 1;
  }

  let bestLag = -1;
  let bestCorrelation = -Infinity;
  for (; lag < size; lag += 1) {
    if (correlations[lag] > bestCorrelation) {
      bestCorrelation = correlations[lag];
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return null;
  const frequency = sampleRate / bestLag;
  return frequency >= 65 && frequency <= 1200 ? frequency : null;
}

function getReferenceStemBuffer() {
  if (!rec.stems) return null;
  const buffers = Object.values(rec.stems).filter(Boolean);
  if (!buffers.length) return null;
  return buffers.reduce((best, buffer) => (!best || buffer.duration > best.duration ? buffer : best), null);
}

export function recPlayFrom(offset) {
  if (!rec.buffer) return;
  recStop(false);
  rec.offset = Math.max(0, Math.min(offset, Math.max(0, rec.buffer.duration - 0.1)));
  
  const speedSemitones = 12 * Math.log2(state.playbackRate);
  const shiftSemitones = state.transpose - speedSemitones;

  // Initialize gain nodes
  rec.gains.bass = rec.ctx.createGain();
  rec.gains.mid = rec.ctx.createGain();
  rec.gains.guitar = rec.ctx.createGain();
  rec.gains.vocals = rec.ctx.createGain();
  rec.gains.high = rec.ctx.createGain();

  const dest = state.masterGain || rec.ctx.destination;
  rec.gains.bass.connect(dest);
  rec.gains.mid.connect(dest);
  rec.gains.guitar.connect(dest);
  rec.gains.vocals.connect(dest);
  rec.gains.high.connect(dest);

  rec.sources = [];
  rec.pitchShifters = [];

  if (rec.hasStems && rec.stems) {
    const stemsToLoad = [
      { name: "bass", destNode: rec.gains.bass, pitchShift: true, delayTime: 0.06 },
      { name: "guitar", destNode: rec.gains.guitar, pitchShift: true, delayTime: 0.05 },
      { name: "piano", destNode: rec.gains.mid, pitchShift: true, delayTime: 0.05 },
      { name: "other", destNode: rec.gains.mid, pitchShift: true, delayTime: 0.05 },
      { name: "vocals", destNode: rec.gains.vocals, pitchShift: true, delayTime: 0.035 },
      { name: "drums", destNode: rec.gains.high, pitchShift: false, delayTime: 0.05 }
    ];

    stemsToLoad.forEach((stemInfo) => {
      const buf = rec.stems[stemInfo.name];
      if (!buf) return;

      const source = rec.ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = state.playbackRate;
      rec.sources.push(source);

      let lastNode = source;

      if (stemInfo.pitchShift) {
        const shifter = createPitchShifter(rec.ctx, shiftSemitones, stemInfo.delayTime);
        rec.pitchShifters.push(shifter);
        lastNode.connect(shifter.input);
        lastNode = shifter.output;
      }

      attachMelodyAnalyser(lastNode, stemInfo.name);
      lastNode.connect(stemInfo.destNode);
    });

    if (!rec.sources.length) return;

    const playTime = rec.ctx.currentTime;
    rec.sources.forEach((source) => {
      source.start(playTime, rec.offset);
    });

    const mainSource = rec.sources.find((source) => source.buffer === rec.stems.other) || rec.sources.find((source) => source.buffer === rec.stems.piano) || rec.sources[0];
    if (mainSource) {
      mainSource.onended = function () {
        if (rec.playing) recStop(false);
        window.dispatchEvent(new CustomEvent("fgr:recupdate"));
      };
    }
  } else {
    rec.source = rec.ctx.createBufferSource();
    rec.source.buffer = rec.buffer;
    rec.source.playbackRate.value = state.playbackRate;

    rec.pitchShifter = createPitchShifter(rec.ctx, shiftSemitones, 0.05);

    const bassFilter1 = rec.ctx.createBiquadFilter();
    bassFilter1.type = "lowpass";
    bassFilter1.frequency.value = 220;
    const bassFilter2 = rec.ctx.createBiquadFilter();
    bassFilter2.type = "lowpass";
    bassFilter2.frequency.value = 220;
    const bassFilter3 = rec.ctx.createBiquadFilter();
    bassFilter3.type = "lowpass";
    bassFilter3.frequency.value = 220;

    const midHP1 = rec.ctx.createBiquadFilter();
    midHP1.type = "highpass";
    midHP1.frequency.value = 220;
    const midHP2 = rec.ctx.createBiquadFilter();
    midHP2.type = "highpass";
    midHP2.frequency.value = 220;

    const midLP1 = rec.ctx.createBiquadFilter();
    midLP1.type = "lowpass";
    midLP1.frequency.value = 3300;
    const midLP2 = rec.ctx.createBiquadFilter();
    midLP2.type = "lowpass";
    midLP2.frequency.value = 3300;

    const highFilter1 = rec.ctx.createBiquadFilter();
    highFilter1.type = "highpass";
    highFilter1.frequency.value = 3300;
    const highFilter2 = rec.ctx.createBiquadFilter();
    highFilter2.type = "highpass";
    highFilter2.frequency.value = 3300;
    const highFilter3 = rec.ctx.createBiquadFilter();
    highFilter3.type = "highpass";
    highFilter3.frequency.value = 3300;

    rec.source.connect(rec.pitchShifter.input);
    rec.pitchShifter.output.connect(bassFilter1);
    rec.pitchShifter.output.connect(midHP1);
    rec.pitchShifter.output.connect(highFilter1);
    attachMelodyAnalyser(rec.pitchShifter.output, "mix");

    bassFilter1.connect(bassFilter2);
    bassFilter2.connect(bassFilter3);
    bassFilter3.connect(rec.gains.bass);

    midHP1.connect(midHP2);
    midHP2.connect(midLP1);
    midLP1.connect(midLP2);
    midLP2.connect(rec.gains.mid);

    highFilter1.connect(highFilter2);
    highFilter2.connect(highFilter3);
    highFilter3.connect(rec.gains.high);

    rec.source.onended = function () {
      if (rec.playing) recStop(false);
      window.dispatchEvent(new CustomEvent("fgr:recupdate"));
    };

    rec.source.start(0, rec.offset);
  }

  updateMixerGains();
  rec.startedAt = rec.ctx.currentTime;
  rec.playing = true;
  window.dispatchEvent(new CustomEvent("fgr:recupdate"));
}

// IndexedDB integrisano lokalno u audio
const DB_NAME = "fgr-capture";
const DB_STORE = "songs";

export function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function (e) {
      if (!e.target.result.objectStoreNames.contains(DB_STORE)) {
        e.target.result.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

export function dbPut(item) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(item);
      tx.oncomplete = resolve; tx.onerror = function (e) { reject(e.target.error); };
    });
  });
}

export function dbGet(id) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  });
}

export function dbDelete(id) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = resolve; tx.onerror = function (e) { reject(e.target.error); };
    });
  });
}

export function dbGetAll() {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const out = [];
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const req = store.openCursor();
      req.onsuccess = function (e) {
        const cursor = e.target.result;
        if (cursor) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = function (e) { reject(e.target.error); };
    });
  });
}

export function recId() {
  const song = getSelectedSong();
  return song ? "song-" + song.id : null;
}

function getSelectedSong() {
  return state.repertoire.find((song) => song.id === state.selectedSongId) || null;
}

export function recLoad() {
  const song = getSelectedSong();
  if (!song) return Promise.resolve(false);
  const id = "song-" + song.id;
  if (rec.buffer && rec.bufferId === id) return Promise.resolve(true);

  const ctx = ensureAudio();
  rec.ctx = ctx;

  if (song.stems) {
    rec.hasStems = true;
    rec.stems = {};
    const stemNames = ["bass", "drums", "guitar", "piano", "vocals", "other"];
    const requiredStems = new Set(["bass", "drums", "vocals", "other"]);
    const promises = stemNames.map((name) => {
      const url = `samples/${song.id}/${name}.mp3`;
      return fetch(url)
        .then((r) => {
          if (!r.ok) {
            if (requiredStems.has(name)) throw new Error(`Failed to fetch stem: ${name}`);
            return null;
          }
          return r.arrayBuffer();
        })
        .then((data) => data ? ctx.decodeAudioData(data) : null)
        .then((buffer) => {
          if (buffer) rec.stems[name] = buffer;
        });
    });

    return Promise.all(promises)
      .then(() => {
        rec.buffer = getReferenceStemBuffer();
        if (!rec.buffer) throw new Error("No playable stems loaded");
        rec.bufferId = id;
        return true;
      })
      .catch((err) => {
        console.error("Error loading stems:", err);
        rec.hasStems = false;
        rec.stems = null;
        return loadLegacyRecording(id);
      });
  } else {
    rec.hasStems = false;
    rec.stems = null;
    return loadLegacyRecording(id);
  }
}

function loadLegacyRecording(id) {
  return dbGet(id).then(function (item) {
    if (!item) return false;
    return item.blob.arrayBuffer().then(function (data) {
      return rec.ctx.decodeAudioData(data);
    }).then(function (buffer) {
      rec.buffer = buffer;
      rec.bufferId = id;
      return true;
    });
  });
}

export function recRetune() {
  if (rec.playing) {
    const t = recTime();
    recPlayFrom(t);
  }
  window.dispatchEvent(new CustomEvent("fgr:recupdate"));
}

export function recSeek(t) {
  recLoad().then(function (ok) {
    if (!ok) return;
    if (rec.playing) recPlayFrom(t);
    else {
      rec.offset = t;
      window.dispatchEvent(new CustomEvent("fgr:recupdate"));
    }
  });
}

// ---------------- OFFLINE CHORD ANALYSIS DSP ----------------
const AN_TEMPLATES = [
  ["", [0, 4, 7]], 
  ["m", [0, 3, 7]], 
  ["7", [0, 4, 7, 10]], 
  ["m7", [0, 3, 7, 10]],
  ["maj7", [0, 4, 7, 11]],
  ["dim", [0, 3, 6]],
  ["sus4", [0, 5, 7]]
];
const AN_VECS = [];

AN_TEMPLATES.forEach((tpl) => {
  for (let r = 0; r < 12; r++) {
    const vec = new Array(12).fill(0);
    tpl[1].forEach((iv) => { vec[(r + iv) % 12] = 1; });
    AN_VECS.push({
      name: NOTE_NAMES[r] + tpl[0],
      root: r,
      suffix: tpl[0],
      intervals: tpl[1],
      vec,
      norm: Math.sqrt(tpl[1].length)
    });
  }
});

function chromaFromSpectrum(dbArr, sampleRate, fftSize) {
  const midiBins = new Float32Array(128);
  for (let i = 0; i < dbArr.length; i++) {
    const freq = i * sampleRate / fftSize;
    if (freq < 60 || freq > 2000) continue;
    const mag = Math.pow(10, dbArr[i] / 20);
    if (!isFinite(mag) || mag < 1e-6) continue;
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    if (midi >= 24 && midi < 108) {
      midiBins[midi] += mag;
    }
  }

  // Harmonic overtone subtraction (bottom-up filtering)
  for (let m = 24; m < 96; m++) {
    const val = midiBins[m];
    if (val > 0.005) {
      if (m + 12 < 128) midiBins[m + 12] = Math.max(0, midiBins[m + 12] - val * 0.45);
      if (m + 19 < 128) midiBins[m + 19] = Math.max(0, midiBins[m + 19] - val * 0.3);
      if (m + 24 < 128) midiBins[m + 24] = Math.max(0, midiBins[m + 24] - val * 0.2);
      if (m + 28 < 128) midiBins[m + 28] = Math.max(0, midiBins[m + 28] - val * 0.15);
    }
  }

  const chroma = new Array(12).fill(0);
  for (let m = 24; m < 96; m++) {
    chroma[m % 12] += midiBins[m];
  }
  return chroma;
}

function bestChord(chroma) {
  const max = Math.max(...chroma);
  if (!(max > 1e-4)) return null;
  const norm = chroma.map((v) => v / max);
  const len = Math.sqrt(norm.reduce((s, v) => s + v * v, 0)) || 1;
  let best = null;
  let bestScore = -1;
  const scored = [];

  AN_VECS.forEach((c) => {
    let dot = 0;
    for (let i = 0; i < 12; i++) {
      dot += norm[i] * c.vec[i];
    }
    let score = dot / (len * c.norm);

    const isTriad = c.suffix === "" || c.suffix === "m";
    if (isTriad) {
      score *= 1.22;
    }

    const item = { chord: c, score };
    scored.push(item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  });

  if (!best || bestScore <= 0.74) return null;
  return simplifyExtendedChord(best, scored, norm);
}

function simplifyExtendedChord(best, scored, norm) {
  const suffix = best.chord.suffix;
  if (suffix !== "7" && suffix !== "m7" && suffix !== "maj7") {
    return best.chord.name;
  }

  const triadSuffix = suffix === "m7" ? "m" : "";
  const triad = scored.find((item) => item.chord.root === best.chord.root && item.chord.suffix === triadSuffix);
  if (!triad) return best.chord.name;

  const seventhInterval = suffix === "maj7" ? 11 : 10;
  const seventhStrength = norm[(best.chord.root + seventhInterval) % 12] || 0;
  const triadIsClose = triad.score >= best.score * 0.94;
  if (triadIsClose || seventhStrength < 0.5) {
    return triad.chord.name;
  }

  return best.chord.name;
}

export function analyzeBuffer(buffer, onProgress) {
  const HOP = 0.25;
  const FFT = 8192;
  const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  source.start();
  const frames = [];
  const duration = buffer.duration;
  
  for (let t = HOP; t < duration; t += HOP) {
    ((at) => {
      ctx.suspend(at).then(() => {
        const arr = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(arr);
        frames.push({ t: at, chord: bestChord(chromaFromSpectrum(arr, buffer.sampleRate, FFT)) });
        if (onProgress && frames.length % 40 === 0) onProgress(at / duration);
        ctx.resume();
      });
    })(t);
  }
  
  return ctx.startRendering().then(() => {
    frames.sort((a, b) => a.t - b.t);
    // stabilizacija: akord vazi tek kad traje >= 4 uzastopna okvira (1s)
    const out = [];
    let run = null;
    
    frames.forEach((frame) => {
      if (!frame.chord) return;
      if (run && run.chord === frame.chord) {
        run.count++;
        run.end = frame.t;
        return;
      }
      if (run && run.count >= 4 && (!out.length || out[out.length - 1].n !== run.chord)) {
        out.push({ t: Math.round((run.start - HOP) * 10) / 10, n: run.chord });
      }
      run = { chord: frame.chord, count: 1, start: frame.t, end: frame.t };
    });
    
    if (run && run.count >= 4 && (!out.length || out[out.length - 1].n !== run.chord)) {
      out.push({ t: Math.round((run.start - HOP) * 10) / 10, n: run.chord });
    }
    return out;
  });
}

window.FGRAnalyzeBuffer = analyzeBuffer;

