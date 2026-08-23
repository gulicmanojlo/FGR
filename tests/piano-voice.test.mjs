import assert from "node:assert/strict";
import {
  CHANNEL_NAMES,
  normalizeVelocity,
  releaseTimeConstant,
  velocityBrightness,
  velocityGain
} from "../js/piano-voice.js";

// --- normalizacija velocity-ja ---------------------------------------------

assert.equal(normalizeVelocity(0.5), 0.5);
assert.equal(normalizeVelocity(64), 64 / 127, "MIDI opseg se prepoznaje i skalira");
assert.equal(normalizeVelocity(127), 1);
assert.equal(normalizeVelocity(0), 0.05, "nula se podiže na najtiši čujan udarac");
assert.equal(normalizeVelocity(5), 0.05, "MIDI 5 je i dalje vrlo tiho");
// Svaka vrednost preko 1 se čita kao MIDI, pa je 2 tih udarac, a ne "0..1
// prekoračeno pa saseci na 1". Pravilo mora biti dosledno u oba smera.
assert.equal(normalizeVelocity(2), 0.05, "2 je MIDI velocity 2, dakle vrlo tiho");
assert.equal(normalizeVelocity(100), 100 / 127);
assert.equal(normalizeVelocity(null), 0.78, "bez vrednosti se koristi referenca");
assert.equal(normalizeVelocity(undefined), 0.78);
assert.equal(normalizeVelocity("nije broj"), 0.78);
assert.equal(normalizeVelocity(NaN, 0.4), 0.4, "rezervna vrednost se poštuje");

// --- pojačanje --------------------------------------------------------------

assert.ok(velocityGain(0.9) > velocityGain(0.3), "jači udarac je glasniji");
assert.ok(velocityGain(0.3) > 0, "tih ton se i dalje čuje");
// Rast je brži od linearnog, kao na pravom instrumentu.
{
  const low = velocityGain(0.3) - velocityGain(0.2);
  const high = velocityGain(0.9) - velocityGain(0.8);
  assert.ok(high > low, "razlika raste ka jačem kraju");
}
for (const v of [0, 0.01, 0.5, 1, 127, -5]) {
  const gain = velocityGain(v);
  assert.ok(gain > 0 && gain <= 1.15, `pojačanje ostaje u granicama za ${v} (${gain})`);
}

// --- svetlina ---------------------------------------------------------------

assert.ok(velocityBrightness(0.9, 60) > velocityBrightness(0.3, 60), "jači udarac je svetliji");
assert.ok(velocityBrightness(0.6, 84) > velocityBrightness(0.6, 60), "visoki registar traži viši filtar");
for (const [v, m] of [[0, 21], [1, 108], [0.5, 60], [127, 60]]) {
  const hz = velocityBrightness(v, m);
  assert.ok(hz >= 700 && hz <= 16000, `granična frekvencija je razumna za ${v}/${m} (${hz})`);
}

// --- otpuštanje -------------------------------------------------------------

assert.ok(releaseTimeConstant(36) > releaseTimeConstant(84), "bas se gasi duže od diskanta");
assert.ok(
  releaseTimeConstant(60, { pedal: true }) > releaseTimeConstant(60) * 4,
  "pedala bitno produžava ton"
);
for (const midi of [21, 60, 108]) {
  assert.ok(releaseTimeConstant(midi) > 0, `konstanta je pozitivna za ${midi}`);
  assert.ok(releaseTimeConstant(midi) < 1, `konstanta nije predugačka za ${midi}`);
}

// --- kanali -----------------------------------------------------------------

assert.deepEqual(CHANNEL_NAMES, ["melody", "bass", "harmony"]);

console.log("piano-voice tests passed");
