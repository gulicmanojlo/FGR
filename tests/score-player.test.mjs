import assert from "node:assert/strict";
import {
  createClockBridge,
  createScorePlayer,
  findFirstEventIndexAtOrAfter,
  findSoundingEvents,
  humanizeOffset
} from "../js/score-player.js";

function events(list) {
  return list.map(([t, d, midi], index) => ({ t, d, midi, vel: 0.7, index }));
}

// --- most između dva sata --------------------------------------------------

{
  const bridge = createClockBridge();
  // Prvi sync uvek postavlja sidro.
  assert.equal(bridge.sync(10, 100, 1).resynced, true);
  assert.equal(bridge.toContextTime(10), 100);
  assert.equal(bridge.toContextTime(11), 101, "mix sekunda = kontekst sekunda pri brzini 1");
  assert.equal(bridge.toMixTime(102), 12);

  // Savršeno praćenje ne resinhronizuje.
  assert.equal(bridge.sync(11, 101, 1).resynced, false);
  assert.equal(bridge.sync(12, 102, 1).resynced, false);
}

{
  // Dupla brzina: jedna sekunda konteksta nosi dve mix sekunde.
  const bridge = createClockBridge();
  bridge.sync(0, 0, 2);
  assert.equal(bridge.toContextTime(4), 2);
  assert.equal(bridge.toMixTime(2), 4);
}

{
  // Premotavanje je skok, ne drift.
  const bridge = createClockBridge();
  bridge.sync(10, 100, 1);
  assert.equal(bridge.sync(45, 101, 1).resynced, true, "skok unapred je premotavanje");
  assert.equal(bridge.toContextTime(45), 101);

  bridge.sync(46, 102, 1);
  assert.equal(bridge.sync(5, 103, 1).resynced, true, "skok unazad je premotavanje");
}

{
  // Promena brzine mora da resinhronizuje, inače bi zakazani tonovi ostali
  // na staroj skali.
  const bridge = createClockBridge();
  bridge.sync(10, 100, 1);
  assert.equal(bridge.sync(10.5, 100.5, 0.75).resynced, true);
  assert.equal(bridge.anchor.rate, 0.75);
}

{
  // Mali šum media sata se guta postepeno, bez resinhronizacije.
  const bridge = createClockBridge({ correctionRate: 0.5 });
  bridge.sync(10, 100, 1);
  const result = bridge.sync(11.02, 101, 1);
  assert.equal(result.resynced, false);
  assert.ok(Math.abs(result.drift - 0.02) < 1e-9);
  // Sidro je otišlo pola puta ka izmerenom, ne ceo put.
  assert.ok(Math.abs(bridge.anchor.mix - 11.01) < 1e-9);
}

{
  const bridge = createClockBridge();
  assert.equal(bridge.toContextTime(5), null, "bez sidra nema mapiranja");
  bridge.sync(1, 1, 1);
  bridge.reset();
  assert.equal(bridge.anchor, null);
}

// --- pretraga događaja -----------------------------------------------------

const line = events([[0, 0.5, 60], [1, 0.5, 62], [2, 0.5, 64], [3, 2.0, 65]]);
assert.equal(findFirstEventIndexAtOrAfter(line, -1), 0);
assert.equal(findFirstEventIndexAtOrAfter(line, 1), 1, "tačno na početku bira taj događaj");
assert.equal(findFirstEventIndexAtOrAfter(line, 1.5), 2);
assert.equal(findFirstEventIndexAtOrAfter(line, 99), 4);
assert.equal(findFirstEventIndexAtOrAfter([], 1), 0);

assert.deepEqual(findSoundingEvents(line, 1.2).map((item) => item.index), [1]);
assert.deepEqual(findSoundingEvents(line, 1.6).map((item) => item.index), [], "između tonova ništa ne zvuči");
assert.deepEqual(findSoundingEvents(line, 4.0).map((item) => item.index), [3], "dugi ton se hvata usred trajanja");
assert.deepEqual(findSoundingEvents(line, 5.0).map((item) => item.index), [], "posle kraja ne zvuči");

// --- humanizacija ----------------------------------------------------------

assert.equal(humanizeOffset(7, 0), 0, "bez amplitude nema pomeraja");
assert.equal(humanizeOffset(7, 0.01), humanizeOffset(7, 0.01), "isto seme daje isti pomeraj");
assert.notEqual(humanizeOffset(7, 0.01), humanizeOffset(8, 0.01), "različita semena se razlikuju");
for (const seed of [0, 1, 5, 99, 1234, -7]) {
  assert.ok(Math.abs(humanizeOffset(seed, 0.012)) <= 0.012 + 1e-12, `pomeraj u granicama za ${seed}`);
}

// --- scheduler -------------------------------------------------------------

function harness({ lookaheadSeconds = 0.15, humanizeSeconds = 0 } = {}) {
  const scheduled = [];
  const clock = { context: 0, mix: 0, rate: 1, playing: true };
  const player = createScorePlayer({
    getContextTime: () => clock.context,
    getMixTime: () => clock.mix,
    getPlaybackRate: () => clock.rate,
    isPlaying: () => clock.playing,
    lookaheadSeconds,
    humanizeSeconds,
    resolveVoice: (request) => {
      const voice = { ...request, stopped: false, stoppedAt: null,
        stop(at) { voice.stopped = true; voice.stoppedAt = at; } };
      scheduled.push(voice);
      return voice;
    }
  });
  return { player, clock, scheduled };
}

{
  // Tonovi ulaze u red tek kada uđu u prozor gledanja unapred.
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[0.05, 0.2, 60], [1.0, 0.2, 62], [5.0, 0.2, 64]]));
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.midi), [60], "samo ton unutar 150 ms");

  clock.mix = 0.9; clock.context = 0.9;
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.midi), [60, 62]);

  clock.mix = 2.0; clock.context = 2.0;
  player.tick();
  assert.equal(scheduled.length, 2, "daleki ton i dalje čeka");
}

