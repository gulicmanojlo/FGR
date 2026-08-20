// Podela monofonih note-track eventova na muzičke fraze.
//
// Fraza je neprekinut niz tonova; pauza od bar `restSeconds` između kraja
// jednog i početka sledećeg tona je granica. Ista podela se koristi za
// prstored (reset ruke) i za A-B loop jedne fraze, pa muzičar vežba tačno
// onu celinu koju čuje kao celinu.

const DEFAULT_REST_SECONDS = 0.75;
const DEFAULT_MINIMUM_NOTES = 2;
const DEFAULT_MAXIMUM_SECONDS = 9;
const DEFAULT_MINIMUM_SECONDS = 1.5;

/**
 * Podeli predugačku frazu na najvećoj unutrašnjoj pauzi, rekurzivno.
 *
 * Gusto detektovana solo deonica ume da prođe 20+ sekundi bez pauze od
 * `restSeconds`. Takav blok nije vežbiva celina, pa se seče na mestu gde
 * muzičar ionako diše — na najdužoj pauzi između tonova — sve dok svaki deo
 * ne stane u `maximumSeconds`.
 */
function splitLongSpan(notes, maximumSeconds, minimumSeconds) {
  const span = notes[notes.length - 1].end - notes[0].t;
  if (span <= maximumSeconds || notes.length < 4) return [notes];

  let bestIndex = -1;
  let bestGap = -1;
  for (let index = 1; index < notes.length; index += 1) {
    const gap = notes[index].t - notes[index - 1].end;
    const leftSpan = notes[index - 1].end - notes[0].t;
    const rightSpan = notes[notes.length - 1].end - notes[index].t;
    if (leftSpan < minimumSeconds || rightSpan < minimumSeconds) continue;
    // Pri jednakim pauzama biraj rez bliži sredini, da delovi budu ujednačeni.
    const balance = 1 - Math.abs(leftSpan - rightSpan) / span;
    const score = gap + balance * 0.05;
    if (score > bestGap) {
      bestGap = score;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) return [notes];
  return [
    ...splitLongSpan(notes.slice(0, bestIndex), maximumSeconds, minimumSeconds),
    ...splitLongSpan(notes.slice(bestIndex), maximumSeconds, minimumSeconds)
  ];
}

/**
 * Vrati fraze kao `[{ startTime, endTime, firstIndex, lastIndex, noteCount }]`
 * u vremenu note-tracka. Kratki "siročići" od jednog tona se pripajaju
 * susednoj frazi samo kroz prag `minimumNotes` (podrazumevano ostaju svoji
 * ako su jedina fraza), a blokovi duži od `maximumSeconds` se seku na
 * najvećoj unutrašnjoj pauzi.
 */
export function detectMelodyPhrases(events, options = {}) {
  const restSeconds = Math.max(0.15, Number(options.restSeconds) || DEFAULT_REST_SECONDS);
  const minimumNotes = Math.max(1, Number(options.minimumNotes) || DEFAULT_MINIMUM_NOTES);
  const maximumSeconds = Math.max(2, Number(options.maximumSeconds) || DEFAULT_MAXIMUM_SECONDS);
  const minimumSeconds = Math.max(0.4, Number(options.minimumSeconds) || DEFAULT_MINIMUM_SECONDS);
  const notes = (Array.isArray(events) ? events : [])
    .map((event, index) => ({
      index,
      t: Number(event?.t) || 0,
      end: (Number(event?.t) || 0) + Math.max(0, Number(event?.d) || 0),
      midi: Number(event?.midi)
    }))
    .filter((note) => Number.isFinite(note.midi));
  if (!notes.length) return [];

  const phrases = [];
  let start = 0;
  for (let index = 1; index <= notes.length; index += 1) {
    const isBreak = index === notes.length || notes[index].t - notes[index - 1].end >= restSeconds;
    if (!isBreak) continue;
    splitLongSpan(notes.slice(start, index), maximumSeconds, minimumSeconds).forEach((slice) => {
      phrases.push({
        startTime: slice[0].t,
        endTime: slice.reduce((maximum, note) => Math.max(maximum, note.end), 0),
        firstIndex: slice[0].index,
        lastIndex: slice[slice.length - 1].index,
        noteCount: slice.length
      });
    });
    start = index;
  }

  if (phrases.length <= 1) return phrases;
  // Usamljeni kratki upad (npr. jedan detektovan ton usred pauze) nije
  // fraza za vežbanje: pripoji ga bližem susedu.
  const merged = [];
  phrases.forEach((phrase) => {
    const previous = merged[merged.length - 1];
    if (phrase.noteCount >= minimumNotes || !previous) {
      merged.push({ ...phrase });
      return;
    }
    // Pripajanje ne sme da probije gornju granicu trajanja. Bez ove provere
    // je jedan usamljen ton posle šest sekundi tišine pravio "frazu" od deset
    // sekundi, neupotrebljivu za vežbanje u petlji — a pošto je nastala
    // spajanjem, a ne blokom, sečenje dugih blokova je nije hvatalo.
    if (Math.max(previous.endTime, phrase.endTime) - previous.startTime > maximumSeconds) {
      merged.push({ ...phrase });
      return;
    }
    previous.endTime = Math.max(previous.endTime, phrase.endTime);
    previous.lastIndex = phrase.lastIndex;
    previous.noteCount += phrase.noteCount;
  });
  return merged;
}

/**
 * Indeks fraze koja sadrži `time` (u vremenu note-tracka). Ako je `time` u
 * pauzi, vraća sledeću frazu; posle poslednje vraća poslednju. -1 samo za
 * prazan spisak.
 */
export function phraseIndexAtTime(phrases, time) {
  const list = Array.isArray(phrases) ? phrases : [];
  if (!list.length) return -1;
  const at = Math.max(0, Number(time) || 0);
  for (let index = 0; index < list.length; index += 1) {
    if (at <= list[index].endTime) return index;
  }
  return list.length - 1;
}
