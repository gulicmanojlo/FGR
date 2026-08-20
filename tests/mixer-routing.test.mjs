import assert from "node:assert/strict";
import test from "node:test";

import { resolveMixerControls } from "../js/mixer-routing.js";

const allStems = ["bass", "drums", "guitar", "other", "piano", "vocals"];

function instrumentalMap(source) {
  const controls = resolveMixerControls({
    melody: { status: "ready", sourceStems: [source], events: [{ t: 0, d: 1, midi: 60 }] }
  }, allStems);
  return Object.fromEntries(controls
    .filter((control) => ["Guitar", "Piano", "Other"].includes(control.suffix))
    .map((control) => [control.suffix, control.key]));
}

test("semantic mixer routes each instrumental stem exactly once", () => {
  for (const source of ["other", "piano", "guitar"]) {
    const mapping = instrumentalMap(source);
    assert.equal(mapping.Piano, source);
    assert.deepEqual(new Set(Object.values(mapping)), new Set(["other", "piano", "guitar"]));
  }
});

test("unreliable melody metadata keeps the conservative other-stem fallback", () => {
  const controls = resolveMixerControls({
    melody: { status: "low-confidence", sourceStems: ["guitar"], events: [] }
  }, allStems);
  const melody = controls.find((control) => control.role === "melody");
  assert.equal(melody.key, "other");
  assert.equal(melody.confirmed, false);
});

