/**
 * Klavirski raspored akorda i ritam pratnje.
 *
 * Ranije se harmonija svirala kao blok akord u osnovnom položaju, uvek u
 * oktavi 4, jednom udaren i držan dok se akord ne promeni. To zvuči kao MIDI
 * orgulje: nema basa, nema vođenja glasova, nema ritma.
 *
 * Ovde se akord razlaže na levu ruku (bas) i desnu ruku (3-4 tona), bira se
 * obrtaj koji najmanje pomera prste u odnosu na prethodni akord, i pratnja se
 * raspoređuje po ritmičkoj mreži umesto da se drži cela dva takta.
 *
 * Sve je čisto i deterministički, pa se raspored može testirati bez zvuka.
 */

import { beatPositionAt, hasUsableBeats, timeAtBeatPosition } from "./beat-grid.js?v=166";

const DEFAULT_CHORD_RANGE = [50, 76];
const DEFAULT_BASS_RANGE = [28, 52];
const PREFERRED_BASS_MIDI = 40;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function pitchClass(value) {
  return ((Math.round(value) % 12) + 12) % 12;
}

/**
 * Broj samo ako je zaista broj.
 *
 * `Number(null)` je 0, pa bi obična provera `Number.isFinite(Number(x))`
 * prihvatila "nema vrednosti" kao MIDI 0. Za plafon desne ruke to je značilo
 * da se pratnja sklanja ispod nepostojeće melodije i trajno ostaje prikovana
 * za dno registra.
 */
function finiteOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Najbliži MIDI zadate tonske klase ciljnom tonu. */
export function nearestMidiForPitchClass(pc, target) {
  const cls = pitchClass(pc);
  const base = Math.round(target);
  let best = null;
  for (let midi = base - 12; midi <= base + 12; midi += 1) {
    if (pitchClass(midi) !== cls) continue;
    if (best === null || Math.abs(midi - target) < Math.abs(best - target)) best = midi;
  }
  return best;
}

/**
 * Tonovi desne ruke. U četvorozvuku se izostavlja kvinta: terca i septima
 * nose karakter akorda, a kvinta samo zgušnjava sredinu.
 */
export function selectVoicingTones(intervals, { dropFifth = true } = {}) {
  const tones = [...new Set((Array.isArray(intervals) ? intervals : []).map((value) => pitchClass(value)))];
  if (!dropFifth || tones.length < 4) return tones;
  const withoutFifth = tones.filter((interval) => interval !== 7);
  return withoutFifth.length >= 3 ? withoutFifth : tones;
}

/**
 * Rasporedi tonske klase uzlazno počev od dna prozora, pomerene za `rotation`
 * obrtaja. Vraća apsolutne MIDI note.
 */
function layoutRotation(rootPc, tones, rotation, bottom) {
  const ordered = tones
    .map((interval) => pitchClass(rootPc + interval))
    .sort((first, second) => first - second);
  const rotated = ordered.slice(rotation % ordered.length).concat(ordered.slice(0, rotation % ordered.length));
  const result = [];
  let previous = -Infinity;
  rotated.forEach((cls) => {
    let midi = nearestMidiForPitchClass(cls, bottom);
    while (midi < bottom) midi += 12;
    while (midi <= previous) midi += 12;
    previous = midi;
    result.push(midi);
  });
  return result;
}

/** Koliko se ruka pomerila u odnosu na prethodni akord. */
export function voiceLeadingCost(candidate, previous) {
  if (!Array.isArray(previous) || !previous.length) return 0;
  return candidate.reduce(
    (total, midi) => total + Math.min(...previous.map((old) => Math.abs(midi - old))),
    0
  );
}

/**
 * Izaberi raspored akorda: bas u levoj ruci, 3-4 tona u desnoj.
 *
 * `previous` je prethodni raspored desne ruke — bez njega bi svaki akord
 * skočio u osnovni položaj, što je upravo ono što je zvučalo mehanički.
 */
