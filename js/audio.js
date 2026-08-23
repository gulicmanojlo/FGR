import { state, NOTE_NAMES, clamp } from "./state.js";
import { CHANNEL_NAMES, createChannelBuses, scheduleSampleVoice } from "./piano-voice.js?v=174";
import { getKeyboardChord, getMouseChord, getMobileChord } from "./keyboard.js";
import {
  buildChordTimeline,
  centerAnalysisFrameTime,
  detectChordFromChroma,
  parseKeySignature,
  refineChordBoundaries
} from "./chord-analysis.js?v=174";

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

export function startNote(midi, owner = "user") {
  const ctx = ensureAudio();
  if (!ctx) {
    return;
  }
  const existing = state.activeNotes.get(midi);
  if (existing) {
    noteOwners(existing).add(owner);
    return;
  }

  // Every analyzed/guided channel is a fixed teaching-piano voice. Manual
  // instrument and keyboard settings apply only to notes the user plays.
  const guidedPiano = String(owner).startsWith("assist:");
  const instrument = guidedPiano ? "grand-piano" : state.instrument;

  if (instrument === "grand-piano") {
    const sample = findNearestSample(midi);
    const buffer = sample ? state.sampleBuffers.get(sample.midi) : null;
    if (ctx && buffer) {
      startSampleNote(ctx, midi, sample.midi, buffer);
      noteOwners(state.activeNotes.get(midi)).add(owner);
      return;
    }

    if (sample && shouldUseMediaPianoSamples()) {
      startMediaSampleNote(ctx, midi, sample, guidedPiano);
      noteOwners(state.activeNotes.get(midi)).add(owner);
      return;
    }

    if (ctx) {
      startFallbackNote(ctx, midi);
      noteOwners(state.activeNotes.get(midi)).add(owner);
    }
    return;
  }

  if (ctx) {
    startPresetNote(ctx, midi, instrument);
    noteOwners(state.activeNotes.get(midi)).add(owner);
  }
}

function noteOwners(note) {
  if (!note) return new Set();
  if (!(note.owners instanceof Set)) note.owners = new Set();
  return note.owners;
}

