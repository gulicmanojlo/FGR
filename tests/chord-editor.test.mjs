import assert from "node:assert/strict";
import {
  chordPreviewMidis,
  chordSegmentGeometry,
  diatonicChordNames,
  editChordSegment,
  normalizeChordSymbol,
  rankChordSuggestions,
  resolveChordEndTime,
  splitChordSegment,
  upsertChordAtTime
} from "../js/chord-editor.js";

assert.equal(normalizeChordSymbol("  Am "), "Am");
assert.equal(normalizeChordSymbol("F#m7"), "Fism7");
assert.equal(normalizeChordSymbol("Bbmaj7"), "Bmaj7");
assert.equal(normalizeChordSymbol("Dm/F"), "Dm/F");
assert.equal(normalizeChordSymbol("nije-akord"), "");

assert.deepEqual(chordPreviewMidis("Am", 48), [57, 60, 64]);
assert.deepEqual(chordPreviewMidis("D7", 48), [50, 54, 57, 60]);
assert.deepEqual(chordPreviewMidis("C/E", 48), [40, 48, 52, 55]);

assert.deepEqual(diatonicChordNames("Amol").slice(0, 7), ["Am", "Hdim", "C", "Dm", "Em", "F", "G"]);
assert.deepEqual(diatonicChordNames("Cdur").slice(0, 7), ["C", "Dm", "Em", "F", "G", "Am", "Hdim"]);

const chart = [
  { t: 0, n: "Am" },
  { t: 2, n: "F" },
  { t: 4, n: "G" },
  { t: 6, n: "Am" }
];
const ranked = rankChordSuggestions({ key: "Amol", chords: chart, index: 1, currentName: "F" });
assert.deepEqual(ranked.slice(0, 3).map((entry) => entry.name), ["F", "Am", "G"]);
assert.equal(ranked.find((entry) => entry.name === "Dm")?.group, "U tonalitetu");
assert.deepEqual(
  rankChordSuggestions({ key: "Amol", chords: chart, index: 1, query: "Fis", limit: 4 }).map((entry) => entry.name),
  ["Fis", "Fis6", "Fis7", "Fis9"]
);

const replacedBoundary = upsertChordAtTime(chart, "D7", 2.03, 0.05);
assert.equal(replacedBoundary.replaced, true);
assert.equal(replacedBoundary.chords.length, chart.length);
assert.deepEqual(replacedBoundary.chords[1], { t: 2, n: "D7" });

const insertedBoundary = upsertChordAtTime(chart, "Em", 3, 0.05);
assert.equal(insertedBoundary.replaced, false);
assert.deepEqual(insertedBoundary.chords.map((chord) => chord.t), [0, 2, 3, 4, 6]);

assert.deepEqual(chordSegmentGeometry(chart, 0, 10, 20), {
  start: 0,
  end: 2,
  duration: 2,
  left: 0,
  width: 40,
  canResizeLeft: true,
  canResizeRight: true,
  rightBoundaryIndex: 1,
  usesTerminalEnd: false
});
assert.deepEqual(chordSegmentGeometry(chart, 2, 10, 20), {
  start: 4,
  end: 6,
  duration: 2,
  left: 80,
  width: 40,
  canResizeLeft: true,
  canResizeRight: true,
  rightBoundaryIndex: 3,
  usesTerminalEnd: false
});
assert.deepEqual(chordSegmentGeometry(chart, 3, 10, 20), {
  start: 6,
  end: 10,
  duration: 4,
  left: 120,
  width: 80,
  canResizeLeft: true,
  canResizeRight: true,
  rightBoundaryIndex: null,
  usesTerminalEnd: true
});

assert.equal(resolveChordEndTime(chart, 10), 10);
assert.equal(resolveChordEndTime([{ t: 0, n: "C" }], 10, null), 10);
assert.equal(resolveChordEndTime(chart, 10, 9), 9);
assert.equal(chordSegmentGeometry(chart, 3, 10, 20, 9).end, 9);

