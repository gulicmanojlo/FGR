import assert from "node:assert/strict";

const suspensionTimes = [];
const recUpdateSnapshots = [];
const analyserFftSizes = [];
let analyserSmoothing = null;

globalThis.window = {
  location: { protocol: "http:" },
  dispatchEvent(event) {
    if (event?.type === "fgr:recupdate" && globalThis.__captureRecUpdates) {
      recUpdateSnapshots.push({ playing: rec.playing, offset: rec.offset });
    }
  }
};
globalThis.CustomEvent = class MockCustomEvent {
  constructor(type) { this.type = type; }
};
globalThis.OfflineAudioContext = class MockOfflineAudioContext {
  constructor() {
    this.destination = {};
  }

  createBufferSource() {
    return { connect() {}, start() {} };
  }

  createAnalyser() {
    let fftSize = 4096;
    return {
      get frequencyBinCount() { return fftSize / 2; },
      get fftSize() { return fftSize; },
      set fftSize(value) { fftSize = value; analyserFftSizes.push(value); },
      connect() {},
      get smoothingTimeConstant() { return analyserSmoothing; },
      set smoothingTimeConstant(value) { analyserSmoothing = value; },
      getFloatFrequencyData(values) { values.fill(-Infinity); }
    };
  }

  suspend(time) {
    suspensionTimes.push(time);
    return Promise.resolve();
  }

  resume() {}
  startRendering() { return Promise.resolve({}); }
};

const {
  analyzeBuffer,
  assistedMidiFromEvent,
  buildPlaybackDspPlan,
  invalidateRecLoad,
  rec,
  recPlayFrom,
  recSeek,
  recStop,
  recTime,
  setAssistedMidiSet,
  stabilizeNoteEventOctaves,
  updateMixerGains
} = await import("../js/audio.js");
const { state } = await import("../js/state.js");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const neutralPlayback = buildPlaybackDspPlan(1, 0);
assert.equal(neutralPlayback.usePitchCompensation, false);
assert.equal(neutralPlayback.outputLatencySeconds, 0);
assert.equal(neutralPlayback.shiftSemitones, 0);

const slowedPlayback = buildPlaybackDspPlan(0.75, 0);
assert.equal(slowedPlayback.usePitchCompensation, true);
assert.equal(slowedPlayback.outputLatencySeconds, 0.025);
assert.ok(slowedPlayback.shiftSemitones > 4.9 && slowedPlayback.shiftSemitones < 5.1);

// A rate change whose natural pitch rise is deliberately requested does not
// need a shifter, so it can retain the phase-coherent direct path too.
const naturallyShiftedPlayback = buildPlaybackDspPlan(2, 12);
assert.equal(naturallyShiftedPlayback.usePitchCompensation, false);
assert.equal(naturallyShiftedPlayback.outputLatencySeconds, 0);

// The browser fallback must never invent a smoother octave path. An accepted
// detector result is played in its measured absolute register and retains the
// original MIDI as provenance.
const preservedDetectedRegister = stabilizeNoteEventOctaves([
  { t: 0, d: 0.15, midi: 67, confidence: 0.93 },
  { t: 0.15, d: 0.06, midi: 55, confidence: 0.62 },
  { t: 0.21, d: 0.20, midi: 62, confidence: 0.91 }
], { mode: "melody", minMidi: 45, maxMidi: 96 });
assert.deepEqual(preservedDetectedRegister.map((event) => event.midi), [67, 55, 62]);
assert.deepEqual(preservedDetectedRegister.map((event) => event.detectedMidi), [67, 55, 62]);

