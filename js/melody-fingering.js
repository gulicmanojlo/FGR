// Automatski prstored za monofonu melodijsku/bas liniju.
//
// Viterbi/DP nad nizom nota: stanje je prst (1-5) na tekućoj noti, cena
// prelaza modeluje udobnost raspona između parova prstiju, hvat palcem ispod
// (thumb-under), ponavljanje istog tona i palac na crnoj dirci. Pauze duže od
// praga resetuju ruku, pa svaka fraza dobija svež, prirodan početni prst.
// Model je pojednostavljen Parncutt-ov pristup: cilj je pedagoški razuman
// prstored za vežbanje, ne jedina "ispravna" varijanta.

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const FINGERS = [1, 2, 3, 4, 5];

// Udoban i maksimalan raspon u polustepenima za par prstiju desne ruke
// (niži prst na nižem tonu). Ključ je "niži-viši" prst.
const SPANS = {
  "1-2": { comfort: [1, 5], max: 8 },
  "1-3": { comfort: [3, 7], max: 10 },
  "1-4": { comfort: [5, 9], max: 12 },
  "1-5": { comfort: [7, 12], max: 15 },
  "2-3": { comfort: [1, 3], max: 5 },
  "2-4": { comfort: [3, 5], max: 7 },
  "2-5": { comfort: [5, 8], max: 10 },
  "3-4": { comfort: [1, 3], max: 5 },
  "3-5": { comfort: [3, 5], max: 7 },
  "4-5": { comfort: [1, 3], max: 5 }
};

function spanRule(lowFinger, highFinger) {
  return SPANS[`${Math.min(lowFinger, highFinger)}-${Math.max(lowFinger, highFinger)}`] || null;
}

function isBlack(midi) {
  return BLACK_PCS.has(((midi % 12) + 12) % 12);
}

/**
 * Cena prelaza sa prsta `from` (na `fromMidi`) na prst `to` (na `toMidi`).
 * Manja cena = prirodniji pokret. Model je za desnu ruku; za levu ruku se
 * pozivalac stara da ogleda prste (finger -> 6 - finger).
 */
function transitionCost(from, fromMidi, to, toMidi) {
  const interval = toMidi - fromMidi;
  const distance = Math.abs(interval);

  if (interval === 0) {
    // Ponovljeni ton: isti prst je standard; promena prsta je legitimna
    // (repetition technique), ali za vežbanje melodije neka bude skuplja.
    return from === to ? 0 : 1.6;
  }

  if (from === to) {
    // Isti prst na različitim tonovima = skok šakom. Dozvoljen (glissando
    // pozicioni skok), ali skup, i sve skuplji što je interval veći.
    return 5.5 + Math.min(6, distance * 0.45);
  }

  const ascending = interval > 0;
  const lowFinger = ascending ? from : to;
  const highFinger = ascending ? to : from;
  const orderMatchesPitch = ascending ? to > from : to < from;

  if (orderMatchesPitch) {
    // Prsti u istom smeru kao tonovi: cena po odstupanju od udobnog raspona.
    const rule = spanRule(lowFinger, highFinger);
    if (!rule) return 12;
    const [comfortLow, comfortHigh] = rule.comfort;
    if (distance > rule.max) return 9 + (distance - rule.max) * 1.5;
    if (distance < comfortLow) return 0.8 + (comfortLow - distance) * 0.9;
    if (distance > comfortHigh) return 0.6 + (distance - comfortHigh) * 0.7;
    return 0;
  }

  // Prsti idu suprotno od smera tonova: jedino prirodno preko palca.
  if (to === 1) {
    // Palac ispod (uzlazno) ili šaka preko palca (silazno na palac).
    // Hvat posle 3. prsta je standard; posle 4. rezerva, posle 5. praktično
    // se ne koristi jer ne ostaje oslonac za pivot šake.
    let cost = 1.1 + Math.min(4, Math.max(0, distance - 2) * 0.55);
    if (from === 2) cost += 0.4;
    if (from === 4) cost += 0.5;
    if (from === 5) cost += 2.5;
    if (isBlack(toMidi)) cost += 2.2; // palac na crnoj dirci izbegavati
    return cost;
  }
  if (from === 1) {
    // Prelaz preko palca (3. ili 4. prst preko, uzlazno posle palca).
    let cost = 1.2 + Math.min(4, Math.max(0, distance - 2) * 0.55);
    if (to === 5) cost += 2.5; // peti prst preko palca je nespretan
    if (to === 4) cost += 0.5; // 3. preko palca je standard, 4. rezerva
    if (to === 2) cost += 0.4;
    return cost;
  }
  // Ukrštanje dugih prstiju bez palca — tehnički izuzetak, praktično greška.
  return 10 + distance * 0.5;
}