const moved = editChordSegment(chart, 1, "move", 1, { duration: 10 });
assert.deepEqual(moved.chords.map((chord) => chord.t), [0, 3, 5, 6]);
assert.equal(moved.chords[2].t - moved.chords[1].t, 2);
assert.equal(moved.appliedDelta, 1);

const resizedLeft = editChordSegment(chart, 1, "left", 0.5, { duration: 10 });
assert.deepEqual(resizedLeft.chords.map((chord) => chord.t), [0, 2.5, 4, 6]);

const resizedRight = editChordSegment(chart, 1, "right", 0.5, { duration: 10 });
assert.deepEqual(resizedRight.chords.map((chord) => chord.t), [0, 2, 4.5, 6]);

const resizedLast = editChordSegment(chart, 3, "right", -1, { duration: 10 });
assert.equal(resizedLast.chordEndTime, 9);
assert.equal(resizedLast.chords[3].t, 6);
const expandedLast = editChordSegment(chart, 3, "right", 3, { duration: 10, chordEndTime: 8 });
assert.equal(expandedLast.chordEndTime, 10);

const movedLast = editChordSegment(chart, 3, "move", -1, { duration: 10 });
assert.equal(movedLast.chords[3].t, 5);
assert.equal(movedLast.chordEndTime, 9);
assert.equal(movedLast.chordEndTime - movedLast.chords[3].t, 4);

const clampedMove = editChordSegment(chart, 1, "move", 99, { duration: 10, minimumGap: 0.05 });
assert.equal(clampedMove.chords[2].t, 5.95);
assert.equal(clampedMove.chords[2].t - clampedMove.chords[1].t, 2);

// Split u sredini segmenta zadržava naziv u obe polovine.
const split = splitChordSegment(chart, 1, 3, { duration: 10 });
assert.equal(split.changed, true);
assert.equal(split.newIndex, 2);
assert.deepEqual(split.chords.map((chord) => chord.t), [0, 2, 3, 4, 6]);
assert.equal(split.chords[2].n, "F");
assert.equal(split.chords[1].n, "F");

// Split sa novim imenom menja samo drugu polovinu (insert od plejheda).
const replacedTail = splitChordSegment(chart, 1, 2.8, { duration: 10, name: "Dm" });
assert.equal(replacedTail.changed, true);
assert.deepEqual(replacedTail.chords[2], { t: 2.8, n: "Dm" });
assert.equal(replacedTail.chords[1].n, "F");
assert.equal(replacedTail.chords[3].t, 4);

// Tačka podele se steže unutar segmenta (minimalni razmak sa obe strane).
const clampedSplit = splitChordSegment(chart, 1, 0, { duration: 10, minimumGap: 0.1 });
assert.equal(clampedSplit.changed, true);
assert.equal(clampedSplit.chords[2].t, 2.1);
const clampedSplitHigh = splitChordSegment(chart, 1, 99, { duration: 10, minimumGap: 0.1 });
assert.equal(clampedSplitHigh.chords[2].t, 3.9);

// Poslednji segment koristi chordEndTime/duration kao kraj.
const splitLast = splitChordSegment(chart, 3, 8, { duration: 10 });
assert.equal(splitLast.changed, true);
assert.deepEqual(splitLast.chords.map((chord) => chord.t), [0, 2, 4, 6, 8]);
assert.equal(splitLast.chords[4].n, "Am");

// Prekratak segment i nevažeći indeks ostaju nepromenjeni.
const tooShort = splitChordSegment([{ t: 0, n: "C" }, { t: 0.08, n: "G" }], 0, 0.04, { duration: 10 });
assert.equal(tooShort.changed, false);
assert.equal(tooShort.chords.length, 2);
assert.equal(splitChordSegment(chart, 9, 3, { duration: 10 }).changed, false);

console.log("chord-editor tests passed");