const confidenceFilteredRegister = stabilizeNoteEventOctaves([
  { t: 0, d: 0.1, midi: 36, confidence: 0.92, detectedMidi: 36 },
  { t: 0.1, d: 0.1, midi: 48, confidence: 0.08, detectedMidi: 36 },
  { t: 0.2, d: 0.1, midi: 40, confidence: 0.91, detectedMidi: 40 }
], { mode: "bass" });
assert.deepEqual(confidenceFilteredRegister, [
  { t: 0, d: 0.1, midi: 36, confidence: 0.92, detectedMidi: 36 },
  { t: 0.2, d: 0.1, midi: 40, confidence: 0.91, detectedMidi: 40 }
]);

const supportedRegisterChange = stabilizeNoteEventOctaves([
  { t: 0, d: 0.40, midi: 60, confidence: 0.97 },
  { t: 0.4, d: 0.45, midi: 72, confidence: 0.98 },
  { t: 0.85, d: 0.45, midi: 74, confidence: 0.98 },
  { t: 1.3, d: 0.45, midi: 76, confidence: 0.98 }
], { mode: "melody", minMidi: 45, maxMidi: 96 });
assert.deepEqual(supportedRegisterChange.map((event) => event.midi), [60, 72, 74, 76]);

// Manual keyboard choices are intentionally absent from this resolver. Even a
// bass note below the rendered C2 key stays at the stored MIDI octave.
state.baseOctave = 2;
state.octaveLocked = false;
state.instrument = "accordion";
assert.equal(assistedMidiFromEvent({ midi: 28, detectedMidi: 28 }), 28);
state.baseOctave = 6;
state.octaveLocked = true;
state.instrument = "warm-synth";
assert.equal(assistedMidiFromEvent({ midi: 28, detectedMidi: 28 }), 28);
assert.equal(assistedMidiFromEvent({ midi: 28 }, 2), 30);
assert.equal(assistedMidiFromEvent({ midi: 127 }, 1), null);
assert.equal(assistedMidiFromEvent({ midi: 0 }, -1), null);

const assistedSampleStarts = [];
state.audioContext = {
  currentTime: 0,
  state: "running",
  createBufferSource() {
    return {
      playbackRate: { setValueAtTime(value) { this.value = value; } },
      connect(target) { this.target = target; },
      start() { assistedSampleStarts.push(this.playbackRate.value); },
      stop() {},
      disconnect() {}
    };
  },
  createGain() {
    return {
      gain: {
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
        cancelScheduledValues() {},
        setTargetAtTime() {}
      },
      connect() {},
      disconnect() {}
    };
  }
};
state.masterGain = {};
state.sampleLoadingPromise = Promise.resolve();
state.samplesFailed = false;
state.sampleBuffers.set(27, { name: "D#1" });
setAssistedMidiSet("melody", new Set([assistedMidiFromEvent({ midi: 28 })]));
assert.deepEqual([...state.assistedMidiSets.get("assist:melody")], [28]);
assert.equal(state.activeNotes.has(28), true);
assert.ok(Math.abs(assistedSampleStarts[0] - 2 ** (1 / 12)) < 1e-12);
state.activeNotes.clear();
state.assistedMidiSets.clear();
state.sampleBuffers.clear();
state.sampleLoadingPromise = null;
state.audioContext = null;
state.masterGain = null;
state.baseOctave = 4;
state.instrument = "grand-piano";

const result = await analyzeBuffer(
  { length: 44100, sampleRate: 44100, duration: 1 },
  null,
  { hopSeconds: 0.1, fftSize: 4096, smoothingRadius: 0, minSegmentSeconds: 0.1 }
);

assert.deepEqual(result, []);
assert.equal(analyserSmoothing, 0);
assert.equal(suspensionTimes.length, 10);
assert.ok(Math.abs(suspensionTimes[0] - 0.1) < 1e-9);
assert.ok(suspensionTimes.at(-1) < 1);

// When a curated chart is supplied, weak/empty analysis must preserve it
// instead of falling back to a freshly detected (and potentially noisy) list.
suspensionTimes.length = 0;
const referenceChords = [{ t: 0, n: "C" }, { t: 0.5, n: "G" }];
const preservedReference = await analyzeBuffer(
  { length: 44100, sampleRate: 44100, duration: 1 },
  null,
  {
    hopSeconds: 0.1,
    fftSize: 4096,
    referenceChords
  }
);
assert.deepEqual(preservedReference, referenceChords);
assert.equal(suspensionTimes.length, 10);

