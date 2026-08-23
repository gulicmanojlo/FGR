import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../js/chord-analysis.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  buildChordTimeline,
  centerAnalysisFrameTime,
  chordChartFingerprint,
  detectChordFromChroma,
  findActiveChordIndex,
  needsBundledChordChartUpgrade,
  normalizeChromaFrame,
  parseKeySignature,
  refineChordBoundaries
} = await import(moduleUrl);

const bundledPlaylist = JSON.parse(await readFile(new URL("./fixtures/bundled-playlist.json", import.meta.url), "utf8"));
const bundledLuis = bundledPlaylist.songs.find((song) => song.id === "luis-sve-se-osim-tuge-deli");
assert.equal(bundledLuis.chordChartRevision, 2);
assert.equal(bundledLuis.chords.length, 63);
assert.equal(chordChartFingerprint(bundledLuis.chords), "afcf8636");
assert.deepEqual(bundledLuis.chords.slice(0, 4), [
  { t: 4.8, n: "Dm" },
  { t: 6.641, n: "Dis" },
  { t: 8.754, n: "Gm" },
  { t: 12.341, n: "Dm" }
]);
const legacyLuisTimes = [
  4.8, 6.807, 10, 12.3, 15.207, 17.3, 19.407, 20.807, 28.607, 29.807,
  32.3, 34.007, 36.507, 38.207, 41.5, 43.5, 44.507, 46.607, 57.3, 59.307,
  61.3, 62.8, 63.8, 64.8, 74, 76.007, 77.007, 78.8, 80.5, 86.707,
  90.307, 95.3, 97.307, 98.707, 107.007, 107.707, 110, 112.007, 114.407, 116.3,
  119.5, 121.3, 122.507, 124.607, 135, 138.3, 143, 152.3, 156, 157,
  158.8, 164.5, 165.8, 168.207, 175.007, 176.407, 185.5, 190.3, 193, 202.5,
  205.8, 207, 212.5
];
const legacyLuis = {
  ...bundledLuis,
  chordChartRevision: 0,
  chords: bundledLuis.chords.map((chord, index) => ({ ...chord, t: legacyLuisTimes[index] }))
};
assert.equal(chordChartFingerprint(legacyLuis.chords), "f5d64535");
assert.equal(needsBundledChordChartUpgrade(legacyLuis, {
  songId: "luis-sve-se-osim-tuge-deli",
  targetRevision: 2,
  legacyFingerprints: ["f5d64535"]
}), true);
assert.equal(needsBundledChordChartUpgrade(bundledLuis, {
  songId: "luis-sve-se-osim-tuge-deli",
  targetRevision: 2,
  legacyFingerprints: ["f5d64535"]
}), false);

const chroma = (...pitchClasses) => {
  const values = new Array(12).fill(0.01);
  pitchClasses.forEach((pitchClass, index) => { values[pitchClass] = 1 - index * 0.08; });
  return values;
};

assert.equal(detectChordFromChroma(chroma(0, 4, 7))?.name, "C");
assert.equal(detectChordFromChroma(chroma(9, 0, 4))?.name, "Am");
assert.equal(detectChordFromChroma(chroma(0, 4, 7, 11), { simpleChart: true })?.name, "C");
assert.equal(detectChordFromChroma(new Array(12).fill(0)), null);
assert.equal(normalizeChromaFrame(chroma(2, 5, 9)).length, 12);
assert.deepEqual(parseKeySignature("Gis mol"), { keyPitchClass: 8, keyMode: "minor" });
assert.deepEqual(parseKeySignature("C#m"), { keyPitchClass: 1, keyMode: "minor" });
assert.deepEqual(parseKeySignature("Bbm"), { keyPitchClass: 10, keyMode: "minor" });
assert.ok(Math.abs(centerAnalysisFrameTime(1, 4096, 44100) - 0.95356009) < 1e-8);

const frames = [];
for (let t = 0.25; t <= 2; t += 0.25) frames.push({ t, chroma: chroma(0, 4, 7) });
frames.push({ t: 2.25, chroma: chroma(1, 5, 8) });
for (let t = 2.5; t <= 4.5; t += 0.25) frames.push({ t, chroma: chroma(7, 11, 2) });
const timeline = buildChordTimeline(frames, { minSegmentSeconds: 0.75 });
assert.deepEqual(timeline.map((entry) => entry.n), ["C", "G"]);

