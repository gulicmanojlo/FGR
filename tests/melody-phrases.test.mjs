import assert from "node:assert/strict";
import { detectMelodyPhrases, phraseIndexAtTime } from "../js/melody-phrases.js";

function events(list) {
  return list.map(([t, d, midi]) => ({ t, d, midi }));
}

// Dve jasne fraze razdvojene pauzom od 1.5 s.
const twoPhrases = detectMelodyPhrases(events([
  [0, 0.4, 60], [0.5, 0.4, 62], [1.0, 0.4, 64],
  [3.0, 0.4, 67], [3.5, 0.4, 69]
]));
assert.equal(twoPhrases.length, 2);
assert.deepEqual(
  twoPhrases.map((p) => [p.firstIndex, p.lastIndex, p.noteCount]),
  [[0, 2, 3], [3, 4, 2]]
);
assert.equal(twoPhrases[0].startTime, 0);
assert.ok(Math.abs(twoPhrases[0].endTime - 1.4) < 1e-9);
assert.equal(twoPhrases[1].startTime, 3);

// Kratka pauza (manja od praga) ne deli frazu.
assert.equal(detectMelodyPhrases(events([[0, 0.4, 60], [1.0, 0.4, 62]])).length, 1);

// Usamljen jedan ton između fraza se pripaja prethodnoj.
const merged = detectMelodyPhrases(events([
  [0, 0.4, 60], [0.5, 0.4, 62],
  [3.0, 0.1, 72],
  [6.0, 0.4, 64], [6.5, 0.4, 65]
]));
assert.equal(merged.length, 2);
assert.equal(merged[0].noteCount, 3);
assert.equal(merged[0].lastIndex, 2);
assert.ok(Math.abs(merged[0].endTime - 3.1) < 1e-9);

// Gust blok bez prave pauze se seče na najvećoj unutrašnjoj pauzi.
const dense = [];
for (let index = 0; index < 40; index += 1) {
  // Sve pauze su 0.1 s osim jedne od 0.5 s na sredini.
  const gap = index === 20 ? 0.5 : 0.1;
  const previous = dense[index - 1];
  const t = previous ? previous.t + previous.d + gap : 0;
  dense.push({ t, d: 0.4, midi: 60 + (index % 7) });
}
const denseSpan = dense[dense.length - 1].t + dense[dense.length - 1].d - dense[0].t;
assert.ok(denseSpan > 9, "test podaci moraju prelaziti maksimum fraze");
const denseSingle = detectMelodyPhrases(dense, { maximumSeconds: 1e6 });
assert.equal(denseSingle.length, 1, "bez ograničenja dužine ostaje jedan blok");
const densePhrases = detectMelodyPhrases(dense);
assert.ok(densePhrases.length >= 2, "predug blok mora biti podeljen");
densePhrases.forEach((phrase) => {
  assert.ok(phrase.endTime - phrase.startTime <= 9 + 1e-9, "svaki deo staje u maksimum");
});
// Prvi rez ide na najveću pauzu — ton s indeksom 20 počinje novu frazu.
assert.ok(densePhrases.some((phrase) => phrase.firstIndex === 20), "rez nije na najvećoj pauzi");
// Delovi ostaju uzastopni i pokrivaju sve tonove.
assert.equal(densePhrases[0].firstIndex, 0);
assert.equal(densePhrases[densePhrases.length - 1].lastIndex, dense.length - 1);

// Nevalidni eventovi se ignorišu; prazan ulaz vraća prazno.
assert.deepEqual(detectMelodyPhrases([]), []);
assert.deepEqual(detectMelodyPhrases(null), []);
assert.equal(detectMelodyPhrases([{ t: 0, d: 1, midi: Number.NaN }]).length, 0);

// phraseIndexAtTime: unutar fraze, u pauzi (sledeća) i posle kraja (poslednja).
assert.equal(phraseIndexAtTime(twoPhrases, 0.7), 0);
assert.equal(phraseIndexAtTime(twoPhrases, 2.0), 1);
assert.equal(phraseIndexAtTime(twoPhrases, 99), 1);
assert.equal(phraseIndexAtTime([], 1), -1);

// Realni podaci demo pesme: fraze pokrivaju sve eventove bez preklapanja.
const { readFile } = await import("node:fs/promises");
const payload = JSON.parse(
  await readFile(new URL("./fixtures/note-tracks.json", import.meta.url), "utf8")
);
const demoEvents = (payload.noteTracks || payload).melody?.events || [];
if (demoEvents.length) {
  const phrases = detectMelodyPhrases(demoEvents);
  assert.ok(phrases.length >= 3, `očekivano bar 3 fraze, dobijeno ${phrases.length}`);
  assert.equal(phrases[0].firstIndex, 0);
  assert.equal(phrases[phrases.length - 1].lastIndex, demoEvents.length - 1);
  for (let index = 1; index < phrases.length; index += 1) {
    assert.ok(phrases[index].firstIndex === phrases[index - 1].lastIndex + 1, "fraze moraju biti uzastopne");
    assert.ok(phrases[index].startTime >= phrases[index - 1].endTime - 1e-9, "fraze ne smeju da se preklapaju");
  }
  // Nijedna fraza ne sme biti preduga za vežbanje u petlji — osim kada se
  // zaista ne može podeliti (premalo tonova da rez ostavi upotrebljive delove).
  phrases.forEach((phrase, index) => {
    const span = phrase.endTime - phrase.startTime;
    if (span <= 9 + 1e-9) return;
    assert.ok(
      phrase.noteCount < 4,
      `fraza ${index + 1} traje ${span.toFixed(1)} s sa ${phrase.noteCount} tonova — mogla je da se podeli`
    );
  });
}

console.log("melody-phrases tests passed");