// The isolated bass branch needs a larger FFT to distinguish neighbouring
// low notes such as D2 and Dis2; it is time-aligned back onto harmony frames.
suspensionTimes.length = 0;
analyserFftSizes.length = 0;
await analyzeBuffer(
  { length: 44100, sampleRate: 44100, duration: 1 },
  null,
  {
    hopSeconds: 0.1,
    fftSize: 4096,
    referenceChords,
    bassReferenceBuffer: { length: 44100, sampleRate: 44100, duration: 1 }
  }
);
assert.deepEqual(analyserFftSizes, [4096, 8192]);
assert.equal(suspensionTimes.length, 10);

// Neutral six-stem playback is a literal sample-aligned source -> channel
// gain connection. It must not even construct delay/pitch DSP nodes.
let delayNodeCreations = 0;
let modulationBufferCreations = 0;
let biquadFilterCreations = 0;
const playbackSources = [];
const directContext = {
  currentTime: 5,
  destination: { kind: "destination" },
  createGain() {
    return {
      kind: "gain",
      gain: {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; },
        setTargetAtTime(value) { this.value = value; }
      },
      connect(target) { this.target = target; },
      disconnect() {}
    };
  },
  createBufferSource() {
    const source = {
      kind: "source",
      playbackRate: { value: 1 },
      connect(target) { this.target = target; },
      start(when, offset) { this.started = { when, offset }; },
      stop() { this.stopped = true; },
      onended: null
    };
    playbackSources.push(source);
    return source;
  },
  createBiquadFilter() {
    biquadFilterCreations += 1;
    return {
      kind: "biquad",
      type: "lowpass",
      frequency: { value: 0 },
      connect(target) { this.target = target; },
      disconnect() {}
    };
  },
  createDelay() { delayNodeCreations += 1; throw new Error("neutral playback created a delay"); },
  createBuffer() { modulationBufferCreations += 1; throw new Error("neutral playback created pitch modulation"); }
};
const stemBuffers = Object.fromEntries(
  ["bass", "drums", "guitar", "piano", "vocals", "other"].map((name) => [name, { name, duration: 10 }])
);
stemBuffers.bass.duration = 7;
stemBuffers.drums.duration = 9;
state.playbackRate = 1;
state.transpose = 0;
state.masterGain = null;
rec.ctx = directContext;
rec.buffer = stemBuffers.other;
rec.mixBuffer = null;
rec.hasStems = true;
rec.stems = stemBuffers;
rec.playing = false;
recPlayFrom(2);
assert.equal(playbackSources.length, 6);
assert.equal(rec.pitchShifters.length, 0);
assert.equal(rec.compensationNodes.length, 0);
assert.equal(rec.outputLatencySeconds, 0);
assert.equal(delayNodeCreations, 0);
assert.equal(modulationBufferCreations, 0);
assert.ok(playbackSources.every((source) => source.target?.kind === "gain"));
assert.ok(playbackSources.every((source) => source.started?.when === 5 && source.started?.offset === 2));
recStop(false);

const sourceCountBeforeNeutralMix = playbackSources.length;
rec.ctx = directContext;
rec.buffer = { name: "original-mix", duration: 10 };
rec.mixBuffer = rec.buffer;
rec.hasStems = true;
rec.stems = stemBuffers;
rec.playing = false;
recPlayFrom(1);
const neutralMixSource = playbackSources.at(-1);
assert.equal(playbackSources.length, sourceCountBeforeNeutralMix + 1);
assert.equal(rec.pitchShifter, null);
assert.equal(rec.outputLatencySeconds, 0);
assert.equal(delayNodeCreations, 0);
assert.equal(modulationBufferCreations, 0);
assert.equal(rec.directMixBypass, true);
assert.equal(neutralMixSource.target?.kind, "destination");
assert.deepEqual(neutralMixSource.started, { when: 5, offset: 1 });
assert.equal(neutralMixSource.stopped, undefined);

