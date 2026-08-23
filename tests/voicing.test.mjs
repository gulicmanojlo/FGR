import assert from "node:assert/strict";
import { normalizeBeatGrid } from "../js/beat-grid.js";
import {
  COMPING_PATTERNS,
  defaultPatternForMeter,
  nearestMidiForPitchClass,
  renderHarmonyEvents,
  scalePatternToMeter,
  selectVoicingTones,
  voiceChord,
  voiceLeadingCost
} from "../js/voicing.js";

const MAJOR = [0, 4, 7];
const MINOR = [0, 3, 7];
const DOM7 = [0, 4, 7, 10];

// --- pomoćne funkcije ------------------------------------------------------

assert.equal(nearestMidiForPitchClass(0, 60), 60);
assert.equal(nearestMidiForPitchClass(0, 61), 60);
assert.equal(nearestMidiForPitchClass(0, 67), 72, "bliže je gornje C nego donje");
assert.equal(nearestMidiForPitchClass(11, 60), 59);

// Kvinta se izostavlja samo u četvorozvuku; trozvuk ostaje ceo.
assert.deepEqual(selectVoicingTones(MAJOR).sort((a, b) => a - b), [0, 4, 7]);
assert.deepEqual(selectVoicingTones(DOM7).sort((a, b) => a - b), [0, 4, 10], "terca i septima ostaju");
assert.deepEqual(selectVoicingTones(DOM7, { dropFifth: false }).sort((a, b) => a - b), [0, 4, 7, 10]);

assert.equal(voiceLeadingCost([60, 64, 67], []), 0);
assert.equal(voiceLeadingCost([60, 64, 67], [60, 64, 67]), 0);
assert.equal(voiceLeadingCost([61, 64, 67], [60, 64, 67]), 1);

// --- raspored akorda -------------------------------------------------------

{
  const c = voiceChord({ pc: 0, ivs: MAJOR });
  assert.ok(c.chord.length === 3);
  assert.deepEqual([...c.chord].sort((a, b) => a - b), c.chord, "tonovi idu uzlazno");
  assert.deepEqual(c.chord.map((m) => ((m % 12) + 12) % 12).sort((a, b) => a - b), [0, 4, 7]);
  assert.ok(c.bass >= 28 && c.bass <= 52, "bas je u registru leve ruke");
  assert.equal(((c.bass % 12) + 12) % 12, 0, "bas je osnovni ton");
  assert.ok(c.chord[0] > c.bass, "desna ruka je iznad basa");
}

{
  // Slash akord premešta bas, a ne ceo raspored.
  const c = voiceChord({ pc: 0, ivs: MAJOR, bassPc: 7 });
  assert.equal(((c.bass % 12) + 12) % 12, 7, "C/G ima G u basu");
  assert.deepEqual(c.chord.map((m) => ((m % 12) + 12) % 12).sort((a, b) => a - b), [0, 4, 7]);
}

{
  // Vođenje glasova: sledeći akord se bira tako da se ruka najmanje pomeri.
  const first = voiceChord({ pc: 0, ivs: MAJOR });
  const next = voiceChord({ pc: 5, ivs: MAJOR }, { previous: first.chord, previousBass: first.bass });
  const movement = voiceLeadingCost(next.chord, first.chord);
  const rootPosition = voiceChord({ pc: 5, ivs: MAJOR }, { previous: [] });
  assert.ok(
    movement <= voiceLeadingCost(rootPosition.chord, first.chord),
    `vođeni raspored (${movement}) nije gori od osnovnog položaja`
  );
  assert.ok(movement <= 9, `ruka se pomera malo, a ne skače (${movement})`);
}

{
  // Niz akorada ne sme da odluta iz registra posle više promena.
  let previous = [];
  let bass = null;
  const roots = [0, 5, 7, 9, 2, 7, 0];
  roots.forEach((pc) => {
    const voiced = voiceChord({ pc, ivs: pc === 9 || pc === 2 ? MINOR : MAJOR }, { previous, previousBass: bass });
    assert.ok(voiced.chord[0] >= 38, `dno rasporeda ostaje u registru (${voiced.chord[0]})`);
    assert.ok(voiced.chord[voiced.chord.length - 1] <= 78, `vrh ostaje u registru`);
    assert.ok(voiced.bass >= 28 && voiced.bass <= 52);
    previous = voiced.chord;
    bass = voiced.bass;
  });
}

{
  // Pratnja se sklanja ispod melodije.
  const high = voiceChord({ pc: 0, ivs: MAJOR }, { melodyMidi: 84 });
  const low = voiceChord({ pc: 0, ivs: MAJOR }, { melodyMidi: 62 });
  assert.ok(low.chord[low.chord.length - 1] < 62, "vrh pratnje je ispod melodije");
  assert.ok(low.chord[low.chord.length - 1] < high.chord[high.chord.length - 1]);
}