/** Blaga polazna preferencija: palac na beloj dirci je prirodan početak. */
function startCost(finger, midi) {
  const base = { 1: 0, 2: 0.05, 3: 0.15, 4: 0.6, 5: 1.0 }[finger] ?? 1;
  return base + (finger === 1 && isBlack(midi) ? 1.6 : 0);
}

function decodePhrase(midis) {
  if (!midis.length) return [];
  const costs = FINGERS.map((finger) => startCost(finger, midis[0]));
  const backtrack = [];
  for (let index = 1; index < midis.length; index += 1) {
    const nextCosts = new Array(FINGERS.length).fill(Infinity);
    const pointers = new Array(FINGERS.length).fill(0);
    for (let to = 0; to < FINGERS.length; to += 1) {
      for (let from = 0; from < FINGERS.length; from += 1) {
        const candidate = costs[from]
          + transitionCost(FINGERS[from], midis[index - 1], FINGERS[to], midis[index]);
        if (candidate < nextCosts[to]) {
          nextCosts[to] = candidate;
          pointers[to] = from;
        }
      }
      nextCosts[to] += finger5BlackPenalty(FINGERS[to], midis[index]);
    }
    backtrack.push(pointers);
    for (let to = 0; to < FINGERS.length; to += 1) costs[to] = nextCosts[to];
  }

  let best = 0;
  for (let finger = 1; finger < FINGERS.length; finger += 1) {
    if (costs[finger] < costs[best]) best = finger;
  }
  const result = new Array(midis.length);
  result[midis.length - 1] = FINGERS[best];
  for (let index = midis.length - 1; index > 0; index -= 1) {
    best = backtrack[index - 1][best];
    result[index - 1] = FINGERS[best];
  }
  return result;
}

// Mali stalni dodatak: 5. prst na crnoj dirci je legitiman ali ređe idealan.
function finger5BlackPenalty(finger, midi) {
  return finger === 5 && isBlack(midi) ? 0.3 : 0;
}

/**
 * Izračunaj prstored za niz nota `[{ t, d, midi }]` iste linije.
 *
 * Vraća niz brojeva prstiju (1-5) poravnat sa ulaznim nizom. Pauza od bar
 * `phraseRestSeconds` između kraja note i početka sledeće deli frazu i
 * resetuje poziciju ruke. `hand: "left"` ogleda prste za bas liniju.
 */
export function computeMelodyFingering(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const restThreshold = Math.max(0.15, Number(options.phraseRestSeconds) || 0.75);
  const leftHand = options.hand === "left";

  const notes = list
    .map((event, index) => ({
      index,
      t: Number(event?.t) || 0,
      d: Math.max(0, Number(event?.d) || 0),
      midi: Math.round(Number(event?.midi))
    }))
    .filter((note) => Number.isFinite(note.midi));

  const fingering = new Array(list.length).fill(null);
  let phraseStart = 0;
  for (let index = 1; index <= notes.length; index += 1) {
    const previous = notes[index - 1];
    const isBreak = index === notes.length
      || notes[index].t - (previous.t + previous.d) >= restThreshold;
    if (!isBreak) continue;
    const phrase = notes.slice(phraseStart, index);
    // Leva ruka je ogledalo desne. Refleksija oko pc 4 (midi' = 124 - midi)
    // čuva raspored crnih dirki (C# <-> D#, F# <-> A# itd.), pa pravila o
    // palcu na crnoj dirci ostaju tačna i za levu ruku.
    const midis = phrase.map((note) => (leftHand ? 124 - note.midi : note.midi));
    const fingers = decodePhrase(midis);
    phrase.forEach((note, phraseIndex) => {
      fingering[note.index] = fingers[phraseIndex];
    });
    phraseStart = index;
  }
  return fingering;
}