function noteHasOwner(note, owner) {
  return Boolean(note && noteOwners(note).has(owner));
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

function startMediaSampleNote(ctx, midi, sample, forcePiano = false) {
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
    const owners = new Set(noteOwners(note));
    state.activeNotes.delete(midi);
    if (ctx && (forcePiano || state.instrument === "grand-piano")) {
      startFallbackNote(ctx, midi);
      state.activeNotes.get(midi).owners = owners;
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

/**
 * Sabirnice vođenih kanala. Melodija, bas i harmonija imaju svoje pojačanje,
 * pa se mogu mešati nezavisno od tonova koje korisnik svira rukom.
 */
function ensureChannelBuses() {
  const ctx = state.audioContext;
  if (!ctx || !state.masterGain) return null;
  if (!state.assistedChannelBuses) {
    state.assistedChannelBuses = createChannelBuses(ctx, state.masterGain);
    state.assistedChannelGains = new Map(CHANNEL_NAMES.map((name) => [name, 1]));
  }
  return state.assistedChannelBuses;
}

export function setAssistedChannelGain(channel, value) {
  const buses = ensureChannelBuses();
  const bus = buses?.get(String(channel));
  if (!bus) return;
  const gain = Math.max(0, Math.min(2, Number(value) || 0));
  state.assistedChannelGains.set(String(channel), gain);
  bus.gain.setTargetAtTime(gain, state.audioContext.currentTime, 0.02);
}

export function getAssistedChannelGain(channel) {
  const value = state.assistedChannelGains?.get(String(channel));
  return Number.isFinite(value) ? value : 1;
}

/**
 * Zakaži jedan vođeni ton na tačno vreme WebAudio sata.
 *
 * Vraća objekat sa `stop(at)`; scheduler ga koristi da poništi zakazano kada
 * korisnik premota ili pauzira.
 */
export function scheduleAssistedNote({ channel, midi, when, until, velocity }) {
  const ctx = ensureAudio({ resume: false });
  if (!ctx) return null;
  const buses = ensureChannelBuses();
  const destination = buses?.get(String(channel)) || state.masterGain;
  if (!destination) return null;

  const note = Math.round(Number(midi));
  if (!Number.isFinite(note) || note < 0 || note > 127) return null;

  const sample = findNearestSample(note);
  const buffer = sample ? state.sampleBuffers.get(sample.midi) : null;
  if (!buffer) {
    // Semplovi još nisu učitani: vođena reprodukcija ćuti umesto da ubaci
    // sintetički glas koji zvuči kao drugi instrument usred fraze.
    loadPianoSamples();
    return null;
  }

  return scheduleSampleVoice(ctx, {
    buffer,
    sampleMidi: sample.midi,
    midi: note,
    when,
    until,
    velocity,
    destination,
    pedal: state.sustainEnabled
  });
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

export function stopNote(midi, owner = "user") {
  const note = state.activeNotes.get(midi);
  if (!note) {
    return;
  }

  if (owner !== null) {
    const owners = noteOwners(note);
    owners.delete(owner);
    if (owners.size) return;
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
  const fallbackNotes = [];
  state.activeNotes.forEach((note, midi) => {
    if (note.kind === "fallback") {
      fallbackNotes.push({ midi, owners: [...noteOwners(note)] });
    }
  });

  fallbackNotes.forEach(({ midi, owners }) => {
    stopNote(midi, null);
    const orderedOwners = (owners.length ? owners : ["user"])
      .sort((first, second) =>
        Number(String(second).startsWith("assist:")) - Number(String(first).startsWith("assist:"))
      );
    orderedOwners.forEach((owner) => startNote(midi, owner));
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
    if (!noteHasOwner(state.activeNotes.get(midi), "user")) {
      startNote(midi, "user");
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

export function stopAllSoundingNotes(options = {}) {
  const preserveAssisted = options.preserveAssisted === true;
  [...state.activeNotes.keys()].forEach((midi) => {
    stopNote(midi, preserveAssisted ? "user" : null);
  });
  state.activeMidiSet.clear();
  if (!preserveAssisted) state.assistedMidiSets.clear();
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
  mixBuffer: null,
  bufferId: null,
  source: null,
  pitchShifter: null,
  gains: {
    bass: null,
    drums: null,
    guitar: null,
    piano: null,
    vocals: null,
    other: null
  },
  playing: false,
  offset: 0,
  startedAt: 0,
  hasStems: false,
  stems: null,
  sources: [],
  pitchShifters: [],
  compensationNodes: [],
  outputLatencySeconds: 0,
  directMixBypass: false,
  endTimer: null,
  loadPromise: null,
  loadPromiseId: null,
  loadGeneration: 0,
  seekGeneration: 0
};

function fetchStemWithLegacyFallback(url) {
  return fetch(url).then((response) => {
    if (response.ok || !url.endsWith(".wav")) return response;
    return fetch(url.slice(0, -4) + ".mp3").then((legacy) => (legacy.ok ? legacy : response));
  });
}

export function recRate() {
  return state.playbackRate;
}

export function recTime() {
  if (!rec.playing) return rec.offset;
  // While pitch compensation is active every channel is aligned to the
  // shifter's mean output latency. Keep the playhead on audible audio rather
  // than letting it run ahead during that short DSP pre-roll.
  const deviceLatency = typeof rec.ctx.outputLatency === "number" && Number.isFinite(rec.ctx.outputLatency)
    ? rec.ctx.outputLatency
    : 0;
  const audibleElapsed = Math.max(0, rec.ctx.currentTime - rec.startedAt - deviceLatency);
  return rec.offset + audibleElapsed * recRate();
}

export function recStop(keepOffset, options = {}) {
  if (rec.endTimer !== null) {
    try { window.clearTimeout(rec.endTimer); } catch (_error) {}
    rec.endTimer = null;
  }
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
  if (rec.compensationNodes && rec.compensationNodes.length) {
    rec.compensationNodes.forEach((node) => {
      try { node.disconnect(); } catch (e) {}
    });
    rec.compensationNodes = [];
  }
  rec.outputLatencySeconds = 0;
  rec.directMixBypass = false;
  Object.keys(rec.gains).forEach((name) => {
    try { rec.gains[name]?.disconnect(); } catch (e) {}
    rec.gains[name] = null;
  });
  if (rec.playing && keepOffset) {
    rec.offset = Math.min(recTime(), rec.buffer ? rec.buffer.duration : 0);
  }
  if (!keepOffset) rec.offset = 0;
  rec.playing = false;
  if (options.notify !== false) {
    window.dispatchEvent(new CustomEvent("fgr:recupdate"));
  }
}

function finishRecordingAfterOutputTail() {
  const finish = () => {
    rec.endTimer = null;
    if (rec.playing) recStop(false);
    else window.dispatchEvent(new CustomEvent("fgr:recupdate"));
  };
  const tailMilliseconds = Math.max(0, Math.ceil(rec.outputLatencySeconds * 1000));
  if (tailMilliseconds > 0 && typeof window.setTimeout === "function") {
    rec.endTimer = window.setTimeout(finish, tailMilliseconds);
  } else {
    finish();
  }
}

const MIXER_CHANNELS = ["bass", "drums", "guitar", "piano", "vocals", "other"];
const CORE_STEM_CHANNELS = ["bass", "drums", "vocals", "other"];

function loadedStemNames(stems = rec.stems) {
  if (!rec.hasStems || !stems) return [];
  const names = MIXER_CHANNELS.filter((name) => Boolean(stems[name]));
  // A partial response is not a reconstructable mix. Treat it as unavailable
  // so a single optional stem can never replace the complete master.
  return CORE_STEM_CHANNELS.every((name) => names.includes(name)) ? names : [];
}

function effectiveMixerGains(channels) {
  const fallback = { volume: 1, mute: false, solo: false };
  const activeChannels = new Set(channels);
  const isAnySolo = channels.some((name) => (state.mixer[name] || fallback).solo);
  return Object.fromEntries(MIXER_CHANNELS.map((name) => {
    if (!activeChannels.has(name)) return [name, 0];
    const channel = state.mixer[name] || fallback;
    const volumeValue = Number(channel.volume);
    const volume = Number.isFinite(volumeValue) ? clamp(volumeValue, 0, 2) : 1;
    if (channel.mute || (isAnySolo && !channel.solo)) return [name, 0];
    return [name, volume];
  }));
}

function applyMixerGains(channels, options = {}) {
  const targets = effectiveMixerGains(channels);
  const now = rec.ctx ? rec.ctx.currentTime : 0;
  MIXER_CHANNELS.forEach((name) => {
    const param = rec.gains[name]?.gain;
    if (!param) return;
    const target = targets[name];
    if (typeof param.cancelScheduledValues === "function") param.cancelScheduledValues(now);
    if (options.immediate || target === 0) {
      if (typeof param.setValueAtTime === "function") param.setValueAtTime(target, now);
      param.value = target;
    } else if (typeof param.setTargetAtTime === "function") {
      param.setTargetAtTime(target, now, 0.015);
    } else {
      param.value = target;
    }
  });
}

function shouldUseDirectMix(dspPlan, stemNames = loadedStemNames()) {
  if (!rec.mixBuffer || dspPlan.usePitchCompensation) return false;
  // Without real isolated buffers, mixer controls cannot remove an instrument.
  // Preserve the original master instead of degrading it through fake EQ bands.
  return stemNames.length === 0 || isMixerNeutral(stemNames);
}

export function updateMixerGains() {
  const stemNames = loadedStemNames();
  if (rec.playing && rec.mixBuffer) {
    const shouldBypass = shouldUseDirectMix(
      buildPlaybackDspPlan(state.playbackRate, state.transpose),
      stemNames
    );
    if (shouldBypass !== rec.directMixBypass) {
      const currentTime = recTime();
      recPlayFrom(currentTime);
      return;
    }
  }
  if (!stemNames.length) return;
  applyMixerGains(stemNames);
}

function isMixerNeutral(channels = MIXER_CHANNELS) {
  return channels.every((name) => {
    const channel = state.mixer[name] || { volume: 1, mute: false, solo: false };
    return Math.abs((Number(channel.volume) || 0) - 1) < 1e-6 && !channel.mute && !channel.solo;
  });
}

function getReferenceStemBuffer(stems = rec.stems) {
  if (!stems) return null;
  const buffers = Object.values(stems).filter(Boolean);
  if (!buffers.length) return null;
  return buffers.reduce((best, buffer) => (!best || buffer.duration > best.duration ? buffer : best), null);
}

export function buildPlaybackDspPlan(playbackRate = 1, transpose = 0) {
  const rate = clamp(Number(playbackRate) || 1, 0.25, 4);
  const semitones = Number(transpose) || 0;
  const speedSemitones = 12 * Math.log2(rate);
  const shiftSemitones = semitones - speedSemitones;
  const usePitchCompensation = Math.abs(shiftSemitones) >= 0.05;
  // All pitched stems use one window so their phase/latency relationship is
  // stable. Unpitched stems (drums) receive this mean delay only when the
  // shifter is actually active.
  const pitchWindowSeconds = 0.05;
  const outputLatencySeconds = usePitchCompensation ? pitchWindowSeconds / 2 : 0;
  return {
    rate,
    shiftSemitones,
    usePitchCompensation,
    pitchWindowSeconds,
    outputLatencySeconds
  };
}

export function recPlayFrom(offset) {
  if (!rec.buffer) return;
  // The recording is commonly decoded during page setup, before a user
  // gesture. Browsers may leave that AudioContext suspended, so explicitly
  // resume it from the transport click before scheduling the source.
  if (rec.ctx?.state === "suspended" && typeof rec.ctx.resume === "function") {
    try {
      const resumePromise = rec.ctx.resume();
      if (resumePromise && typeof resumePromise.catch === "function") {
        resumePromise.catch(() => {});
      }
    } catch (_error) {}
  }
  // Restart as one observable transport transition. Broadcasting from
  // recStop(false) here used to expose a transient paused 0:00 state before
  // the new source and offset were installed. Both waveform seek controls
  // reacted to that intermediate event and visibly snapped back.
  recStop(false, { notify: false });
  rec.offset = Math.max(0, Math.min(offset, Math.max(0, rec.buffer.duration - 0.1)));
  
  const dspPlan = buildPlaybackDspPlan(state.playbackRate, state.transpose);
  const stemNames = loadedStemNames();
  const hasMixerStems = stemNames.length > 0;
  rec.outputLatencySeconds = dspPlan.outputLatencySeconds;
  rec.directMixBypass = shouldUseDirectMix(dspPlan, stemNames);

  const dest = state.masterGain || rec.ctx.destination;
  Object.keys(rec.gains).forEach((name) => {
    rec.gains[name] = !rec.directMixBypass && hasMixerStems ? rec.ctx.createGain() : null;
  });
  if (!rec.directMixBypass && hasMixerStems) applyMixerGains(stemNames, { immediate: true });

  rec.sources = [];
  rec.pitchShifters = [];
  rec.compensationNodes = [];
  let sourceStartTime = rec.ctx.currentTime;

  if (rec.directMixBypass) {
    rec.source = rec.ctx.createBufferSource();
    rec.source.buffer = rec.mixBuffer;
    rec.source.playbackRate.value = dspPlan.rate;
    rec.source.connect(dest);
    rec.source.onended = function () {
      finishRecordingAfterOutputTail();
    };
    sourceStartTime = rec.ctx.currentTime;
    rec.source.start(sourceStartTime, rec.offset);
    rec.startedAt = sourceStartTime;
    rec.playing = true;
    window.dispatchEvent(new CustomEvent("fgr:recupdate"));
    return;
  }

  if (hasMixerStems) {
    if (dspPlan.usePitchCompensation) {
      // Sum pitched channels into one shifter. Separate shifters start their
      // modulation oscillators at slightly different phases, so even equal
      // window sizes do not remain sample-aligned.
      const sharedShifter = createPitchShifter(
        rec.ctx,
        dspPlan.shiftSemitones,
        dspPlan.pitchWindowSeconds
      );
      rec.pitchShifters.push(sharedShifter);
      sharedShifter.output.connect(dest);

      Object.entries(rec.gains).forEach(([name, gain]) => {
        if (name !== "drums") gain.connect(sharedShifter.input);
      });
      const drumDelay = rec.ctx.createDelay(1);
      drumDelay.delayTime.value = dspPlan.outputLatencySeconds;
      drumDelay.connect(dest);
      rec.compensationNodes.push(drumDelay);
      rec.gains.drums.connect(drumDelay);
    } else {
      // The default path is intentionally literal: six sources start on the
      // same sample and connect only through their channel gain to master.
      Object.values(rec.gains).forEach((gain) => gain.connect(dest));
    }

    const stemsToLoad = [
      { name: "bass", destNode: rec.gains.bass },
      { name: "drums", destNode: rec.gains.drums },
      { name: "guitar", destNode: rec.gains.guitar },
      { name: "piano", destNode: rec.gains.piano },
      { name: "vocals", destNode: rec.gains.vocals },
      { name: "other", destNode: rec.gains.other }
    ];

    stemsToLoad.forEach((stemInfo) => {
      const buf = rec.stems[stemInfo.name];
      if (!buf) return;

      const source = rec.ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = dspPlan.rate;
      rec.sources.push(source);

      source.connect(stemInfo.destNode);
    });

    if (!rec.sources.length) {
      window.dispatchEvent(new CustomEvent("fgr:recupdate"));
      return;
    }

    sourceStartTime = rec.ctx.currentTime;
    rec.sources.forEach((source) => {
      source.start(sourceStartTime, rec.offset);
    });

    // The original master is the transport buffer but it is not one of the
    // sources when a custom stem mix is active. Tie completion to the longest
    // available stem so a shorter bass/vocal tail cannot stop the whole song.
    const mainSource = rec.sources.reduce(
      (longest, source) => !longest || source.buffer.duration > longest.buffer.duration ? source : longest,
      null
    );
    if (mainSource) {
      mainSource.onended = function () {
        finishRecordingAfterOutputTail();
      };
    }
  } else {
    // A legacy/original recording is one indivisible source. The previous
    // fallback split it into three broad EQ bands, yet exposed six stem
    // controls; muting vocals/guitar/piano therefore changed the timbre while
    // leaving that instrument audible. Keep the master phase-coherent instead.
    rec.source = rec.ctx.createBufferSource();
    rec.source.buffer = rec.mixBuffer || rec.buffer;
    rec.source.playbackRate.value = dspPlan.rate;

    rec.pitchShifter = dspPlan.usePitchCompensation
      ? createPitchShifter(rec.ctx, dspPlan.shiftSemitones, dspPlan.pitchWindowSeconds)
      : null;
    if (rec.pitchShifter) {
      rec.source.connect(rec.pitchShifter.input);
      rec.pitchShifter.output.connect(dest);
    } else {
      rec.source.connect(dest);
    }

    rec.source.onended = function () {
      finishRecordingAfterOutputTail();
    };

    sourceStartTime = rec.ctx.currentTime;
    rec.source.start(sourceStartTime, rec.offset);
  }

  rec.startedAt = sourceStartTime + rec.outputLatencySeconds;
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

export function invalidateRecLoad() {
  rec.loadGeneration += 1;
  rec.loadPromise = null;
  rec.loadPromiseId = null;
}

function getSelectedSong() {
  return state.repertoire.find((song) => song.id === state.selectedSongId) || null;
}

export function recLoad() {
  const song = getSelectedSong();
  if (!song) return Promise.resolve(false);
  const id = "song-" + song.id;
  if (rec.buffer && rec.bufferId === id) return Promise.resolve(true);
  if (rec.loadPromise && rec.loadPromiseId === id) return rec.loadPromise;

  // Loading/decoding is safe during page setup; transport handlers resume the
  // context synchronously from a real user gesture before playback.
  const ctx = ensureAudio({ resume: false });
  if (!ctx) return Promise.resolve(false);
  rec.ctx = ctx;
  const generation = rec.loadGeneration + 1;
  rec.loadGeneration = generation;
  rec.loadPromiseId = id;

  const operation = song.stems
    ? loadStemRecording(ctx, id, song, generation)
    : loadLegacyRecording(id, song, generation);
  let trackedPromise;
  trackedPromise = Promise.resolve(operation).finally(() => {
    if (rec.loadPromise === trackedPromise) {
      rec.loadPromise = null;
      rec.loadPromiseId = null;
    }
  });
  rec.loadPromise = trackedPromise;
  return trackedPromise;
}

function loadStemRecording(ctx, id, song, generation) {
  const stems = {};
  const stemNames = ["bass", "drums", "guitar", "piano", "vocals", "other"];
  const advertisedStems = new Set(Array.isArray(song.availableStems) ? song.availableStems : []);
  const requiredStems = advertisedStems.size ? advertisedStems : new Set(["bass", "drums", "vocals", "other"]);
  const promises = stemNames.map((name) => {
    const url = getSongAssetUrl(song, name) || `samples/${song.id}/${name}.wav`;
    return fetchStemWithLegacyFallback(url)
      .then((response) => {
        if (!response.ok) {
          if (requiredStems.has(name)) throw new Error(`Failed to fetch stem: ${name}`);
          return null;
        }
        return response.arrayBuffer();
      })
      .then((data) => data ? ctx.decodeAudioData(data) : null)
      .then((buffer) => {
        if (buffer) stems[name] = buffer;
      });
  });
  const mixPromise = loadOriginalMixBuffer(ctx, id, song);

  return Promise.all([...promises, mixPromise])
    .then((loaded) => {
      if (!isCurrentRecLoad(id, generation)) return false;
      const reference = getReferenceStemBuffer(stems);
      if (!reference) throw new Error("No playable stems loaded");
      const missingCoreStems = CORE_STEM_CHANNELS.filter((name) => !stems[name]);
      if (missingCoreStems.length) {
        throw new Error(`Incomplete stem mix: ${missingCoreStems.join(", ")}`);
      }
      const mixBuffer = loaded[loaded.length - 1] || null;
      rec.hasStems = true;
      rec.stems = stems;
      rec.mixBuffer = mixBuffer;
      // The master defines transport duration and neutral playback. Stem sum
      // is used only after the user changes a channel, speed or transpose.
      rec.buffer = mixBuffer || reference;
      rec.bufferId = id;
      return true;
    })
    .catch((error) => {
      if (!isCurrentRecLoad(id, generation)) return false;
      console.error("Error loading stems:", error);
      return loadLegacyRecording(id, song, generation);
    });
}

async function loadOriginalMixBuffer(ctx, id, song) {
  const remoteMixUrl = getSongAssetUrl(song, "");
  if (remoteMixUrl) {
    try {
      const response = await fetch(remoteMixUrl);
      if (!response.ok) throw new Error(`Failed to fetch source mix (${response.status})`);
      return await ctx.decodeAudioData(await response.arrayBuffer());
    } catch (error) {
      console.warn("Original mix asset is unavailable; trying the local upload.", error);
    }
  }
  try {
    const item = await dbGet(id);
    if (!item?.blob) return null;
    return await ctx.decodeAudioData(await item.blob.arrayBuffer());
  } catch {
    return null;
  }
}

function getSongAssetUrl(song, stemName) {
  const asset = stemName ? song?.assets?.stems?.[stemName] : song?.assets?.mix;
  if (typeof asset === "string") return asset;
  return asset && typeof asset.url === "string" ? asset.url : "";
}

function isCurrentRecLoad(id, generation) {
  return rec.loadGeneration === generation && recId() === id;
}

function loadLegacyRecording(id, song, generation) {
  const remoteMixUrl = getSongAssetUrl(song, "");
  if (remoteMixUrl) {
    return fetch(remoteMixUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch source mix (${response.status})`);
        return response.arrayBuffer();
      })
      .then((data) => rec.ctx.decodeAudioData(data))
      .then((buffer) => {
        if (!isCurrentRecLoad(id, generation)) return false;
        rec.hasStems = false;
        rec.stems = null;
        rec.mixBuffer = buffer;
        rec.buffer = buffer;
        rec.bufferId = id;
        return true;
      })
      .catch(() => isCurrentRecLoad(id, generation) ? loadLocalRecording(id, generation) : false);
  }
  return loadLocalRecording(id, generation);
}

function loadLocalRecording(id, generation) {
  return dbGet(id).then(function (item) {
    if (!item || !isCurrentRecLoad(id, generation)) return false;
    return item.blob.arrayBuffer().then(function (data) {
      return rec.ctx.decodeAudioData(data);
    }).then(function (buffer) {
      if (!isCurrentRecLoad(id, generation)) return false;
      rec.hasStems = false;
      rec.stems = null;
      rec.mixBuffer = buffer;
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
  const requestedTime = Math.max(0, Number(t) || 0);
  const selectedBufferId = recId();
  const hasSelectedBuffer = Boolean(
    selectedBufferId && rec.buffer && rec.bufferId === selectedBufferId
  );
  const knownDuration = hasSelectedBuffer
    ? Math.max(0, Number(rec.buffer.duration) || 0)
    : 0;
  const immediateTime = knownDuration > 0
    ? Math.min(requestedTime, knownDuration)
    : requestedTime;
  const generation = ++rec.seekGeneration;

  // A playing transport necessarily already has its buffer, so restart it
  // synchronously. This avoids one microtask of audio/playhead disagreement.
  if (rec.playing && hasSelectedBuffer) {
    recPlayFrom(immediateTime);
    return Promise.resolve(true);
  }

  // Keep a paused edit cursor authoritative before recLoad starts. Loading and
  // decoding can take time (or fail), but chart editing must never fall back to
  // the previous offset (especially 0:00) while that work is pending.
  rec.offset = immediateTime;
  window.dispatchEvent(new CustomEvent("fgr:recupdate"));

  return recLoad().then(function (ok) {
    if (!ok || generation !== rec.seekGeneration || recId() !== selectedBufferId) return false;
    const duration = Math.max(0, Number(rec.buffer?.duration) || 0);
    const loadedTime = duration > 0 ? Math.min(requestedTime, duration) : requestedTime;
    if (rec.playing) recPlayFrom(loadedTime);
    else {
      rec.offset = loadedTime;
      window.dispatchEvent(new CustomEvent("fgr:recupdate"));
    }
    return true;
  }).catch(function () {
    // The synchronous target above is still a valid edit position even when
    // IndexedDB, fetch, or decoding cannot provide playable audio.
    return false;
  });
}

// ---------------- OFFLINE CHORD ANALYSIS DSP ----------------
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
  const bassChroma = new Array(12).fill(0);
  for (let m = 24; m < 96; m++) {
    chroma[m % 12] += midiBins[m];
    if (m < 60) bassChroma[m % 12] += midiBins[m];
  }
  return { chroma, bassChroma };
}

function chromaFlux(currentValues, previousValues) {
  if (!Array.isArray(currentValues) || !Array.isArray(previousValues)) return 0;
  const normalize = (values) => {
    const compressed = values.map((value) => Math.sqrt(Math.max(0, Number(value) || 0)));
    const total = compressed.reduce((sum, value) => sum + value, 0) || 1;
    return compressed.map((value) => value / total);
  };
  const current = normalize(currentValues);
  const previous = normalize(previousValues);
  return current.reduce((sum, value, index) => sum + Math.max(0, value - previous[index]), 0);
}

function alignDedicatedBassFrames(frames) {
  const observations = frames
    .filter((frame) => Number.isFinite(frame.bassAnalysisTime) && frame.bassChroma)
    .map((frame) => ({ t: frame.bassAnalysisTime, chroma: frame.bassChroma }));
  if (!observations.length) return;

  let cursor = 0;
  frames.forEach((frame) => {
    while (cursor + 1 < observations.length && observations[cursor + 1].t <= frame.t) {
      cursor += 1;
    }
    const left = observations[cursor];
    const right = observations[Math.min(cursor + 1, observations.length - 1)];
    const span = right.t - left.t;
    const ratio = span > 1e-8 ? clamp((frame.t - left.t) / span, 0, 1) : 0;
    const aligned = Array.from({ length: 12 }, (_, pitchClass) =>
      (Number(left.chroma[pitchClass]) || 0) * (1 - ratio) +
      (Number(right.chroma[pitchClass]) || 0) * ratio
    );
    frame.bassChroma = aligned.some((value) => value > 1e-8)
      ? aligned
      : frame.mixBassChroma;
  });
}

/**
 * Resolve a stored analysis event to the MIDI note that the assisted player
 * must sound. This deliberately has no dependency on baseOctave, keyboard
 * voicing, visible key range or the selected manual instrument.
 */
export function assistedMidiFromEvent(event, transposeSemitones = 0) {
  const storedMidi = Number(event?.midi);
  const transpose = Number(transposeSemitones);
  if (!Number.isFinite(storedMidi) || !Number.isFinite(transpose)) return null;
  const midi = Math.round(storedMidi) + Math.round(transpose);
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function setAssistedMidiSet(sourceName, desiredMidis, restartMidis = new Set()) {
  const owner = `assist:${String(sourceName || "notes")}`;
  const desired = new Set([...desiredMidis].filter(Number.isFinite));
  const previous = state.assistedMidiSets.get(owner) || new Set();
  const restart = new Set([...restartMidis].filter((midi) => previous.has(midi) && desired.has(midi)));

  previous.forEach((midi) => {
    if (!desired.has(midi)) stopNote(midi, owner);
  });
  desired.forEach((midi) => {
    if (restart.has(midi)) {
      retriggerNotePreservingOwners(midi, owner);
    } else if (!previous.has(midi)) {
      if (sourceName === "melody" && state.activeNotes.has(midi)) {
        retriggerNotePreservingOwners(midi, owner);
      } else {
        startNote(midi, owner);
      }
    }
  });

  if (desired.size) state.assistedMidiSets.set(owner, desired);
  else state.assistedMidiSets.delete(owner);
}

function retriggerNotePreservingOwners(midi, owner) {
  const sounding = state.activeNotes.get(midi);
  if (!sounding) {
    startNote(midi, owner);
    return;
  }

  // Harmony and the guided line can legitimately share a piano key. A new
  // melody event still needs a fresh attack, while every existing owner must
  // continue holding the replacement voice afterwards.
  const owners = new Set(noteOwners(sounding));
  owners.add(owner);
  stopNote(midi, null);
  [...owners]
    .sort((first, second) =>
      Number(String(second).startsWith("assist:")) - Number(String(first).startsWith("assist:"))
    )
    .forEach((noteOwner) => startNote(midi, noteOwner));
}

function spectrumMagnitudeAt(dbValues, frequency, sampleRate, fftSize) {
  if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= sampleRate / 2) return 0;
  const exactBin = frequency * fftSize / sampleRate;
  const center = Math.max(1, Math.min(dbValues.length - 2, Math.round(exactBin)));
  let bestDb = -Infinity;
  for (let offset = -1; offset <= 1; offset += 1) {
    bestDb = Math.max(bestDb, Number(dbValues[center + offset]));
  }
  return Number.isFinite(bestDb) ? 10 ** (bestDb / 20) : 0;
}

function detectMonophonicPitchFrame(dbValues, sampleRate, fftSize, options) {
  const minMidi = Math.max(0, Math.round(options.minMidi));
  const maxMidi = Math.min(127, Math.round(options.maxMidi));
  const harmonicWeights = options.mode === "bass"
    ? [1, 0.72, 0.42, 0.25, 0.14]
    : [1, 0.58, 0.34, 0.2, 0.12];
  const candidates = [];
  let peakDb = -Infinity;

  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const fundamental = frequencyFromMidi(midi);
    let score = 0;
    let fundamentalMagnitude = 0;
    harmonicWeights.forEach((weight, index) => {
      const magnitude = spectrumMagnitudeAt(dbValues, fundamental * (index + 1), sampleRate, fftSize);
      if (index === 0) fundamentalMagnitude = magnitude;
      score += magnitude * weight;
    });
    const lowerOctave = spectrumMagnitudeAt(dbValues, fundamental / 2, sampleRate, fftSize);
    score -= lowerOctave * 0.18;
    candidates.push({ midi, score: Math.max(0, score), fundamentalMagnitude });

    const bin = Math.max(0, Math.min(dbValues.length - 1, Math.round(fundamental * fftSize / sampleRate)));
    peakDb = Math.max(peakDb, Number(dbValues[bin]));
  }

  candidates.sort((first, second) => second.score - first.score);
  const best = candidates[0];
  const runnerUp = candidates.find((candidate) => Math.abs(candidate.midi - best.midi) > 1) || candidates[1];
  if (!best || best.score < 0.00045 || peakDb < -72) return null;

  const separation = clamp((best.score - (runnerUp?.score || 0)) / Math.max(best.score, 1e-8) * 2.2, 0, 1);
  const energy = clamp((peakDb + 72) / 34, 0, 1);
  const fundamentalShare = clamp(best.fundamentalMagnitude / Math.max(best.score, 1e-8), 0, 1);
  const confidence = clamp(separation * 0.58 + energy * 0.27 + fundamentalShare * 0.15, 0, 1);
  if (confidence < (options.mode === "bass" ? 0.12 : 0.16)) return null;
  return { midi: best.midi, confidence };
}

function noteTrackJumpMetrics(events) {
  let octaveJumps = 0;
  let largeLeaps = 0;
  for (let index = 1; index < events.length; index += 1) {
    const interval = Math.abs(Number(events[index].midi) - Number(events[index - 1].midi));
    if (interval >= 12) largeLeaps += 1;
    if (interval >= 12 && interval % 12 === 0) octaveJumps += 1;
  }
  const adjacentPairs = Math.max(0, events.length - 1);
  return {
    adjacentPairs,
    octaveJumps,
    octaveJumpRate: octaveJumps / Math.max(1, adjacentPairs),
    largeLeaps,
    largeLeapRate: largeLeaps / Math.max(1, adjacentPairs)
  };
}

/**
 * Keep the detector's absolute register intact. This function retains its
 * historical name because stored clients import it, but it no longer moves a
 * pitch by one or more octaves to make a line look artificially smoother.
 * A real octave leap is musical data, not a piano-display preference.
 */
export function stabilizeNoteEventOctaves(events, options = {}) {
  const mode = options.mode === "bass" ? "bass" : "melody";
  const requestedThreshold = Number(options.minimumEventConfidence);
  const confidenceThreshold = Number.isFinite(requestedThreshold)
    ? clamp(requestedThreshold, 0, 1)
    : mode === "bass" ? 0.16 : 0.20;
  if (!Array.isArray(events)) return [];

  return events.flatMap((event) => {
    const exactMidi = Math.round(Number(event?.midi));
    const confidence = Number(event?.confidence);
    if (!Number.isFinite(exactMidi) || exactMidi < 0 || exactMidi > 127) return [];
    if (Number.isFinite(confidence) && confidence < confidenceThreshold) return [];
    const sourceMidi = Math.round(Number(event?.detectedMidi));
    return [{
      ...event,
      midi: exactMidi,
      // Store detector provenance even when the exact result needs no
      // correction, so a later server/client comparison remains auditable.
      detectedMidi: Number.isFinite(sourceMidi) && sourceMidi >= 0 && sourceMidi <= 127
        ? sourceMidi
        : exactMidi
    }];
  });
}

function stabilizeNoteFrames(frames, hopSeconds, options) {
  const filtered = frames.map((frame) => {
    if (!frame.pitch) return { ...frame, midi: null, confidence: 0 };
    return {
      ...frame,
      // Do not replace an isolated detected pitch with the neighbouring
      // register. Low-confidence frames are rejected by the detector/filter;
      // every accepted MIDI value keeps the octave that was measured.
      midi: frame.pitch.midi,
      confidence: frame.pitch.confidence
    };
  });

  const rawEvents = [];
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    const duration = Math.max(hopSeconds, current.lastTime + hopSeconds - current.start);
    const minimumDuration = options.mode === "bass" ? 0.09 : 0.07;
    if (duration >= minimumDuration && current.frames >= 2) {
      rawEvents.push({
        t: Math.max(0, Math.round(current.start * 1000) / 1000),
        d: Math.round(duration * 1000) / 1000,
        midi: current.midi,
        detectedMidi: current.midi,
        confidence: Math.round((current.confidence / current.frames) * 1000) / 1000
      });
    }
    current = null;
  };

  filtered.forEach((frame) => {
    if (!Number.isFinite(frame.midi)) {
      finishCurrent();
      return;
    }
    const continuous = current && frame.t - current.lastTime <= hopSeconds * 1.8;
    if (!continuous || current.midi !== frame.midi) {
      finishCurrent();
      current = {
        midi: frame.midi,
        start: frame.t,
        lastTime: frame.t,
        confidence: frame.confidence,
        frames: 1
      };
      return;
    }
    current.lastTime = frame.t;
    current.confidence += frame.confidence;
    current.frames += 1;
  });
  finishCurrent();

  const events = [];
  rawEvents.forEach((event) => {
    const previous = events[events.length - 1];
    const previousEnd = previous ? previous.t + previous.d : -Infinity;
    if (previous && previous.midi === event.midi && event.t - previousEnd <= hopSeconds * 1.6) {
      const combinedEnd = event.t + event.d;
      const previousFrames = Math.max(1, Math.round(previous.d / hopSeconds));
      const eventFrames = Math.max(1, Math.round(event.d / hopSeconds));
      previous.d = Math.round((combinedEnd - previous.t) * 1000) / 1000;
      previous.confidence = Math.round(
        ((previous.confidence * previousFrames + event.confidence * eventFrames) / (previousFrames + eventFrames)) * 1000
      ) / 1000;
    } else {
      events.push(event);
    }
  });

  const detectedMetrics = noteTrackJumpMetrics(events);
  const stabilizedEvents = stabilizeNoteEventOctaves(events, options);
  const stabilizedMetrics = noteTrackJumpMetrics(stabilizedEvents);
  const voicedSeconds = stabilizedEvents.reduce((sum, event) => sum + event.d, 0);
  const duration = frames.length ? frames[frames.length - 1].t + hopSeconds : 0;
  const meanConfidence = stabilizedEvents.length
    ? stabilizedEvents.reduce((sum, event) => sum + event.confidence, 0) / stabilizedEvents.length
    : 0;
  const monophony = stabilizedEvents.length > 1
    ? 1 - stabilizedMetrics.largeLeaps / (stabilizedEvents.length - 1)
    : stabilizedEvents.length ? 1 : 0;
  const voicedRatio = duration ? clamp(voicedSeconds / duration, 0, 1) : 0;
  const score = clamp(
    meanConfidence * 0.55
      + voicedRatio * 0.25
      + monophony * 0.15
      + Math.min(stabilizedEvents.length / 80, 0.05),
    0,
    1
  );
  return {
    events: stabilizedEvents,
    quality: {
      score,
      voicedRatio,
      meanConfidence,
      monophony,
      octaveCorrections: stabilizedEvents.filter((event) => event.midi !== event.detectedMidi).length,
      octaveMetricsBefore: detectedMetrics,
      octaveMetricsAfter: stabilizedMetrics
    }
  };
}

export function extractNoteTrackFromBuffer(buffer, options = {}) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext || !buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
    return Promise.resolve({ events: [], quality: { score: 0, voicedRatio: 0, meanConfidence: 0, monophony: 0 } });
  }

  const mode = options.mode === "bass" ? "bass" : "melody";
  const hopSeconds = clamp(Number(options.hopSeconds) || (mode === "bass" ? 0.05 : 0.04), 0.03, 0.12);
  const fftSize = mode === "bass" ? 8192 : 4096;
  const minMidi = Number.isFinite(Number(options.minMidi)) ? Number(options.minMidi) : mode === "bass" ? 28 : 48;
  const maxMidi = Number.isFinite(Number(options.maxMidi)) ? Number(options.maxMidi) : mode === "bass" ? 64 : 100;
  const context = new OfflineContext(1, buffer.length, buffer.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -15;
  source.connect(analyser);
  analyser.connect(context.destination);
  source.start(0);

  const frames = [];
  const analysisWindowSeconds = fftSize / buffer.sampleRate;
  const firstFrameEnd = Math.max(hopSeconds, analysisWindowSeconds);
  for (let frameEnd = firstFrameEnd; frameEnd < buffer.duration; frameEnd += hopSeconds) {
    ((at) => {
      context.suspend(at).then(() => {
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(spectrum);
        frames.push({
          t: Math.max(0, at - analysisWindowSeconds / 2),
          pitch: detectMonophonicPitchFrame(spectrum, buffer.sampleRate, fftSize, { mode, minMidi, maxMidi })
        });
        if (typeof options.onProgress === "function" && frames.length % 50 === 0) {
          options.onProgress(clamp(at / buffer.duration, 0, 1));
        }
        context.resume();
      }).catch(() => {});
    })(frameEnd);
  }

  return context.startRendering().then(() => {
    frames.sort((first, second) => first.t - second.t);
    if (typeof options.onProgress === "function") options.onProgress(1);
    return stabilizeNoteFrames(frames, hopSeconds, { mode, minMidi, maxMidi });
  });
}

export async function extractFallbackNoteTracks(stems, options = {}) {
  const available = stems && typeof stems === "object" ? stems : {};
  const output = {};
  const bassBuffer = available.bass;
  if (bassBuffer) {
    const bass = await extractNoteTrackFromBuffer(bassBuffer, {
      mode: "bass",
      onProgress: (progress) => options.onProgress?.({ channel: "bass", source: "bass", progress })
    });
    if (bass.events.length && bass.quality.meanConfidence >= 0.3 && bass.quality.score >= 0.32) {
      output.bass = { ...bass, sourceStem: "bass", algorithm: "browser-spectral-exact-v3" };
    }
  }

  const melodyCandidates = ["other", "piano", "guitar"]
    .filter((name) => available[name])
    .map((name) => ({ name, buffer: available[name] }));
  const analyzedCandidates = [];
  for (let index = 0; index < melodyCandidates.length; index += 1) {
    const candidate = melodyCandidates[index];
    const analyzed = await extractNoteTrackFromBuffer(candidate.buffer, {
      mode: "melody",
      onProgress: (progress) => options.onProgress?.({
        channel: "melody",
        source: candidate.name,
        progress: (index + progress) / Math.max(1, melodyCandidates.length)
      })
    });
    const sourceBias = candidate.name === "other" ? 0.07 : candidate.name === "piano" ? 0.025 : 0;
    analyzedCandidates.push({ ...analyzed, sourceStem: candidate.name, rankScore: analyzed.quality.score + sourceBias });
  }

  analyzedCandidates.sort((first, second) => second.rankScore - first.rankScore);
  const bestMelody = analyzedCandidates.find((candidate) =>
    candidate.events.length >= 2
    && candidate.quality.meanConfidence >= 0.32
    && candidate.quality.score >= 0.34
  );
  if (bestMelody) {
    output.melody = { ...bestMelody, algorithm: "browser-spectral-exact-v3" };
  }
  return output;
}

export function clearAssistedNotes(sourceName) {
  if (sourceName) {
    setAssistedMidiSet(sourceName, new Set());
    return;
  }
  [...state.assistedMidiSets.keys()].forEach((owner) => {
    const name = owner.startsWith("assist:") ? owner.slice(7) : owner;
    setAssistedMidiSet(name, new Set());
  });
}

export function analyzeBuffer(buffer, onProgress, options = {}) {
  // A 50 ms fallback hop bounds frame quantisation to about 25 ms. Imported
  // songs normally use the still finer server analysis from aligned stems.
  const HOP = clamp(Number(options.hopSeconds) || 0.05, 0.05, 0.5);
  const requestedFft = Number(options.fftSize) || 4096;
  const FFT = [2048, 4096, 8192, 16384].includes(requestedFft) ? requestedFft : 4096;
  const BASS_FFT = Math.max(8192, FFT);
  const key = parseKeySignature(options.key || "");
  const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT;
  // Offline frames must not inherit energy from the previous frame. That
  // temporal smoothing made a new harmony look like the old one for another
  // analysis step and delayed every boundary.
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  source.start(0);
  const dedicatedBassBuffer = options.bassReferenceBuffer;
  let bassAnalyser = null;
  if (dedicatedBassBuffer && Number.isFinite(dedicatedBassBuffer.duration) && dedicatedBassBuffer.duration > 0) {
    const bassSource = ctx.createBufferSource();
    bassSource.buffer = dedicatedBassBuffer;
    bassAnalyser = ctx.createAnalyser();
    // 4096 bins at 44.1 kHz cannot reliably distinguish D2 (73.4 Hz) from
    // Dis2 (77.8 Hz). The isolated root branch therefore gets twice the
    // frequency resolution of the harmonic analyser.
    bassAnalyser.fftSize = BASS_FFT;
    bassAnalyser.smoothingTimeConstant = 0;
    bassSource.connect(bassAnalyser);
    // This is a separate analysis branch. It reaches the offline destination
    // only to keep the graph live; its samples never feed the harmony analyser
    // above, so root evidence remains independently measurable.
    bassAnalyser.connect(ctx.destination);
    bassSource.start(0);
  }
  const frames = [];
  const duration = buffer.duration;
  const analysisWindowSeconds = FFT / buffer.sampleRate;
  const firstFrameEnd = Math.max(HOP, analysisWindowSeconds);

  for (let frameEnd = firstFrameEnd; frameEnd < duration; frameEnd += HOP) {
    ((at) => {
      ctx.suspend(at).then(() => {
        const arr = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(arr);
        const spectrum = chromaFromSpectrum(arr, buffer.sampleRate, FFT);
        let dedicatedBassChroma = null;
        if (bassAnalyser) {
          const bassArr = new Float32Array(bassAnalyser.frequencyBinCount);
          bassAnalyser.getFloatFrequencyData(bassArr);
          const dedicatedBassSpectrum = chromaFromSpectrum(bassArr, buffer.sampleRate, BASS_FFT);
          if (dedicatedBassSpectrum.bassChroma.some((value) => value > 1e-8)) {
            dedicatedBassChroma = dedicatedBassSpectrum.bassChroma;
          }
        }
        frames.push({
          // AnalyserNode exposes a trailing FFT window. Timestamp its centre,
          // not its end, otherwise all detected events inherit half a window
          // of analysis latency.
          t: centerAnalysisFrameTime(at, FFT, buffer.sampleRate),
          chroma: spectrum.chroma,
          mixBassChroma: spectrum.bassChroma,
          bassChroma: dedicatedBassChroma || spectrum.bassChroma,
          bassAnalysisTime: dedicatedBassChroma
            ? centerAnalysisFrameTime(at, BASS_FFT, buffer.sampleRate)
            : null
        });
        if (onProgress && frames.length % 40 === 0) onProgress(at / duration);
        ctx.resume();
      });
    })(frameEnd);
  }
  
  return ctx.startRendering().then(() => {
    frames.sort((a, b) => a.t - b.t);
    if (bassAnalyser) alignDedicatedBassFrames(frames);
    let previousChroma = null;
    let previousBassChroma = null;
    frames.forEach((frame) => {
      frame.onsetStrength = previousChroma
        ? chromaFlux(frame.chroma, previousChroma) +
          chromaFlux(frame.bassChroma, previousBassChroma || previousChroma) * 0.55
        : 0;
      previousChroma = frame.chroma;
      previousBassChroma = frame.bassChroma;
      frame.chord = detectChordFromChroma(frame.chroma, {
        bassChroma: frame.bassChroma,
        keyPitchClass: key.keyPitchClass,
        keyMode: key.keyMode,
        simpleChart: options.simpleChart !== false
      });
      frame.confidence = frame.chord?.confidence || 0;
    });
    if (Array.isArray(options.referenceChords) && options.referenceChords.length) {
      return refineChordBoundaries(frames, options.referenceChords, options)
        .map(({ t, n }) => ({ t, n }));
    }
    const detected = buildChordTimeline(frames, {
      minSegmentSeconds: options.minSegmentSeconds ?? 0.45,
      smoothingRadius: options.smoothingRadius ?? 1,
      maxGapSeconds: options.maxGapSeconds ?? Math.max(0.25, HOP * 2.5),
      keyPitchClass: key.keyPitchClass,
      keyMode: key.keyMode
    });
    return refineChordBoundaries(frames, detected, {
      ...options,
      allowLabelCorrection: false,
      refinementWindowSeconds: options.detectedRefinementWindowSeconds ?? 0.48,
      evidenceWindowSeconds: options.detectedEvidenceWindowSeconds ?? 0.52,
      boundaryPriorStrength: options.detectedBoundaryPriorStrength ?? 0.018,
      minBoundaryContrast: options.detectedMinBoundaryContrast ?? 0.045
    }).map(({ t, n }) => ({ t, n }));
  });
}

window.FGRAnalyzeBuffer = analyzeBuffer;

