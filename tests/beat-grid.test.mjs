import assert from "node:assert/strict";
import {
  applyGridOverride,
  barPositionAt,
  beatIndexAt,
  beatPositionAt,
  getDownbeats,
  gridAlignmentReport,
  hasUsableBeats,
  isDownbeatIndex,
  nearestBeat,
  normalizeBeatGrid,
  quantizeTime,
  timeAtBeatPosition
} from "../js/beat-grid.js";

function steadyGrid({ bpm = 120, count = 32, start = 0, beatsPerBar = 4, downbeatIndex = 0 } = {}) {
  const step = 60 / bpm;
  return normalizeBeatGrid({
    status: "ready",
    meterStatus: "ready",
    bpm,
    beatsPerBar,
    downbeatIndex,
    beats: Array.from({ length: count }, (_, index) => start + index * step),
    confidence: 0.9
  });
}

// --- normalizacija -----------------------------------------------------

const grid = steadyGrid();
assert.equal(grid.beats.length, 32);
assert.equal(grid.beatsPerBar, 4);
assert.ok(Math.abs(grid.medianInterval - 0.5) < 1e-9);
assert.ok(hasUsableBeats(grid));

// Nesortirani, negativni i duplirani bitovi se popravljaju.
const messy = normalizeBeatGrid({ beats: [1.0, 0.5, -2, 1.0, 2.0, "x", null, 1.5] });
assert.deepEqual(messy.beats, [1.0, 2.0]);

// Mreža bez upotrebljivog pulsa ne postoji.
assert.equal(normalizeBeatGrid({ beats: [1.0] }), null);
assert.equal(normalizeBeatGrid(null), null);
assert.equal(normalizeBeatGrid([1, 2, 3]), null);
assert.equal(hasUsableBeats(null), false);

// Takt i faza se svode u dozvoljen opseg.
assert.equal(normalizeBeatGrid({ beats: [0, 1, 2], beatsPerBar: 99 }).beatsPerBar, 16);
assert.equal(normalizeBeatGrid({ beats: [0, 1, 2], beatsPerBar: 1 }).beatsPerBar, 2);
assert.equal(normalizeBeatGrid({ beats: [0, 1, 2], beatsPerBar: 4, downbeatIndex: 9 }).downbeatIndex, 1);
assert.equal(normalizeBeatGrid({ beats: [0, 1, 2], beatsPerBar: 4, downbeatIndex: -1 }).downbeatIndex, 3);

// BPM se izvodi iz bitova kada ga izvor nije poslao.
assert.ok(Math.abs(normalizeBeatGrid({ beats: [0, 0.5, 1.0, 1.5] }).bpm - 120) < 1e-9);

// --- taktovi -----------------------------------------------------------

assert.deepEqual(getDownbeats(steadyGrid({ count: 9 })), [0, 2, 4]);
assert.deepEqual(getDownbeats(steadyGrid({ count: 9, downbeatIndex: 1 })), [0.5, 2.5]);
assert.deepEqual(getDownbeats(steadyGrid({ count: 9, beatsPerBar: 3 })), [0, 1.5, 3]);
assert.deepEqual(getDownbeats(null), []);

// --- pretraga bita -----------------------------------------------------

assert.equal(beatIndexAt(grid, -1), -1, "pre prvog bita nema indeksa");
assert.equal(beatIndexAt(grid, 0), 0);
assert.equal(beatIndexAt(grid, 0.49), 0, "bit traje do sledećeg");
assert.equal(beatIndexAt(grid, 0.5), 1, "tačno na bitu pripada tom bitu");
assert.equal(beatIndexAt(grid, 100), 31, "posle mreže se drži poslednji bit");

const near = nearestBeat(grid, 0.62);
assert.equal(near.index, 1);
assert.ok(Math.abs(near.delta - -0.12) < 1e-9, "delta je pozitivna kada je bit posle vremena");
assert.equal(nearestBeat(grid, 0.76).index, 2);
assert.equal(nearestBeat(grid, -5).index, 0, "pre mreže se vraća prvi bit");
assert.equal(nearestBeat(null, 1), null);

