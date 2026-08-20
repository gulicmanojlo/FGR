/**
 * Zajednička ritmička mreža pesme (tempo, bitovi, taktovi).
 *
 * Ovo je osnovni sloj studijske matrice: akordi, melodija i bas se svi
 * izražavaju u odnosu na istu mrežu, umesto svaki u svom slobodnom vremenu.
 * Primarna koordinata je pozicija u bitovima; sekunde se izvode iz nje.
 *
 * Sve funkcije su čiste i rade nad običnim objektom, pa se ponašanje mreže
 * može testirati bez audio konteksta.
 */

const MIN_BEATS_PER_BAR = 2;
const MAX_BEATS_PER_BAR = 16;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Očisti mrežu koja stiže sa servisa, iz playliste ili iz keša.
 * Vraća `null` kada nema upotrebljivog pulsa.
 */
export function normalizeBeatGrid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const beats = [];
  const rawBeats = Array.isArray(value.beats) ? value.beats : [];
  for (const item of rawBeats) {
    const time = Number(item);
    // Rastući, nenegativni i bez duplikata: indeks bita je osnova svega
    // ostalog, pa ovde ne sme da prođe mreža koja se ne može pretraživati.
    if (Number.isFinite(time) && time >= 0 && (!beats.length || time > beats[beats.length - 1])) {
      beats.push(time);
    }
  }
  if (beats.length < 2) return null;

  let beatsPerBar = Math.round(finite(value.beatsPerBar, 4));
  if (!Number.isFinite(beatsPerBar)) beatsPerBar = 4;
  beatsPerBar = Math.max(MIN_BEATS_PER_BAR, Math.min(MAX_BEATS_PER_BAR, beatsPerBar));

  let downbeatIndex = Math.round(finite(value.downbeatIndex, 0));
  downbeatIndex = ((downbeatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;

  const status = String(value.status || "").trim().toLowerCase();
  const meterStatus = String(value.meterStatus || "").trim().toLowerCase();
  const intervals = [];
  for (let index = 1; index < beats.length; index += 1) intervals.push(beats[index] - beats[index - 1]);
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)] || 0;

  return {
    status: ["ready", "low-confidence", "unavailable"].includes(status) ? status : "ready",
    meterStatus: meterStatus === "ready" ? "ready" : "uncertain",
    algorithm: String(value.algorithm || "none").slice(0, 80),
    bpm: finite(value.bpm, medianInterval > 0 ? 60 / medianInterval : 0),
    beatsPerBar,
    downbeatIndex,
    beats,
    medianInterval,
    confidence: Math.max(0, Math.min(1, finite(value.confidence, 0))),
    // Osećaj ritma koji je analiza izmerila iz same pesme (tempo, takt,
    // sinkopiranost). Napaja "Ritam: automatski".
    feel: typeof value.feel === "string" ? value.feel.slice(0, 24) : "",
    syncopation: Math.max(0, Math.min(1, finite(value.syncopation, 0))),
    halfTimeApplied: Boolean(value.halfTimeApplied),
    message: String(value.message || "").slice(0, 200)
  };
}

/**
 * Primeni korisnikovo ručno podešavanje na izmerenu mrežu.
 *
 * Automatika pouzdano meri puls, ali takt često ne može da odredi — na
 * stvarnim pesmama akcenatski dokaz zna da bude u granicama šuma. Muzičar
 * zna da li je pesma 4/4 ili 3/4 i gde je prva doba, pa njegova tvrdnja ima
 * prednost nad merenjem i mrežu proglašava sigurnom.
 *
 * `tempoScale` 0.5 znači "broji upola sporije" (svaki drugi puls), a 2
 * "upola brže" (dodaj puls između svaka dva).
 */
export function applyGridOverride(grid, override) {
  if (!hasUsableBeats(grid) || !override || typeof override !== "object") return grid;
  let beats = grid.beats;
  let beatsPerBar = grid.beatsPerBar;
  let downbeatIndex = grid.downbeatIndex;
  let changed = false;

  const scale = Number(override.tempoScale);
  if (scale === 0.5 && beats.length >= 4) {
    beats = beats.filter((_, index) => index % 2 === 0);
    downbeatIndex = Math.floor(downbeatIndex / 2);
    changed = true;
  } else if (scale === 2 && beats.length >= 2) {
    const doubled = [];
    for (let index = 0; index < beats.length - 1; index += 1) {
      doubled.push(beats[index], (beats[index] + beats[index + 1]) / 2);
    }
    doubled.push(beats[beats.length - 1]);
    beats = doubled;
    downbeatIndex *= 2;
    changed = true;
  }

  const meter = Math.round(finite(override.beatsPerBar, 0));
  if (meter >= MIN_BEATS_PER_BAR && meter <= MAX_BEATS_PER_BAR) {
    beatsPerBar = meter;
    changed = true;
  }

  const shift = Math.round(finite(override.phaseOffset, 0));
  if (shift) {
    downbeatIndex += shift;
    changed = true;
  }
  downbeatIndex = ((downbeatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;

  if (!changed) return grid;
  const intervals = [];
  for (let index = 1; index < beats.length; index += 1) intervals.push(beats[index] - beats[index - 1]);
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)] || grid.medianInterval;

  return {
    ...grid,
    beats,
    beatsPerBar,
    downbeatIndex,
    medianInterval,
    bpm: medianInterval > 0 ? 60 / medianInterval : grid.bpm,
    // Korisnik je izričito potvrdio takt, pa on više nije nesiguran.
    meterStatus: meter >= MIN_BEATS_PER_BAR || shift ? "ready" : grid.meterStatus,
    overridden: true
  };
}

export function hasUsableBeats(grid) {
  return Boolean(grid && Array.isArray(grid.beats) && grid.beats.length >= 2 && grid.status !== "unavailable");
}