state.mixer.bass.volume = 0.5;
const sourceCountBeforeMixerChange = playbackSources.length;
updateMixerGains();
assert.equal(rec.directMixBypass, false);
assert.equal(playbackSources.length, sourceCountBeforeMixerChange + 6);
assert.ok(playbackSources.slice(-6).every((source) => source.target?.kind === "gain"));
assert.equal(neutralMixSource.stopped, true);
assert.equal(rec.source, null);
assert.equal(rec.gains.bass.gain.value, 0.5);
assert.equal(rec.gains.vocals.gain.value, 1);
const customMixSources = playbackSources.slice(-6);
assert.equal(customMixSources.find((source) => source.buffer === stemBuffers.bass)?.onended, null);
const completionSources = customMixSources.filter((source) => typeof source.onended === "function");
assert.equal(completionSources.length, 1);
assert.equal(completionSources[0].buffer.duration, 10);

// Mute and solo are applied to the real stem gain graph. A muted source may
// keep running for sample alignment, but its gain is exactly zero.
state.mixer.vocals.mute = true;
updateMixerGains();
assert.equal(rec.gains.vocals.gain.value, 0);
assert.equal(customMixSources.find((source) => source.buffer === stemBuffers.vocals)?.target, rec.gains.vocals);
state.mixer.guitar.solo = true;
updateMixerGains();
assert.equal(rec.gains.guitar.gain.value, 1);
assert.equal(rec.gains.bass.gain.value, 0);
assert.equal(rec.gains.drums.gain.value, 0);
assert.equal(rec.gains.piano.gain.value, 0);
assert.equal(rec.gains.vocals.gain.value, 0);
assert.equal(rec.gains.other.gain.value, 0);

state.mixer.guitar.solo = false;
updateMixerGains();
state.mixer.vocals.mute = false;
updateMixerGains();
state.mixer.bass.volume = 1;
updateMixerGains();
assert.equal(rec.directMixBypass, true);
assert.ok(customMixSources.every((source) => source.stopped === true));
assert.equal(playbackSources.at(-1).target?.kind, "destination");
recStop(false);

// If stem loading fell back to the original recording, a six-channel mixer
// operation is impossible. Muting a nominal channel must keep the one master
// source untouched instead of routing it through destructive fake EQ bands.
const legacyBuffer = { name: "legacy-original", duration: 10 };
rec.ctx = directContext;
rec.buffer = legacyBuffer;
rec.mixBuffer = legacyBuffer;
rec.hasStems = false;
rec.stems = null;
rec.playing = false;
state.mixer.vocals.mute = true;
const sourceCountBeforeLegacy = playbackSources.length;
recPlayFrom(2);
const legacySource = playbackSources.at(-1);
assert.equal(playbackSources.length, sourceCountBeforeLegacy + 1);
assert.equal(rec.directMixBypass, true);
assert.equal(legacySource.buffer, legacyBuffer);
assert.equal(legacySource.target?.kind, "destination");
assert.equal(biquadFilterCreations, 0);
updateMixerGains();
assert.equal(playbackSources.length, sourceCountBeforeLegacy + 1);
assert.equal(legacySource.stopped, undefined);
state.mixer.vocals.mute = false;
recStop(false);

// A partial stem response cannot reconstruct the song. It must also stay on
// the complete master instead of replacing it with one isolated buffer.
rec.ctx = directContext;
rec.buffer = legacyBuffer;
rec.mixBuffer = legacyBuffer;
rec.hasStems = true;
rec.stems = { vocals: stemBuffers.vocals };
rec.playing = false;
state.mixer.vocals.mute = true;
const sourceCountBeforePartial = playbackSources.length;
recPlayFrom(2.5);
assert.equal(playbackSources.length, sourceCountBeforePartial + 1);
assert.equal(rec.directMixBypass, true);
assert.equal(playbackSources.at(-1).buffer, legacyBuffer);
assert.equal(playbackSources.at(-1).target?.kind, "destination");
state.mixer.vocals.mute = false;
recStop(false);