// --- pozicija u bitovima i inverzija -----------------------------------

assert.ok(Math.abs(beatPositionAt(grid, 1.25) - 2.5) < 1e-9);
assert.ok(Math.abs(timeAtBeatPosition(grid, 2.5) - 1.25) < 1e-9);
// Ekstrapolacija van izmerene mreže mora ostati monotona u oba smera.
assert.ok(beatPositionAt(grid, -0.5) < 0);
assert.ok(Math.abs(timeAtBeatPosition(grid, -2) - -1) < 1e-9);
assert.ok(timeAtBeatPosition(grid, 40) > grid.beats[31]);
for (const seconds of [0, 0.37, 1.25, 7.9, 15.5]) {
  assert.ok(
    Math.abs(timeAtBeatPosition(grid, beatPositionAt(grid, seconds)) - seconds) < 1e-9,
    `povratna konverzija za ${seconds} s`
  );
}

// Nejednaki intervali: pozicija se interpolira unutar stvarnog bita.
const rubato = normalizeBeatGrid({ beats: [0, 1, 1.5, 3.5], beatsPerBar: 4 });
assert.ok(Math.abs(beatPositionAt(rubato, 1.25) - 1.5) < 1e-9);
assert.ok(Math.abs(beatPositionAt(rubato, 2.5) - 2.5) < 1e-9);

// --- kvantizacija ------------------------------------------------------

assert.ok(Math.abs(quantizeTime(grid, 0.53, 1) - 0.5) < 1e-9, "četvrtina");
assert.ok(Math.abs(quantizeTime(grid, 0.71, 2) - 0.75) < 1e-9, "osmina");
assert.ok(Math.abs(quantizeTime(grid, 0.69, 4) - 0.75) < 1e-9, "šesnaestina");
// maxShift čuva fraziranje: nota daleko od mreže ostaje gde jeste.
assert.ok(Math.abs(quantizeTime(grid, 0.68, 1, 0.05) - 0.68) < 1e-9);
assert.ok(Math.abs(quantizeTime(grid, 0.52, 1, 0.05) - 0.5) < 1e-9);
assert.ok(Math.abs(quantizeTime(null, 1.234, 2) - 1.234) < 1e-9, "bez mreže vreme ostaje netaknuto");

// --- takt i doba -------------------------------------------------------

assert.deepEqual(barPositionAt(grid, 0), { bar: 1, beat: 1, beatIndex: 0, isDownbeat: true });
assert.deepEqual(barPositionAt(grid, 1.2), { bar: 1, beat: 3, beatIndex: 2, isDownbeat: false });
assert.deepEqual(barPositionAt(grid, 2.0), { bar: 2, beat: 1, beatIndex: 4, isDownbeat: true });
assert.equal(barPositionAt(grid, -1), null);

const offsetGrid = steadyGrid({ downbeatIndex: 2 });
assert.equal(barPositionAt(offsetGrid, 1.0).isDownbeat, true, "faza pomera prvu dobu");
assert.equal(barPositionAt(offsetGrid, 0).isDownbeat, false);
assert.equal(isDownbeatIndex(offsetGrid, 2), true);
assert.equal(isDownbeatIndex(offsetGrid, 6), true);
assert.equal(isDownbeatIndex(offsetGrid, 3), false);
assert.equal(isDownbeatIndex(offsetGrid, 0), false, "pre prve dobe nema takta");

// --- merenje poravnanja ------------------------------------------------

const perfect = gridAlignmentReport(grid, [0, 0.5, 1.0, 1.5]);
assert.equal(perfect.count, 4);
assert.equal(perfect.withinTolerance, 4);
assert.equal(perfect.ratio, 1);

const drifting = gridAlignmentReport(grid, [0.12, 0.62, 1.12, 1.51], 0.05);
assert.equal(drifting.withinTolerance, 1);
assert.ok(Math.abs(drifting.medianOffset - 0.12) < 1e-9);
assert.ok(Math.abs(drifting.maxOffset - 0.12) < 1e-9);

