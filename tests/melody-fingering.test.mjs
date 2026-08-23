import assert from "node:assert/strict";
import { computeMelodyFingering } from "../js/melody-fingering.js";

function events(midis, { start = 0, step = 0.5, duration = 0.4 } = {}) {
  return midis.map((midi, index) => ({ t: start + index * step, d: duration, midi }));
}

// C-dur skala uzlazno: udžbenički prstored 1 2 3 1 2 3 4 5.
assert.deepEqual(
  computeMelodyFingering(events([60, 62, 64, 65, 67, 69, 71, 72])),
  [1, 2, 3, 1, 2, 3, 4, 5]
);

// C-dur skala silazno: 5 4 3 2 1 3 2 1.
assert.deepEqual(
  computeMelodyFingering(events([72, 71, 69, 67, 65, 64, 62, 60])),
  [5, 4, 3, 2, 1, 3, 2, 1]
);

// Razloženi C-dur akord: 1 2 3 5.
assert.deepEqual(computeMelodyFingering(events([60, 64, 67, 72])), [1, 2, 3, 5]);

// Ponovljeni ton zadržava isti prst.
const repeated = computeMelodyFingering(events([67, 67, 67, 67]));
assert.equal(new Set(repeated).size, 1);

// Kvintni položaj (pet susednih stepena) ne zahteva nikakvo ukrštanje.
const fivePosition = computeMelodyFingering(events([60, 62, 64, 65, 67, 65, 64, 62, 60]));
assert.deepEqual(fivePosition, [1, 2, 3, 4, 5, 4, 3, 2, 1]);

// Pauza duža od praga deli frazu: druga fraza počinje svežim prstom, ne
// nastavlja ukrštanjem iz prve.
const phrased = computeMelodyFingering([
  ...events([60, 62, 64], { start: 0 }),
  ...events([72, 71, 69], { start: 4 })
]);
assert.deepEqual(phrased.slice(0, 3), [1, 2, 3]);
assert.ok(phrased[3] >= 3, `druga fraza treba da počne višim prstom, dobio ${phrased[3]}`);

// Palac izbegava crnu dirku pri hvatu ispod: uzlazno D E F# G A H C# D
// (D-dur) palac ide na G, ne na F#.
const dMajor = computeMelodyFingering(events([62, 64, 66, 67, 69, 71, 73, 74]));
const thumbIndexes = dMajor
  .map((finger, index) => ({ finger, index }))
  .filter((entry) => entry.finger === 1 && entry.index > 0)
  .map((entry) => entry.index);
thumbIndexes.forEach((index) => {
  const midi = [62, 64, 66, 67, 69, 71, 73, 74][index];
  assert.ok(![1, 3, 6, 8, 10].includes(midi % 12), `palac na crnoj dirci (midi ${midi})`);
});

// Leva ruka (bas): silazna linija C3 H2 A2 G2 kreće palcem (1) nadole.
const bass = computeMelodyFingering(events([48, 47, 45, 43]), { hand: "left" });
assert.deepEqual(bass, [1, 2, 3, 4]);

// Leva ruka: uzlazna bas linija završava palcem na vrhu.
const bassUp = computeMelodyFingering(events([43, 45, 47, 48]), { hand: "left" });
assert.deepEqual(bassUp, [4, 3, 2, 1]);

// Nevalidni događaji ne ruše obradu i dobijaju null.
const sparse = computeMelodyFingering([
  { t: 0, d: 0.4, midi: 60 },
  { t: 0.5, d: 0.4, midi: Number.NaN },
  { t: 1, d: 0.4, midi: 62 }
]);
assert.equal(sparse.length, 3);
assert.equal(sparse[1], null);
assert.ok(sparse[0] >= 1 && sparse[2] >= 1);

// Prazan ulaz.
assert.deepEqual(computeMelodyFingering([]), []);
assert.deepEqual(computeMelodyFingering(null), []);

// Integracija nad stvarnom analizom demo pesme: svaki validan event dobija
// prst 1-5, bez tehnički nemogućih prelaza unutar fraze.
const { readFile } = await import("node:fs/promises");
const demoPayload = JSON.parse(
  await readFile(new URL("./fixtures/note-tracks.json", import.meta.url), "utf8")
);
const demoTracks = demoPayload.noteTracks || demoPayload;
for (const [name, hand] of [["melody", "right"], ["bass", "left"]]) {
  const demoEvents = demoTracks[name]?.events || [];
  if (!demoEvents.length) continue;
  const demoFingers = computeMelodyFingering(demoEvents, { hand });
  assert.equal(demoFingers.length, demoEvents.length);
  demoFingers.forEach((finger, index) => {
    assert.ok(
      finger === null || (Number.isInteger(finger) && finger >= 1 && finger <= 5),
      `${name}[${index}] ima nevalidan prst ${finger}`
    );
  });
  const voiced = demoFingers.filter((finger) => finger !== null);
  assert.ok(voiced.length >= demoEvents.length * 0.95, `${name}: premalo dodeljenih prstiju`);
  // Ukrštanje dugih prstiju bez palca u istom dahu ne sme da se dogodi.
  for (let index = 1; index < demoEvents.length; index += 1) {
    const previous = demoEvents[index - 1];
    const gap = (Number(demoEvents[index].t) || 0) - ((Number(previous.t) || 0) + (Number(previous.d) || 0));
    if (gap >= 0.75) continue;
    const from = demoFingers[index - 1];
    const to = demoFingers[index];
    if (!from || !to || from === 1 || to === 1) continue;
    const interval = (demoEvents[index].midi - previous.midi) * (hand === "left" ? -1 : 1);
    if (interval > 0) {
      assert.ok(to >= from || Math.abs(interval) > 5, `${name}[${index}]: silazni prsti na uzlaznim tonovima (${from}->${to}, interval ${interval})`);
    }
  }
}

console.log("melody-fingering tests passed");
