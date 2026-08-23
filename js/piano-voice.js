/**
 * Klavirski glas koji se zakazuje na tačno vreme, sa dinamikom.
 *
 * Ovo je odvojeno od `startNote`/`stopNote` u audio.js namerno. Ručno sviranje
 * mora da zazvuči odmah i drži jedan glas po dirci; vođena reprodukcija mora
 * da se zakaže unapred na WebAudio satu i sme da ima više glasova na istoj
 * dirci koji se preklapaju u repu. Deljenje jedne mape glasova bi jedno od to
 * dvoje pokvarilo.
 *
 * Semplovi su jedan velocity sloj (`*v12.mp3`), pa se dinamika gradi iz
 * pojačanja i svetline: jači udarac je glasniji i otvoreniji, tiši je mekši.
 * To nije zamena za prave slojeve, ali nosi najveći deo razlike koja se čuje.
 */

const CHANNEL_NAMES = ["melody", "bass", "harmony"];

// Referentna velocity vrednost na kojoj sempl svira svoje prirodno pojačanje.
const REFERENCE_VELOCITY = 0.78;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function normalizeVelocity(value, fallback = REFERENCE_VELOCITY) {
  // Strogo: `Number(null)` je 0, pa bi obična konverzija ton bez zadate
  // dinamike svirala na samoj granici čujnosti umesto normalnim udarcem.
  const velocity = typeof value === "number" && Number.isFinite(value)
    ? value
    : (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
  if (velocity === null) return fallback;
  // Prihvata i 0..1 i MIDI 0..127.
  return clamp(velocity > 1 ? velocity / 127 : velocity, 0.05, 1);
}

/** Pojačanje raste brže od velocity-ja, kao na pravom instrumentu. */
export function velocityGain(velocity) {
  const normalized = normalizeVelocity(velocity);
  return clamp(0.12 + 0.95 * normalized ** 1.7, 0.02, 1.15);
}

/** Jači udarac otvara više gornjih parcijala; tiši zvuči mekše i tamnije. */
export function velocityBrightness(velocity, midi) {
  const normalized = normalizeVelocity(velocity);
  const base = 900 + 5200 * normalized ** 1.35;
  // Visoki registar ionako nema sadržaj nisko, pa filtar mora da ga prati.
  return clamp(base + Math.max(0, midi - 60) * 55, 700, 16000);
}

/**
 * Duži ton u basu, kraći u diskantu — kao prigušnica na pravom klaviru.
 * Vraća vreme u sekundama za `setTargetAtTime`.
 */
export function releaseTimeConstant(midi, { pedal = false } = {}) {
  const registerScale = clamp(1.35 - (midi - 21) / 88, 0.35, 1.35);
  return (pedal ? 0.55 : 0.075) * registerScale;
}

export function createChannelBuses(context, destination) {
  const buses = new Map();
  CHANNEL_NAMES.forEach((name) => {
    const gain = context.createGain();
    gain.gain.value = 1;
    gain.connect(destination);
    buses.set(name, gain);
  });
  return buses;
}

/**
 * Zakaži jedan klavirski ton iz sempla.
 *
 * `when` i `until` su na satu AudioContext-a. Glas se sam čisti kada odsvira,
 * pa pozivalac ne mora da vodi računa o oslobađanju čvorova.
 */
export function scheduleSampleVoice(context, options) {
  const {
    buffer,
    sampleMidi,
    midi,
    when,
    until,
    velocity = REFERENCE_VELOCITY,
    destination,
    pedal = false
  } = options;
  if (!context || !buffer || !destination) return null;

  const startAt = Math.max(context.currentTime, Number(when) || context.currentTime);
  const source = context.createBufferSource();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();

  source.buffer = buffer;
  source.playbackRate.value = 2 ** ((midi - sampleMidi) / 12);

  filter.type = "lowpass";
  filter.frequency.value = velocityBrightness(velocity, midi);
  filter.Q.value = 0.4;

  const peak = velocityGain(velocity);
  // Kratak napad umesto skoka na punu vrednost: skok proizvodi klik.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.006);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(startAt);

  const voice = {
    midi,
    startAt,
    source,
    gain,
    filter,
    stopped: false,
    stop(at) {
      if (voice.stopped) return;
      voice.stopped = true;
      const releaseAt = Math.max(context.currentTime, Number(at) || context.currentTime, startAt + 0.01);
      const constant = releaseTimeConstant(midi, { pedal });
      gain.gain.cancelScheduledValues(releaseAt);
      // Zadrži dostignutu vrednost pre gašenja, inače rampa kreće od nule.
      gain.gain.setValueAtTime(Math.max(0.0001, peak), releaseAt);
      gain.gain.setTargetAtTime(0.0001, releaseAt, constant);
      try {
        source.stop(releaseAt + constant * 5 + 0.05);
      } catch {
        // BufferSource se može zaustaviti samo jednom.
      }
    },
    disconnect() {
      try { source.disconnect(); } catch { /* već otkačen */ }
      try { filter.disconnect(); } catch { /* već otkačen */ }
      try { gain.disconnect(); } catch { /* već otkačen */ }
    }
  };

  if (Number.isFinite(Number(until))) voice.stop(Number(until));
  source.addEventListener("ended", voice.disconnect, { once: true });
  return voice;
}

export { CHANNEL_NAMES, REFERENCE_VELOCITY };