// Prihvata i sirove akorde iz playliste ({t, n}) i običan niz brojeva.
assert.equal(gridAlignmentReport(grid, [{ t: 0.5, n: "C" }, { t: 1.0, n: "G" }]).ratio, 1);
assert.equal(gridAlignmentReport(null, [0.5]).count, 0);
assert.equal(gridAlignmentReport(grid, []).count, 0);

// --- ručno podešavanje mreže -------------------------------------------

{
  const auto = normalizeBeatGrid({
    status: "ready", meterStatus: "uncertain", bpm: 120, beatsPerBar: 3, downbeatIndex: 1,
    beats: Array.from({ length: 32 }, (_, i) => i * 0.5)
  });
  assert.equal(auto.meterStatus, "uncertain");

  // Korisnik tvrdi 4/4 -> mreža postaje sigurna.
  const forced = applyGridOverride(auto, { beatsPerBar: 4 });
  assert.equal(forced.beatsPerBar, 4);
  assert.equal(forced.meterStatus, "ready", "korisnikova tvrdnja uklanja nesigurnost");
  assert.equal(forced.overridden, true);
  assert.deepEqual(getDownbeats(forced).slice(0, 3), [0.5, 2.5, 4.5]);

  // Bez podešavanja se mreža ne dira.
  assert.equal(applyGridOverride(auto, {}), auto);
  assert.equal(applyGridOverride(auto, null), auto);
  assert.equal(applyGridOverride(null, { beatsPerBar: 4 }), null);
}

{
  // Duplo sporije brojanje: svaki drugi puls, upola manji BPM.
  const auto = normalizeBeatGrid({
    status: "ready", bpm: 152, beatsPerBar: 4, beats: Array.from({ length: 32 }, (_, i) => i * 0.395)
  });
  const halved = applyGridOverride(auto, { tempoScale: 0.5 });
  assert.equal(halved.beats.length, 16);
  assert.ok(Math.abs(halved.bpm - 76) < 0.5, `76 BPM, dobijeno ${halved.bpm.toFixed(1)}`);

  // Duplo brže: puls između svaka dva.
  const doubled = applyGridOverride(auto, { tempoScale: 2 });
  assert.equal(doubled.beats.length, 63);
  assert.ok(Math.abs(doubled.bpm - 304) < 2, `304 BPM, dobijeno ${doubled.bpm.toFixed(1)}`);
}

{
  // Pomeranje prve dobe menja gde počinju taktovi, a ne same bitove.
  const auto = normalizeBeatGrid({
    status: "ready", meterStatus: "ready", bpm: 120, beatsPerBar: 4, downbeatIndex: 0,
    beats: Array.from({ length: 32 }, (_, i) => i * 0.5)
  });
  const shifted = applyGridOverride(auto, { phaseOffset: 1 });
  assert.equal(shifted.downbeatIndex, 1);
  assert.deepEqual(shifted.beats, auto.beats, "bitovi ostaju isti");
  assert.deepEqual(getDownbeats(shifted).slice(0, 2), [0.5, 2.5]);

  // Pomeranje se obavija oko dužine takta.
  assert.equal(applyGridOverride(auto, { phaseOffset: 4 }).downbeatIndex, 0);
  assert.equal(applyGridOverride(auto, { phaseOffset: -1 }).downbeatIndex, 3);
}

{
  // Nemoguć takt se ignoriše umesto da razbije mrežu.
  const auto = normalizeBeatGrid({ status: "ready", bpm: 120, beatsPerBar: 4,
    beats: Array.from({ length: 32 }, (_, i) => i * 0.5) });
  assert.equal(applyGridOverride(auto, { beatsPerBar: 99 }).beatsPerBar, 4);
  assert.equal(applyGridOverride(auto, { beatsPerBar: 0 }).beatsPerBar, 4);
  assert.equal(applyGridOverride(auto, { tempoScale: 7 }).beats.length, 32, "nepoznata skala se ignoriše");
}

console.log("beat-grid tests passed");