// Frame timestamps represent analysis-window centres. A clean change between
// the centres at 0.95 and 1.05 seconds must land exactly at 1.000, not at the
// first new frame or a complete hop before it.
const exactTransitionFrames = [];
for (let index = 0; index < 20; index += 1) {
  exactTransitionFrames.push({
    t: 0.05 + index * 0.1,
    chord: index < 10 ? "C" : "G",
    confidence: 0.95
  });
}
const exactTimeline = buildChordTimeline(exactTransitionFrames, {
  minSegmentSeconds: 0.2,
  smoothingRadius: 0
});
assert.deepEqual(exactTimeline.map(({ t, n }) => ({ t, n })), [
  { t: 0, n: "C" },
  { t: 1, n: "G" }
]);

// Preserve sub-tenth timing. The former 0.1 s rounding changed 1.235 to 1.2.
const precisionTimeline = buildChordTimeline([
  { t: 1.11, chord: "Am", confidence: 0.9 },
  { t: 1.16, chord: "Am", confidence: 0.9 },
  { t: 1.21, chord: "Am", confidence: 0.9 },
  { t: 1.26, chord: "F", confidence: 0.9 },
  { t: 1.31, chord: "F", confidence: 0.9 },
  { t: 1.36, chord: "F", confidence: 0.9 }
], { minSegmentSeconds: 0.1, smoothingRadius: 0 });
assert.equal(precisionTimeline[1].t, 1.235);

// A single uncertain frame at a transition is split between its stable
// neighbours; it must not move the entire gap onto one side.
const uncertainTransition = buildChordTimeline([
  { t: 0.75, chord: "C", confidence: 0.9 },
  { t: 0.85, chord: "C", confidence: 0.9 },
  { t: 0.95, chord: "C", confidence: 0.9 },
  { t: 1.05, chord: null, confidence: 0 },
  { t: 1.15, chord: "G", confidence: 0.9 },
  { t: 1.25, chord: "G", confidence: 0.9 },
  { t: 1.35, chord: "G", confidence: 0.9 }
], { minSegmentSeconds: 0.25, smoothingRadius: 0 });
assert.equal(uncertainTransition[1].t, 1.05);

// Preserve a real half-second passing chord while still rejecting a lone
// 100 ms label glitch.
const shortMusicalChangeFrames = [];
for (let index = 0; index < 25; index += 1) {
  shortMusicalChangeFrames.push({
    t: 0.05 + index * 0.1,
    chord: index < 10 ? "C" : index < 15 ? "F" : "G",
    confidence: 0.92
  });
}
assert.deepEqual(
  buildChordTimeline(shortMusicalChangeFrames, { minSegmentSeconds: 0.45, smoothingRadius: 0 })
    .map((entry) => entry.n),
  ["C", "F", "G"]
);

const glitchFrames = shortMusicalChangeFrames.map((frame, index) => ({
  ...frame,
  chord: index < 10 ? "C" : index === 10 ? "F" : "G"
}));
assert.deepEqual(
  buildChordTimeline(glitchFrames, { minSegmentSeconds: 0.45, smoothingRadius: 0 })
    .map((entry) => entry.n),
  ["C", "G"]
);

// Playback selection changes on the boundary, with an optional measured
// per-song offset for legacy charts.
const playbackChart = [{ t: 0, n: "C" }, { t: 1, n: "G" }, { t: 2, n: "Am" }];
assert.equal(findActiveChordIndex(playbackChart, 0.999), 0);
assert.equal(findActiveChordIndex(playbackChart, 1), 1);
assert.equal(findActiveChordIndex(playbackChart, 1.099, { timingOffsetSeconds: 0.1 }), 0);
assert.equal(findActiveChordIndex(playbackChart, 1.1, { timingOffsetSeconds: 0.1 }), 1);