/** Bar linije su izvedene iz bitova i faze — nikada se ne čuvaju odvojeno. */
export function getDownbeats(grid) {
  if (!hasUsableBeats(grid)) return [];
  const result = [];
  for (let index = grid.downbeatIndex; index < grid.beats.length; index += grid.beatsPerBar) {
    result.push(grid.beats[index]);
  }
  return result;
}

/** Indeks poslednjeg bita koji je počeo do datog trenutka; -1 pre prvog. */
export function beatIndexAt(grid, time) {
  if (!hasUsableBeats(grid)) return -1;
  const target = finite(time, 0);
  const beats = grid.beats;
  if (target < beats[0]) return -1;
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (beats[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Najbliži bit uz razliku u sekundama (pozitivna kada je bit posle vremena). */
export function nearestBeat(grid, time) {
  if (!hasUsableBeats(grid)) return null;
  const target = finite(time, 0);
  const beats = grid.beats;
  const before = beatIndexAt(grid, target);
  const candidates = [];
  if (before >= 0) candidates.push(before);
  if (before + 1 < beats.length) candidates.push(before + 1);
  if (!candidates.length) candidates.push(0);
  let best = candidates[0];
  for (const index of candidates) {
    if (Math.abs(beats[index] - target) < Math.abs(beats[best] - target)) best = index;
  }
  return { index: best, time: beats[best], delta: beats[best] - target };
}

/**
 * Neprekidna pozicija u bitovima. Van izmerene mreže se linearno produžava
 * medijanom intervala, da rani uvod i završni fade ne ostanu bez koordinate.
 */
export function beatPositionAt(grid, time) {
  if (!hasUsableBeats(grid)) return null;
  const target = finite(time, 0);
  const beats = grid.beats;
  const step = grid.medianInterval > 0 ? grid.medianInterval : 0.5;
  if (target < beats[0]) return (target - beats[0]) / step;
  const index = beatIndexAt(grid, target);
  if (index >= beats.length - 1) return beats.length - 1 + (target - beats[beats.length - 1]) / step;
  const span = beats[index + 1] - beats[index];
  return index + (span > 1e-9 ? (target - beats[index]) / span : 0);
}

/** Inverzija `beatPositionAt`: vreme u sekundama za poziciju u bitovima. */
export function timeAtBeatPosition(grid, position) {
  if (!hasUsableBeats(grid)) return null;
  const beats = grid.beats;
  const target = finite(position, 0);
  const step = grid.medianInterval > 0 ? grid.medianInterval : 0.5;
  if (target <= 0) return beats[0] + target * step;
  if (target >= beats.length - 1) return beats[beats.length - 1] + (target - (beats.length - 1)) * step;
  const index = Math.floor(target);
  return beats[index] + (beats[index + 1] - beats[index]) * (target - index);
}

/**
 * Kvantizacija na podelu bita (1 = četvrtina, 2 = osmina, 4 = šesnaestina).
 * `maxShift` sprečava da nota koja je daleko od mreže bude nasilno pomerena.
 */
export function quantizeTime(grid, time, subdivision = 2, maxShift = Infinity) {
  if (!hasUsableBeats(grid)) return finite(time, 0);
  const divisions = Math.max(1, Math.round(finite(subdivision, 1)));
  const position = beatPositionAt(grid, time);
  if (position === null) return finite(time, 0);
  const snapped = Math.round(position * divisions) / divisions;
  const candidate = timeAtBeatPosition(grid, snapped);
  if (candidate === null) return finite(time, 0);
  return Math.abs(candidate - finite(time, 0)) <= Math.abs(finite(maxShift, Infinity))
    ? candidate
    : finite(time, 0);
}

/** Takt i doba (oboje 1-bazirani) za dati trenutak. */
export function barPositionAt(grid, time) {
  if (!hasUsableBeats(grid)) return null;
  const index = beatIndexAt(grid, time);
  if (index < 0) return null;
  const offset = index - grid.downbeatIndex;
  const beatsPerBar = grid.beatsPerBar;
  const bar = Math.floor(offset / beatsPerBar) + 1;
  const beatInBar = ((offset % beatsPerBar) + beatsPerBar) % beatsPerBar + 1;
  return { bar, beat: beatInBar, beatIndex: index, isDownbeat: beatInBar === 1 };
}

export function isDownbeatIndex(grid, index) {
  if (!hasUsableBeats(grid)) return false;
  const offset = Math.round(finite(index, -1)) - grid.downbeatIndex;
  return offset >= 0 && offset % grid.beatsPerBar === 0;
}

/**
 * Koliko dobro se niz vremena poklapa sa mrežom. Ovo je merna funkcija za
 * regresione testove: pre kvantizacije akorda i posle nje.
 */
export function gridAlignmentReport(grid, times, tolerance = 0.05) {
  const values = (Array.isArray(times) ? times : [])
    .map((item) => Number(item?.t ?? item))
    .filter((value) => Number.isFinite(value));
  if (!hasUsableBeats(grid) || !values.length) {
    return { count: 0, withinTolerance: 0, ratio: 0, medianOffset: 0, maxOffset: 0 };
  }
  const offsets = values
    .map((value) => nearestBeat(grid, value))
    .filter(Boolean)
    .map((match) => Math.abs(match.delta))
    .sort((a, b) => a - b);
  const withinTolerance = offsets.filter((offset) => offset <= Math.abs(finite(tolerance, 0.05))).length;
  return {
    count: offsets.length,
    withinTolerance,
    ratio: offsets.length ? withinTolerance / offsets.length : 0,
    medianOffset: offsets[Math.floor(offsets.length / 2)] || 0,
    maxOffset: offsets[offsets.length - 1] || 0
  };
}