{
  // Vremena se računaju na satu konteksta, ne na satu crtanja.
  const { player, clock, scheduled } = harness();
  clock.mix = 10; clock.context = 100;
  player.setTrack("melody", events([[10.1, 0.25, 60]]));
  player.tick();
  assert.equal(scheduled.length, 1);
  assert.ok(Math.abs(scheduled[0].when - 100.1) < 1e-9, "početak na tačnom kontekst vremenu");
  assert.ok(Math.abs(scheduled[0].until - 100.35) < 1e-9, "kraj prati trajanje");
}

{
  // Pri dvostrukoj brzini trajanje na satu konteksta je upola kraće.
  const { player, clock, scheduled } = harness();
  clock.mix = 0; clock.context = 0; clock.rate = 2;
  player.setTrack("melody", events([[0.1, 0.4, 60]]));
  player.tick();
  assert.ok(Math.abs(scheduled[0].when - 0.05) < 1e-9);
  assert.ok(Math.abs(scheduled[0].until - 0.25) < 1e-9);
}

{
  // Premotavanje poništava zakazano i hvata ton koji je u toku.
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[0.05, 0.2, 60], [8.0, 4.0, 71]]));
  player.tick();
  const first = scheduled[0];
  assert.equal(first.stopped, false);

  clock.mix = 9.5; clock.context = 1.0;
  player.tick();
  assert.equal(first.stopped, true, "stari glas se gasi na premotavanju");
  const resumed = scheduled[scheduled.length - 1];
  assert.equal(resumed.midi, 71, "izdržani ton se nastavlja");
  assert.ok(Math.abs(resumed.when - 1.0) < 1e-9, "nastavlja se odmah, ne od svog početka");
  // Ton se završava u mix 12.0, a to je 2.5 s posle premotavanja na 9.5.
  assert.ok(Math.abs(resumed.until - 3.5) < 1e-9, "traje do svog pravog kraja");
}

{
  // Pauza gasi sve i ne zakazuje ništa novo.
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[0.05, 0.2, 60]]));
  player.tick();
  assert.equal(scheduled.length, 1);
  clock.playing = false;
  clock.context = 0.2;
  player.tick();
  assert.equal(scheduled[0].stopped, true);
  assert.equal(scheduled.length, 1, "dok stoji, ništa se ne zakazuje");
}

{
  // Prošli tonovi se ne pale retroaktivno.
  const { player, clock, scheduled } = harness();
  clock.mix = 5; clock.context = 5;
  player.setTrack("melody", events([[0.0, 0.2, 60], [1.0, 0.2, 62], [5.05, 0.2, 64]]));
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.midi), [64]);
}

{
  // Kanali su nezavisni i mogu se utišati pojedinačno.
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[0.05, 0.2, 60]]));
  player.setTrack("bass", events([[0.05, 0.2, 36]]));
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.channel).sort(), ["bass", "melody"]);

  player.setChannelMuted("bass", true);
  clock.mix = 1.0; clock.context = 1.0;
  player.setTrack("melody", events([[1.05, 0.2, 62]]));
  player.setTrack("bass", events([[1.05, 0.2, 38]]));
  player.tick();
  assert.deepEqual(scheduled.slice(2).map((v) => v.channel), ["melody"]);
}

{
  // Humanizacija pomera početak, ali nikada preko zadate granice.
  const { player, clock, scheduled } = harness({ humanizeSeconds: 0.01 });
  player.setTrack("melody", events([[0.05, 0.2, 60], [0.06, 0.2, 64], [0.07, 0.2, 67]]));
  player.tick();
  assert.equal(scheduled.length, 3);
  const offsets = scheduled.map((v, i) => v.when - [0.05, 0.06, 0.07][i]);
  assert.ok(offsets.some((o) => Math.abs(o) > 1e-9), "bar jedan ton je pomeren");
  offsets.forEach((o) => assert.ok(Math.abs(o) <= 0.01 + 1e-12));
}

{
  // Događaj bez upotrebljivih brojeva se odbacuje pri učitavanju.
  const { player, scheduled } = harness();
  player.setTrack("melody", [
    { t: 0.05, d: 0.2, midi: 60 },
    { t: NaN, d: 0.2, midi: 62 },
    { t: 0.06, d: 0.2, midi: null },
    { t: 0.07, midi: 64 }
  ]);
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.midi).sort((a, b) => a - b), [60, 64]);
}

{
  // Nesortiran ulaz se sređuje, inače binarna pretraga laže.
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[2.0, 0.2, 64], [0.05, 0.2, 60], [1.0, 0.2, 62]]));
  // Otkucaji na svakih 25 ms, kao u stvarnom radu.
  for (let step = 0; step <= 84; step += 1) {
    clock.mix = step * 0.025;
    clock.context = clock.mix;
    player.tick();
  }
  assert.deepEqual(scheduled.map((v) => v.midi), [60, 62, 64], "svi tonovi po rastućem vremenu");
}

{
  // Ton koji je počeo i završio se između dva otkucaja ne vaskrsava.
  // (Ranije se to krpilo `catchUpHeldEvents` hakom u RAF petlji.)
  const { player, clock, scheduled } = harness();
  player.setTrack("melody", events([[1.0, 0.2, 62]]));
  clock.mix = 0; clock.context = 0;
  player.tick();
  clock.mix = 2.0; clock.context = 2.0;
  player.tick();
  assert.deepEqual(scheduled.map((v) => v.midi), [], "prošao ton se ne pali unazad");
}

console.log("score-player tests passed");