{
  // Kada melodije nema, plafon se NE spušta. `Number(null)` je 0, pa je
  // naivna provera obarala pratnju na dno registra i time onemogućavala
  // ispravno vođenje glasova.
  const withoutMelody = voiceChord({ pc: 0, ivs: MAJOR }, { melodyMidi: null });
  const explicitNone = voiceChord({ pc: 0, ivs: MAJOR }, {});
  assert.deepEqual(withoutMelody.chord, explicitNone.chord, "null melodija = kao da je nema");
  assert.ok(withoutMelody.chord[withoutMelody.chord.length - 1] > 62,
    `bez melodije desna ruka sme iznad 62 (dobijeno ${withoutMelody.chord[withoutMelody.chord.length - 1]})`);
}

{
  // Konkretan slučaj iz demo pesme: Dm -> D# je pre popravke birao raspored
  // sa skokom 5 umesto najbližeg sa 4, jer je plafon bio zaglavljen na 62.
  const prev = [53, 57, 62];
  const next = voiceChord({ pc: 3, ivs: MAJOR }, { previous: prev, previousBass: 38 });
  assert.deepEqual(next.chord, [55, 58, 63], "bira se najbliži raspored");
  assert.ok(voiceLeadingCost(next.chord, prev) <= voiceLeadingCost([51, 55, 58], prev));
}

{
  // Prvi akord nema prethodni bas; `Number(null)` je 0 pa je cilj ispadao 20
  // i bas je bio guran na samo dno klavijature.
  const first = voiceChord({ pc: 0, ivs: MAJOR }, { previousBass: null });
  const neutral = voiceChord({ pc: 0, ivs: MAJOR }, {});
  assert.equal(first.bass, neutral.bass);
  assert.ok(first.bass >= 36, `prvi bas nije prikovan za dno (${first.bass})`);
}

assert.equal(voiceChord(null), null);
assert.equal(voiceChord({ pc: "x", ivs: MAJOR }), null);

// --- obrasci pratnje -------------------------------------------------------

assert.equal(defaultPatternForMeter(3), "waltz");
assert.equal(defaultPatternForMeter(4), "downbeats");
assert.equal(COMPING_PATTERNS.waltz.beatsPerBar, 3);

{
  const scaled = scalePatternToMeter(COMPING_PATTERNS.downbeats, 3);
  assert.equal(scaled.beatsPerBar, 3);
  scaled.hits.forEach((hit) => assert.ok(hit.beat < 3, "nijedan udar ne izlazi iz takta"));
}

// --- render harmonije ------------------------------------------------------

function grid({ bpm = 120, count = 64, start = 0, beatsPerBar = 4, downbeatIndex = 0 } = {}) {
  const step = 60 / bpm;
  return normalizeBeatGrid({
    status: "ready", meterStatus: "ready", bpm, beatsPerBar, downbeatIndex,
    beats: Array.from({ length: count }, (_, i) => start + i * step), confidence: 0.9
  });
}

const parseChord = (chord) => {
  const map = { C: { pc: 0, ivs: MAJOR }, F: { pc: 5, ivs: MAJOR }, G7: { pc: 7, ivs: DOM7 }, Am: { pc: 9, ivs: MINOR } };
  return map[chord.n] || null;
};

{
  // Dva takta akorda daju više udara, a ne jedan izdržan blok.
  const events = renderHarmonyEvents(
    [{ t: 0, n: "C" }, { t: 4, n: "F" }],
    grid(),
    { parseChord, endTime: 8, patternName: "downbeats" }
  );
  assert.ok(events.length > 8, `pratnja ima ritam (${events.length} tonova)`);
  const times = [...new Set(events.map((e) => +e.t.toFixed(3)))];
  assert.deepEqual(times, [0, 1, 2, 3, 4, 5, 6, 7], "udari na 1 i 3 svakog takta");
  events.forEach((e) => {
    assert.ok(e.d > 0, "svaki ton ima trajanje");
    assert.ok(e.vel > 0 && e.vel <= 1, "velocity je u opsegu");
    assert.equal(e.role, "harmony");
  });
}

{
  // Bas i akord su razdvojeni po registru.
  const events = renderHarmonyEvents([{ t: 0, n: "C" }], grid(), { parseChord, endTime: 2 });
  const lowest = Math.min(...events.map((e) => e.midi));
  assert.ok(lowest >= 28 && lowest <= 52, "postoji pravi bas ton");
  assert.ok(events.some((e) => e.midi > 50), "postoji i deonica desne ruke");
}

