/**
 * Zakazivanje vođene reprodukcije unapred, na satu WebAudio-a.
 *
 * Ranije se svaki ton palio i gasio iz `requestAnimationFrame` petlje, u
 * trenutku u kojem je frejm slučajno stigao. Muzičko vreme je time bilo
 * vezano za brzinu crtanja ekrana: 16.7 ms u najboljem slučaju, a 50-200 ms
 * kada glavna nit crta talasni oblik. Ovde se tonovi umesto toga zakazuju
 * 150 ms unapred na `AudioContext` satu, koji ne zna za crtanje.
 *
 * Sat reprodukcije (`<audio>` element ili YouTube) i sat AudioContext-a nisu
 * isti sat, pa se između njih drži mapiranje sa korekcijom drifta. Skok u tom
 * mapiranju znači premotavanje i traži da se zakazani tonovi ponište.
 *
 * Čiste funkcije ispod su izvučene tako da se ponašanje sata i izbor događaja
 * mogu testirati bez audio konteksta.
 */

const DEFAULT_LOOKAHEAD_SECONDS = 0.15;
const DEFAULT_TICK_MS = 25;
const DEFAULT_SEEK_THRESHOLD = 0.12;
const CATCH_UP_WINDOW_SECONDS = 4;
// Ton bez trajanja i dalje treba da se čuje. Bez ovoga bi se tiho izgubio,
// što je gore od kratkog tona: linija bi imala rupu bez ikakvog traga.
const MINIMUM_EVENT_SECONDS = 0.05;

/**
 * Broj samo ako je zaista broj. `Number(null)` je 0, a `Number("")` je 0, pa
 * bi obična konverzija propustila prazno polje kao validnu MIDI notu C-2.
 */
function strictNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Most između sata reprodukcije (mix sekunde) i sata AudioContext-a.
 *
 * Mali driftovi se ispravljaju postepeno, da se mapiranje ne trza. Veliki
 * skok se prijavljuje kao `resynced`, jer to nije drift nego premotavanje.
 */
export function createClockBridge(options = {}) {
  const seekThreshold = Number(options.seekThreshold) || DEFAULT_SEEK_THRESHOLD;
  const correctionRate = Number.isFinite(Number(options.correctionRate))
    ? Number(options.correctionRate)
    : 0.12;
  let anchor = null;

  function reset() {
    anchor = null;
  }

  function sync(mixTime, contextTime, rate) {
    const mix = Number(mixTime);
    const ctx = Number(contextTime);
    const speed = Number(rate) > 0 ? Number(rate) : 1;
    if (!Number.isFinite(mix) || !Number.isFinite(ctx)) return { resynced: false, drift: 0 };

    if (!anchor) {
      anchor = { mix, ctx, rate: speed };
      return { resynced: true, drift: 0 };
    }
    const predicted = anchor.mix + (ctx - anchor.ctx) * anchor.rate;
    const drift = mix - predicted;
    if (Math.abs(drift) > seekThreshold || speed !== anchor.rate) {
      anchor = { mix, ctx, rate: speed };
      return { resynced: true, drift };
    }
    // Pomeri sidro na sadašnjost i pojedi samo deo greške; puna korekcija bi
    // svaki otkucaj pomerila zakazane tonove za merni šum media sata.
    anchor = { mix: predicted + drift * correctionRate, ctx, rate: speed };
    return { resynced: false, drift };
  }

  return {
    sync,
    reset,
    get anchor() {
      return anchor ? { ...anchor } : null;
    },
    toContextTime(mixTime) {
      if (!anchor) return null;
      const mix = Number(mixTime);
      return Number.isFinite(mix) ? anchor.ctx + (mix - anchor.mix) / anchor.rate : null;
    },
    toMixTime(contextTime) {
      if (!anchor) return null;
      const ctx = Number(contextTime);
      return Number.isFinite(ctx) ? anchor.mix + (ctx - anchor.ctx) * anchor.rate : null;
    }
  };
}