export function voiceChord(chord, options = {}) {
  if (!chord || !Number.isFinite(Number(chord.pc)) || !Array.isArray(chord.ivs)) return null;
  const {
    previous = [],
    melodyMidi = null,
    chordRange = DEFAULT_CHORD_RANGE,
    bassRange = DEFAULT_BASS_RANGE,
    previousBass = null,
    dropFifth = true
  } = options;

  const rootPc = pitchClass(chord.pc);
  const slashBass = finiteOrNull(chord.bassPc);
  const bassPc = slashBass === null ? rootPc : pitchClass(slashBass);

  // Bas: blizu udobnog registra, ali bez nepotrebnog skoka od prethodnog tona.
  const lastBass = finiteOrNull(previousBass);
  const bassTarget = lastBass === null
    ? PREFERRED_BASS_MIDI
    : (lastBass + PREFERRED_BASS_MIDI) / 2;
  let bass = nearestMidiForPitchClass(bassPc, bassTarget);
  while (bass < bassRange[0]) bass += 12;
  while (bass > bassRange[1]) bass -= 12;

  const tones = selectVoicingTones(chord.ivs, { dropFifth });
  if (!tones.length) return { bass, chord: [] };

  // Gornja granica desne ruke se spušta ispod melodije, da pratnja ne ulazi
  // u isti registar u kojem se vodi tema.
  const melody = finiteOrNull(melodyMidi);
  let ceiling = chordRange[1];
  if (melody !== null) ceiling = Math.max(chordRange[0] + 12, Math.min(ceiling, melody - 2));

  let best = null;
  for (let rotation = 0; rotation < tones.length; rotation += 1) {
    for (let shift = -12; shift <= 12; shift += 12) {
      const bottom = chordRange[0] + shift;
      const candidate = layoutRotation(rootPc, tones, rotation, bottom);
      if (candidate[0] < chordRange[0] - 12) continue;
      if (candidate[candidate.length - 1] > ceiling) continue;
      if (candidate[0] <= bass + 2) continue;
      const centre = (chordRange[0] + ceiling) / 2;
      const spreadPenalty = Math.abs((candidate[0] + candidate[candidate.length - 1]) / 2 - centre) * 0.35;
      const cost = voiceLeadingCost(candidate, previous) + spreadPenalty;
      if (!best || cost < best.cost) best = { cost, notes: candidate };
    }
  }

  // Ako nijedan raspored ne stane ispod melodije, radije se svira uži akord
  // nego da se harmonija potpuno izgubi.
  if (!best) {
    const fallback = layoutRotation(rootPc, tones, 0, chordRange[0]);
    return { bass, chord: fallback.filter((midi) => midi <= chordRange[1]) };
  }
  return { bass, chord: best.notes };
}

/**
 * Ritmički obrasci pratnje. `beat` i `duration` su u dobama od početka takta,
 * pa se isti obrazac primenjuje na bilo koji tempo iz ritmičke mreže.
 */
export const COMPING_PATTERNS = Object.freeze({
  sustained: {
    label: "Cela nota",
    beatsPerBar: 4,
    hits: [
      { beat: 0, duration: 4, voice: "bass", velocity: 0.82 },
      { beat: 0, duration: 4, voice: "chord", velocity: 0.58 }
    ]
  },
  downbeats: {
    label: "Na 1 i 3",
    beatsPerBar: 4,
    hits: [
      { beat: 0, duration: 1.8, voice: "bass", velocity: 0.88 },
      { beat: 0, duration: 1.8, voice: "chord", velocity: 0.64 },
      { beat: 2, duration: 1.8, voice: "bass", velocity: 0.72 },
      { beat: 2, duration: 1.8, voice: "chord", velocity: 0.55 }
    ]
  },
  backbeat: {
    label: "Bas 1-3, akord 2-4",
    beatsPerBar: 4,
    hits: [
      { beat: 0, duration: 0.9, voice: "bass", velocity: 0.9 },
      { beat: 1, duration: 0.8, voice: "chord", velocity: 0.66 },
      { beat: 2, duration: 0.9, voice: "bass", velocity: 0.76 },
      { beat: 3, duration: 0.8, voice: "chord", velocity: 0.6 }
    ]
  },
  arpeggio: {
    label: "Razloženo (osmine)",
    beatsPerBar: 4,
    hits: [
      { beat: 0, duration: 4, voice: "bass", velocity: 0.8 },
      { beat: 0, duration: 0.5, voice: "arp", velocity: 0.62 },
      { beat: 0.5, duration: 0.5, voice: "arp", velocity: 0.5 },
      { beat: 1, duration: 0.5, voice: "arp", velocity: 0.55 },
      { beat: 1.5, duration: 0.5, voice: "arp", velocity: 0.48 },
      { beat: 2, duration: 0.5, voice: "arp", velocity: 0.6 },
      { beat: 2.5, duration: 0.5, voice: "arp", velocity: 0.48 },
      { beat: 3, duration: 0.5, voice: "arp", velocity: 0.54 },
      { beat: 3.5, duration: 0.5, voice: "arp", velocity: 0.46 }
    ]
  },
  ballad: {
    label: "Balada",
    beatsPerBar: 4,
    hits: [
      { beat: 0, duration: 4, voice: "bass", velocity: 0.78 },
      { beat: 0, duration: 2.2, voice: "chord", velocity: 0.58 },
      { beat: 2.5, duration: 1.4, voice: "chord", velocity: 0.5 }
    ]
  },
  rumba: {
    label: "Rumba",
    beatsPerBar: 4,
    // Osnova je tresilo (3-3-2): bas na 1 i na "i" od 2, akordi na off-bitove.
    // To je ono što rumbu čini rumbom, a ravnomeran obrazac na 1 i 3 ne može
    // da dočara.
    hits: [
      { beat: 0, duration: 1.4, voice: "bass", velocity: 0.9 },
      { beat: 1.5, duration: 1.4, voice: "bass", velocity: 0.76 },
      { beat: 1, duration: 0.45, voice: "chord", velocity: 0.6 },
      { beat: 2, duration: 0.45, voice: "chord", velocity: 0.54 },
      { beat: 2.5, duration: 0.45, voice: "chord", velocity: 0.66 },
      { beat: 3.5, duration: 0.45, voice: "chord", velocity: 0.58 }
    ]
  },
  waltz: {
    label: "Valcer",
    beatsPerBar: 3,
    hits: [
      { beat: 0, duration: 1, voice: "bass", velocity: 0.86 },
      { beat: 1, duration: 0.9, voice: "chord", velocity: 0.58 },
      { beat: 2, duration: 0.9, voice: "chord", velocity: 0.52 }
    ]
  }
});