// With pitch/rate compensation active, every pitched stem shares one shifter
// (one modulation phase), drums receive the matching mean delay, and the
// audible playhead starts after that common latency.
const shiftedSources = [];
let shiftedDelayCreations = 0;
const makeNode = (kind) => ({
  kind,
  connect(target) { this.target = target; },
  disconnect() {}
});
const shiftedContext = {
  currentTime: 7,
  sampleRate: 44100,
  destination: { kind: "destination" },
  createGain() {
    return Object.assign(makeNode("gain"), { gain: { value: 1, setTargetAtTime() {} } });
  },
  createDelay() {
    shiftedDelayCreations += 1;
    return Object.assign(makeNode("delay"), { delayTime: { value: 0 } });
  },
  createChannelSplitter() { return makeNode("splitter"); },
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { kind: "modulation", getChannelData(channel) { return data[channel]; } };
  },
  createBufferSource() {
    const source = Object.assign(makeNode("source"), {
      playbackRate: { value: 1 },
      loop: false,
      start(when, offset) { this.started = { when, offset }; },
      stop() {},
      onended: null
    });
    shiftedSources.push(source);
    return source;
  }
};
state.playbackRate = 0.75;
state.transpose = 0;
rec.ctx = shiftedContext;
rec.buffer = stemBuffers.other;
rec.hasStems = true;
rec.stems = stemBuffers;
rec.playing = false;
state.mixer.piano.mute = true;
recPlayFrom(3);
const shiftedStemSources = shiftedSources.filter((source) => Object.values(stemBuffers).includes(source.buffer));
assert.equal(shiftedStemSources.length, 6);
assert.equal(rec.pitchShifters.length, 1);
assert.equal(rec.compensationNodes.length, 1);
assert.equal(shiftedDelayCreations, 3); // two modulated shifter delays + one drum alignment delay
assert.equal(rec.outputLatencySeconds, 0.025);
assert.equal(rec.startedAt, 7.025);
assert.ok(shiftedStemSources.every((source) => source.started?.when === 7 && source.started?.offset === 3));
assert.equal(rec.gains.piano.gain.value, 0);
assert.equal(shiftedStemSources.find((source) => source.buffer === stemBuffers.piano)?.target, rec.gains.piano);
assert.equal(rec.gains.vocals.gain.value, 1);
state.mixer.piano.mute = false;
recStop(false);

// Seeking while paused must update the edit/playhead clock synchronously. The
// chart can add a chord immediately, before recLoad's promise callback runs.
state.repertoire = [{ id: "seek-song" }];
state.selectedSongId = "seek-song";
rec.buffer = { duration: 10 };
rec.bufferId = "song-seek-song";
rec.playing = false;
rec.offset = 0;
const pausedSeek = recSeek(4.375);
assert.equal(rec.offset, 4.375);
assert.equal(recTime(), 4.375);
assert.equal(await pausedSeek, true);
assert.equal(rec.offset, 4.375);
assert.equal(recTime(), 4.375);

// A paused target is authoritative while a real asynchronous fetch/decode is
// pending, and the successful load must retain that exact target.
const originalFetch = globalThis.fetch;
const asyncSeekContext = {
  ...shiftedContext,
  state: "running",
  decodeAudioData: async () => ({ duration: 12 })
};
state.audioContext = asyncSeekContext;
state.samplesFailed = true;
invalidateRecLoad();
state.repertoire = [{ id: "async-seek-song", assets: { mix: "/mock-async-success.mp3" } }];
state.selectedSongId = "async-seek-song";
rec.buffer = null;
rec.bufferId = null;
rec.playing = false;
rec.offset = 0;
const successfulFetch = createDeferred();
globalThis.fetch = () => successfulFetch.promise;
const asyncSuccessfulSeek = recSeek(5.625);
assert.equal(recTime(), 5.625);
successfulFetch.resolve({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(8)
});
assert.equal(await asyncSuccessfulSeek, true);
assert.equal(recTime(), 5.625);