/** Prvi događaj koji počinje u ili posle datog vremena (binarna pretraga). */
export function findFirstEventIndexAtOrAfter(events, time) {
  const list = Array.isArray(events) ? events : [];
  const target = Number(time);
  if (!list.length || !Number.isFinite(target)) return list.length;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(list[middle].t) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Događaji koji su već počeli a još traju u datom trenutku.
 * Posle premotavanja usred izdržanog tona linija mora da se nastavi, a ne da
 * ćuti do sledeće note.
 */
export function findSoundingEvents(events, time, windowSeconds = CATCH_UP_WINDOW_SECONDS) {
  const list = Array.isArray(events) ? events : [];
  const target = Number(time);
  if (!list.length || !Number.isFinite(target)) return [];
  const result = [];
  const earliest = target - Math.abs(Number(windowSeconds) || CATCH_UP_WINDOW_SECONDS);
  for (let index = findFirstEventIndexAtOrAfter(list, earliest); index < list.length; index += 1) {
    const event = list[index];
    const start = Number(event.t);
    if (start > target) break;
    if (start + Math.max(0, Number(event.d) || 0) > target) result.push({ event, index });
  }
  return result;
}

/**
 * Deterministički mikro-pomeraj u sekundama iz celobrojnog semena.
 * Mora biti deterministički: ista fraza u petlji ne sme svaki put da se
 * pomeri drugačije, jer bi to zvučalo kao nestabilan tempo, a ne kao čovek.
 */
export function humanizeOffset(seed, amountSeconds) {
  const amount = Math.abs(Number(amountSeconds) || 0);
  if (!amount) return 0;
  let hash = Math.imul(Math.trunc(Number(seed) || 0) ^ 0x9e3779b9, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return (hash / 0xffffffff * 2 - 1) * amount;
}

/**
 * Scheduler koji sam odlučuje šta treba da zazvuči u narednom prozoru.
 *
 * `resolveVoice` dobija već izračunata apsolutna vremena na AudioContext satu
 * i vraća objekat sa `stop(at)`; sve što je specifično za zvuk ostaje izvan
 * ovog modula.
 */
export function createScorePlayer(config = {}) {
  const {
    getContextTime,
    getMixTime,
    getPlaybackRate = () => 1,
    isPlaying = () => true,
    resolveVoice,
    lookaheadSeconds = DEFAULT_LOOKAHEAD_SECONDS,
    tickMs = DEFAULT_TICK_MS,
    humanizeSeconds = 0,
    onScheduled = null
  } = config;

  const bridge = createClockBridge({ seekThreshold: config.seekThreshold });
  const tracks = new Map();
  let voices = new Set();
  let timer = null;

  function trackState(channel) {
    if (!tracks.has(channel)) tracks.set(channel, { events: [], cursor: 0, muted: false });
    return tracks.get(channel);
  }

  function releaseVoices(at) {
    voices.forEach((voice) => {
      try { voice.stop(at); } catch { /* glas je već otpušten */ }
    });
    voices = new Set();
  }

  function resetCursors(mixTime) {
    tracks.forEach((track) => {
      track.cursor = findFirstEventIndexAtOrAfter(track.events, mixTime);
    });
  }

  function emit(channel, event, index, startMix, endMix, rate) {
    if (endMix <= startMix) return;
    const jitter = event.t >= startMix ? humanizeOffset(index * 31 + channel.length, humanizeSeconds) : 0;
    const when = bridge.toContextTime(startMix + jitter);
    const until = bridge.toContextTime(endMix);
    if (when === null || until === null) return;
    const voice = resolveVoice({
      channel,
      midi: event.midi,
      velocity: event.vel,
      when,
      until,
      event,
      index,
      rate
    });
    if (!voice) return;
    voices.add(voice);
    if (onScheduled) onScheduled({ channel, event, index, when, until });
  }

  function tick() {
    if (typeof getContextTime !== "function" || typeof getMixTime !== "function") return;
    const contextTime = Number(getContextTime());
    const mixTime = Number(getMixTime());
    if (!Number.isFinite(contextTime) || !Number.isFinite(mixTime)) return;

    if (!isPlaying()) {
      if (voices.size) releaseVoices(contextTime);
      bridge.reset();
      return;
    }

    const rate = Number(getPlaybackRate()) > 0 ? Number(getPlaybackRate()) : 1;
    const { resynced } = bridge.sync(mixTime, contextTime, rate);
    if (resynced) {
      releaseVoices(contextTime);
      resetCursors(mixTime);
      tracks.forEach((track, channel) => {
        if (track.muted) return;
        findSoundingEvents(track.events, mixTime).forEach(({ event, index }) => {
          emit(channel, event, index, mixTime, event.t + (Number(event.d) || 0), rate);
        });
      });
    }

    const horizon = mixTime + Math.abs(lookaheadSeconds) * rate;
    tracks.forEach((track, channel) => {
      if (track.muted) return;
      while (track.cursor < track.events.length) {
        const event = track.events[track.cursor];
        const start = Number(event.t);
        if (!(start <= horizon)) break;
        track.cursor += 1;
        const end = start + Math.max(0, Number(event.d) || 0);
        if (end <= mixTime) continue;
        emit(channel, event, track.cursor - 1, Math.max(start, mixTime), end, rate);
      }
    });
  }

  return {
    /** Zameni liniju jednog kanala; zakazani tonovi tog kanala se poništavaju. */
    setTrack(channel, events) {
      const track = trackState(String(channel));
      track.events = (Array.isArray(events) ? events : [])
        .map((event) => {
          const start = strictNumber(event?.t);
          const midi = strictNumber(event?.midi);
          if (start === null || midi === null) return null;
          const duration = strictNumber(event?.d);
          return {
            ...event,
            t: start,
            midi,
            d: duration !== null && duration > 0 ? duration : MINIMUM_EVENT_SECONDS
          };
        })
        .filter(Boolean)
        .sort((first, second) => first.t - second.t);
      track.cursor = 0;
      bridge.reset();
    },
    setChannelMuted(channel, muted) {
      trackState(String(channel)).muted = Boolean(muted);
      if (muted) bridge.reset();
    },
    clearTrack(channel) {
      const track = trackState(String(channel));
      track.events = [];
      track.cursor = 0;
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(tick, Math.max(5, tickMs));
      tick();
    },
    stop(at) {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      releaseVoices(at);
      bridge.reset();
    },
    /** Ručni otkucaj: koristi se u testovima i kao rezerva iz RAF petlje. */
    tick,
    get scheduledVoiceCount() {
      return voices.size;
    },
    get clock() {
      return bridge;
    }
  };
}

export { DEFAULT_LOOKAHEAD_SECONDS, DEFAULT_TICK_MS };