// Refinement is deliberately conservative: it may move only the timestamps,
// never the curated chord names or their order. A reference boundary that is
// 300 ms late is snapped to the midpoint between the last C-centred frame and
// the first G-centred frame.
const transitionChromaFrames = [];
for (let index = 0; index < 20; index += 1) {
  transitionChromaFrames.push({
    t: 0.05 + index * 0.1,
    chroma: index < 10 ? chroma(0, 4, 7) : chroma(7, 11, 2),
    bassChroma: index < 10 ? chroma(0) : chroma(7)
  });
}
const lateReferenceChart = [
  { t: 0, n: "C", section: "uvod" },
  { t: 1.3, n: "G", section: "uvod" }
];
const refinedChart = refineChordBoundaries(transitionChromaFrames, lateReferenceChart, {
  refinementWindowSeconds: 0.6,
  evidenceWindowSeconds: 0.55
});
assert.deepEqual(refinedChart.map(({ t, n }) => ({ t, n })), [
  { t: 0, n: "C" },
  { t: 1, n: "G" }
]);
assert.deepEqual(refinedChart.map((entry) => entry.section), ["uvod", "uvod"]);

// With no harmonic change there is no pairwise evidence, so an existing
// boundary remains exactly where the user placed it.
const ambiguousFrames = transitionChromaFrames.map((frame) => ({
  ...frame,
  chroma: chroma(0, 4, 7),
  bassChroma: chroma(0)
}));
assert.equal(
  refineChordBoundaries(ambiguousFrames, lateReferenceChart, {
    refinementWindowSeconds: 0.6,
    evidenceWindowSeconds: 0.55
  })[1].t,
  1.3
);

// G minor and Dis major share G and B. With only those shared harmonic tones
// the boundary is ambiguous; a dedicated bass root must resolve G -> Dis and
// may correct a substantially late legacy timestamp.
const sharedHarmonyFrames = [];
for (let index = 0; index < 40; index += 1) {
  sharedHarmonyFrames.push({
    t: 0.05 + index * 0.1,
    chroma: chroma(7, 10),
    bassChroma: index < 12 ? chroma(7) : chroma(3)
  });
}
const bassResolvedChart = refineChordBoundaries(
  sharedHarmonyFrames,
  [{ t: 0, n: "Gm" }, { t: 3, n: "Dis" }],
  { refinementWindowSeconds: 2.5, evidenceWindowSeconds: 0.7 }
);
assert.deepEqual(bassResolvedChart, [{ t: 0, n: "Gm" }, { t: 1.2, n: "Dis" }]);

const mislabeledMiddleFrames = [];
for (let index = 0; index < 30; index += 1) {
  const time = 0.05 + index * 0.1;
  const isFirst = time < 1;
  const isMiddle = time >= 1 && time < 2;
  mislabeledMiddleFrames.push({
    t: time,
    chroma: isFirst ? chroma(0, 4, 7) : isMiddle ? chroma(7, 10, 2) : chroma(2, 5, 9),
    bassChroma: isFirst ? chroma(0) : isMiddle ? chroma(7) : chroma(2)
  });
}
const correctedLabelChart = refineChordBoundaries(
  mislabeledMiddleFrames,
  [{ t: 0, n: "C" }, { t: 1, n: "Dis" }, { t: 2, n: "Dm" }],
  {
    refinementWindowSeconds: 0.4,
    evidenceWindowSeconds: 0.45,
    allowLabelCorrection: true
  }
);
assert.deepEqual(correctedLabelChart.map((entry) => entry.n), ["C", "Gm", "Dm"]);

const duplicateWrongSegmentFrames = mislabeledMiddleFrames.map((frame) =>
  frame.t < 1
    ? { ...frame, chroma: chroma(7, 10, 2), bassChroma: chroma(7) }
    : frame
);
const collapsedCorrection = refineChordBoundaries(
  duplicateWrongSegmentFrames,
  [{ t: 0, n: "Gm" }, { t: 1, n: "Dis" }, { t: 2, n: "Dm" }],
  {
    refinementWindowSeconds: 0.4,
    evidenceWindowSeconds: 0.45,
    allowLabelCorrection: true
  }
);
assert.deepEqual(collapsedCorrection.map(({ t, n }) => ({ t, n })), [
  { t: 0, n: "Gm" },
  { t: 2, n: "Dm" }
]);

console.log("chord-analysis tests passed");