// A failed asynchronous fetch/storage fallback cannot restore the old paused
// offset. The edit cursor stays at the synchronously requested target.
invalidateRecLoad();
state.repertoire = [{ id: "async-failed-seek-song", assets: { mix: "/mock-async-failure.mp3" } }];
state.selectedSongId = "async-failed-seek-song";
rec.buffer = null;
rec.bufferId = null;
rec.playing = false;
rec.offset = 1;
const failedFetch = createDeferred();
globalThis.fetch = () => failedFetch.promise;
const asyncFailedSeek = recSeek(7.75);
assert.equal(recTime(), 7.75);
failedFetch.reject(new Error("mock fetch failure"));
assert.equal(await asyncFailedSeek, false);
assert.equal(recTime(), 7.75);

// Multiple paused seeks share the in-flight load, but only the newest request
// may apply after it resolves. An older continuation must never snap back.
invalidateRecLoad();
state.repertoire = [{ id: "rapid-seek-song", assets: { mix: "/mock-rapid-success.mp3" } }];
state.selectedSongId = "rapid-seek-song";
rec.buffer = null;
rec.bufferId = null;
rec.playing = false;
rec.offset = 0;
const rapidFetch = createDeferred();
globalThis.fetch = () => rapidFetch.promise;
const firstRapidSeek = recSeek(2.25);
assert.equal(recTime(), 2.25);
const lastRapidSeek = recSeek(9.125);
assert.equal(recTime(), 9.125);
rapidFetch.resolve({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(8)
});
assert.deepEqual(await Promise.all([firstRapidSeek, lastRapidSeek]), [false, true]);
assert.equal(recTime(), 9.125);
globalThis.fetch = originalFetch;

// A playing seek is an atomic transport restart. Observers must never receive
// the internal recStop(false) state (paused at 0:00) between the old source and
// the source restarted at the requested position.
state.playbackRate = 1;
state.transpose = 0;
rec.ctx = directContext;
rec.mixBuffer = rec.buffer;
rec.hasStems = false;
rec.stems = null;
recPlayFrom(1);
recUpdateSnapshots.length = 0;
globalThis.__captureRecUpdates = true;
const playingSeek = recSeek(5.625);
globalThis.__captureRecUpdates = false;
assert.equal(await playingSeek, true);
assert.equal(rec.playing, true);
assert.equal(rec.offset, 5.625);
assert.equal(recTime(), 5.625);
assert.deepEqual(recUpdateSnapshots, [{ playing: true, offset: 5.625 }]);
recStop(false);

// Even if loading cannot start, the requested paused cursor is retained rather
// than silently snapping back to zero.
state.repertoire = [];
state.selectedSongId = null;
rec.buffer = null;
rec.bufferId = null;
rec.offset = 0;
const unavailableSeek = recSeek(6.25);
assert.equal(rec.offset, 6.25);
assert.equal(await unavailableSeek, false);
assert.equal(rec.offset, 6.25);

// A rejected storage load is handled as an unavailable transport and leaves
// the synchronously requested edit cursor intact.
state.repertoire = [{ id: "rejected-seek-song" }];
state.selectedSongId = "rejected-seek-song";
state.audioContext = shiftedContext;
state.samplesFailed = true;
rec.offset = 0;
const rejectedSeek = recSeek(7.75);
assert.equal(rec.offset, 7.75);
assert.equal(await rejectedSeek, false);
assert.equal(rec.offset, 7.75);

console.log("audio-analysis tests passed");