{
  // Izričito izabran obrazac je korisnikova tvrdnja o taktu i mora da se
  // izvrši i kada automatika nije sigurna. Ranije se tiho ignorisao, pa je
  // meni izgledao pokvareno.
  const uncertain = normalizeBeatGrid({
    status: "ready", meterStatus: "uncertain", bpm: 120, beatsPerBar: 3,
    beats: Array.from({ length: 64 }, (_, i) => i * 0.5)
  });
  const auto = renderHarmonyEvents([{ t: 0, n: "C" }], uncertain, { parseChord, endTime: 8 });
  const rumba = renderHarmonyEvents([{ t: 0, n: "C" }], uncertain, { parseChord, endTime: 8, patternName: "rumba" });
  const waltz = renderHarmonyEvents([{ t: 0, n: "C" }], uncertain, { parseChord, endTime: 8, patternName: "waltz" });
  const times = (list) => [...new Set(list.map((e) => +e.t.toFixed(3)))].join(",");
  assert.notEqual(times(rumba), times(auto), "rumba mora da zvuči drugačije od automatskog");
  assert.notEqual(times(rumba), times(waltz), "rumba i valcer se razlikuju");
  // Rumba nosi tresilo: bas na 1 i na "i" od 2.
  const bass = rumba.filter((e) => e.midi <= 52).map((e) => +e.t.toFixed(3));
  assert.ok(bass.includes(0) && bass.includes(0.75), `bas 3-3-2, dobijeno ${bass.slice(0, 4)}`);
}

{
  // Puls je pouzdan a takt nije: akord se obnavlja po dobama, ali se ne
  // izmišlja naglasak na prvoj dobi jer se ne zna gde je.
  const uncertain = normalizeBeatGrid({
    status: "ready", meterStatus: "uncertain", bpm: 120, beatsPerBar: 4,
    beats: Array.from({ length: 32 }, (_, i) => i * 0.5)
  });
  const events = renderHarmonyEvents([{ t: 0, n: "C" }], uncertain, { parseChord, endTime: 4 });
  const bass = events.filter((e) => e.midi <= 52);
  const rh = events.filter((e) => e.midi > 52);
  assert.equal(bass.length, 1, "bas drži ceo akord");
  assert.ok(Math.abs(bass[0].d - 4) < 1e-9);
  const rhStarts = [...new Set(rh.map((e) => +e.t.toFixed(3)))];
  assert.deepEqual(rhStarts, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], "desna ruka na svakoj dobi");
  const velocities = new Set(rh.map((e) => e.vel));
  assert.equal(velocities.size, 1, "bez izmišljenog naglaska na prvoj dobi");
}

{
  // Bez ikakve mreže ostaje jedan izdržan akord.
  const events = renderHarmonyEvents([{ t: 0, n: "C" }], null, { parseChord, endTime: 4 });
  const starts = [...new Set(events.map((e) => e.t))];
  assert.deepEqual(starts, [0], "jedan izdržan akord umesto nagađanog ritma");
  assert.ok(Math.abs(events[0].d - 4) < 1e-9);
}

{
  // Isto važi kada mreže uopšte nema.
  const events = renderHarmonyEvents([{ t: 1, n: "C" }], null, { parseChord, endTime: 3 });
  assert.ok(events.length >= 3);
  assert.deepEqual([...new Set(events.map((e) => e.t))], [1]);
}

{
  // Akord koji počne posle poslednjeg udara u taktu ipak mora da zazvuči.
  const events = renderHarmonyEvents(
    [{ t: 0, n: "C" }, { t: 1.75, n: "F" }, { t: 2.0, n: "G7" }],
    grid(),
    { parseChord, endTime: 4, patternName: "downbeats" }
  );
  const fRoots = events.filter((e) => Math.abs(e.t - 1.75) < 1e-6);
  assert.ok(fRoots.length > 0, "kratak akord van udara se ipak čuje");
}

{
  // Valcer koristi tročetvrtinski obrazac.
  const events = renderHarmonyEvents(
    [{ t: 0, n: "C" }],
    grid({ beatsPerBar: 3 }),
    { parseChord, endTime: 3, patternName: "waltz" }
  );
  const times = [...new Set(events.map((e) => +e.t.toFixed(3)))];
  assert.deepEqual(times, [0, 0.5, 1, 1.5, 2, 2.5], "bas na 1, akordi na 2 i 3, dva takta");
}

{
  // Razloženi obrazac svira jedan po jedan ton, a ne ceo akord odjednom.
  const events = renderHarmonyEvents([{ t: 0, n: "C" }], grid(), { parseChord, endTime: 2, patternName: "arpeggio" });
  const byTime = new Map();
  events.filter((e) => e.midi > 50).forEach((e) => byTime.set(e.t, (byTime.get(e.t) || 0) + 1));
  [...byTime.values()].forEach((count) => assert.equal(count, 1, "u razlaganju zvuči po jedan ton"));
}

{
  // Akord koji se ne prepoznaje se preskače bez rušenja.
  const events = renderHarmonyEvents(
    [{ t: 0, n: "C" }, { t: 2, n: "Xyz" }],
    grid(),
    { parseChord, endTime: 4 }
  );
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.t < 2 || e.t >= 2), "ostatak harte i dalje radi");
}

assert.deepEqual(renderHarmonyEvents([], grid(), { parseChord }), []);
assert.deepEqual(renderHarmonyEvents([{ t: 0, n: "C" }], grid(), {}), [], "bez parsera nema pratnje");

console.log("voicing tests passed");