/**
 * Pretvori hartu akorda u klavirsku pratnju vezanu za ritmičku mrežu.
 *
 * Ovo je mesto gde se Faza 0 isplaćuje: bez mreže obrazac nema za šta da se
 * zakači, pa se harmonija svodi na jedan izdržan akord po promeni.
 */
export function renderHarmonyEvents(chords, grid, options = {}) {
  const {
    parseChord,
    patternName = null,
    endTime = null,
    melodyMidiAt = null,
    dropFifth = true
  } = options;
  if (typeof parseChord !== "function") return [];

  const segments = (Array.isArray(chords) ? chords : [])
    .map((chord) => ({ t: Number(chord?.t), parsed: parseChord(chord) }))
    .filter((item) => Number.isFinite(item.t) && item.parsed)
    .sort((first, second) => first.t - second.t);
  if (!segments.length) return [];

  const last = Number(endTime);
  const finalEnd = Number.isFinite(last) && last > segments[segments.length - 1].t
    ? last
    : segments[segments.length - 1].t + 4;

  // Takt i puls otkazuju nezavisno. Kada se prva doba ne zna, automatski
  // izabran obrazac bi izmislio naglaske kojih u pesmi nema — ali puls je i
  // dalje tačan, pa se akord može obnavljati po dobama bez pretpostavki.
  //
  // Izričito izabran obrazac je nešto sasvim drugo: kada korisnik kaže
  // "rumba", on time tvrdi i takt. Ta tvrdnja mora da se izvrši, inače meni
  // izgleda pokvareno.
  // "Automatski" ne znači "ništa". Analiza meri tempo, takt i sinkopiranost
  // pesme i predlaže osećaj; korisnik ne mora da zna šta je rumba da bi je
  // dobio. Njegov izbor, ako ga napravi, ima prednost.
  const chosen = COMPING_PATTERNS[patternName] || COMPING_PATTERNS[grid?.feel] || null;
  const barsUsable = hasUsableBeats(grid) && (grid.meterStatus === "ready" || Boolean(chosen));
  const pulseOnly = hasUsableBeats(grid) && !barsUsable;
  const usable = barsUsable;
  const beatsPerBar = chosen
    ? chosen.beatsPerBar
    : (usable ? grid.beatsPerBar : 4);
  const pattern = scalePatternToMeter(
    chosen || COMPING_PATTERNS[defaultPatternForMeter(beatsPerBar)],
    beatsPerBar
  );

  const events = [];
  let previousChord = [];
  let previousBass = null;

  segments.forEach((segment, index) => {
    const start = segment.t;
    const end = index + 1 < segments.length ? segments[index + 1].t : finalEnd;
    if (!(end > start)) return;

    const melodyMidi = typeof melodyMidiAt === "function" ? melodyMidiAt(start) : null;
    const voiced = voiceChord(segment.parsed, {
      previous: previousChord,
      previousBass,
      melodyMidi,
      dropFifth
    });
    if (!voiced) return;
    previousChord = voiced.chord.length ? voiced.chord : previousChord;
    previousBass = voiced.bass;

    const emitted = [];
    const push = (time, duration, midis, velocity) => {
      if (!(duration > 0.02) || !midis.length) return;
      midis.forEach((midi) => {
        events.push({ t: time, d: duration, midi, vel: velocity, role: "harmony" });
      });
      emitted.push(time);
    };

    if (pulseOnly) {
      // Bas drži ceo akord, desna ruka ga obnavlja na svakoj dobi. Bez
      // naglaska na prvoj dobi, jer se ne zna gde je.
      push(start, end - start, voiced.bass === null ? [] : [voiced.bass], 0.78);
      const firstBeat = beatPositionAt(grid, start);
      const lastBeat = beatPositionAt(grid, end);
      if (firstBeat === null || lastBeat === null) {
        push(start, end - start, voiced.chord, 0.58);
        return;
      }
      for (let position = Math.ceil(firstBeat - 1e-6); position < lastBeat - 1e-6; position += 1) {
        const time = Math.max(start, timeAtBeatPosition(grid, position));
        const stop = Math.min(end, timeAtBeatPosition(grid, position + 0.9));
        push(time, stop - time, voiced.chord, 0.54);
      }
      if (!emitted.length) push(start, end - start, voiced.chord, 0.58);
      return;
    }

    if (!usable) {
      // Bez ikakve mreže se ne izmišlja ritam koji pesma možda nema.
      push(start, end - start, voiced.bass === null ? [] : [voiced.bass], 0.8);
      push(start, end - start, voiced.chord, 0.58);
      return;
    }

    const startPosition = beatPositionAt(grid, start);
    const endPosition = beatPositionAt(grid, end);
    if (startPosition === null || endPosition === null) return;
    let arpCursor = 0;
    const firstBar = Math.floor((startPosition - grid.downbeatIndex) / beatsPerBar);

    for (let bar = firstBar; ; bar += 1) {
      const barPosition = grid.downbeatIndex + bar * beatsPerBar;
      if (barPosition >= endPosition) break;
      if (barPosition + beatsPerBar <= startPosition) continue;

      pattern.hits.forEach((hit) => {
        const position = barPosition + hit.beat;
        if (position < startPosition - 1e-6 || position >= endPosition - 1e-6) return;
        const time = timeAtBeatPosition(grid, position);
        const stopPosition = Math.min(position + hit.duration, endPosition);
        const duration = timeAtBeatPosition(grid, stopPosition) - time;
        if (hit.voice === "bass") {
          push(time, duration, voiced.bass === null ? [] : [voiced.bass], hit.velocity);
        } else if (hit.voice === "arp") {
          if (!voiced.chord.length) return;
          const midi = voiced.chord[arpCursor % voiced.chord.length];
          arpCursor += 1;
          push(time, duration, [midi], hit.velocity);
        } else {
          push(time, duration, voiced.chord, hit.velocity);
        }
      });
    }

    // Akord koji počne posle poslednjeg udara u taktu inače ne bi zazvučao.
    if (!emitted.length) {
      const duration = Math.min(end - start, 2.0);
      push(start, duration, voiced.bass === null ? [] : [voiced.bass], 0.8);
      push(start, duration, voiced.chord, 0.58);
    }
  });

  return events.sort((first, second) => first.t - second.t);
}

export function defaultPatternForMeter(beatsPerBar) {
  return Math.round(Number(beatsPerBar)) === 3 ? "waltz" : "downbeats";
}

/** Skaliraj obrazac na stvarnu dužinu takta kada se mere ne poklapaju. */
export function scalePatternToMeter(pattern, beatsPerBar) {
  const bars = Math.max(1, Math.round(Number(beatsPerBar)) || 4);
  if (!pattern || pattern.beatsPerBar === bars) return pattern;
  const factor = bars / pattern.beatsPerBar;
  return {
    ...pattern,
    beatsPerBar: bars,
    hits: pattern.hits
      .map((hit) => ({ ...hit, beat: hit.beat * factor, duration: hit.duration * factor }))
      .filter((hit) => hit.beat < bars)
  };
}
