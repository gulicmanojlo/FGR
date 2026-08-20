import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnalysisProgressView,
  isProcessingActive,
  mergeProcessingProgress
} from "../js/analysis-progress.js";

test("shows a single recording action before a YouTube source exists", () => {
  const view = buildAnalysisProgressView({ videoId: "abc", processing: { state: "queued" } }, { localAudio: false });
  assert.equal(view.state, "awaiting-source");
  assert.equal(view.canRecord, true);
  assert.equal(view.canRetry, false);
  assert.equal(view.percent, 0);
});

test("keeps the record action visible when a shared YouTube tab was silent", () => {
  const view = buildAnalysisProgressView({
    videoId: "abc",
    processing: { state: "failed", message: "Deli audio taba" }
  }, { localAudio: false });
  assert.equal(view.state, "failed");
  assert.equal(view.canRecord, true);
  assert.equal(view.message, "Deli audio taba");
});

test("uses live worker percentage and stage name", () => {
  const view = buildAnalysisProgressView({
    processing: { state: "separating", stage: "separation", percent: 47, message: "Demucs 62%" }
  }, { localAudio: true });
  assert.equal(view.percent, 47);
  assert.equal(view.title, "Razdvajanje AI kanala");
  assert.equal(view.message, "Demucs 62%");
  assert.equal(view.active, true);
});

test("shows the upload as the opening part of the single analysis progress", () => {
  const view = buildAnalysisProgressView({
    processing: { state: "queued", phase: "upload", percent: 3, message: "Slanje audio fajla 60%" }
  }, { localAudio: true });
  assert.equal(view.percent, 3);
  assert.equal(view.title, "Slanje audio fajla");
  assert.equal(view.message, "Slanje audio fajla 60%");
  assert.equal(view.active, true);
});

test("active retry progress wins over retained ready stems", () => {
  const view = buildAnalysisProgressView({
    stems: true,
    availableStems: ["vocals", "bass", "drums", "guitar", "piano", "other"],
    chords: [{ t: 0, n: "Am" }],
    processing: { state: "analyzing", percent: 90 }
  }, { localAudio: true });
  assert.equal(view.state, "analyzing");
  assert.equal(view.percent, 90);
  assert.equal(view.active, true);
});

test("a ready job still shows asset loading until local stems arrive", () => {
  const view = buildAnalysisProgressView({
    stems: false,
    processing: { state: "ready", percent: 100 }
  }, { localAudio: true });
  assert.equal(view.state, "processing");
  assert.equal(view.percent, 99);
  assert.equal(view.active, true);
});

test("failed jobs expose retry without pretending progress is active", () => {
  const view = buildAnalysisProgressView({
    processing: { state: "failed", percent: 63, message: "Separator nije uspeo" }
  }, { localAudio: true });
  assert.equal(view.canRetry, true);
  assert.equal(view.active, false);
  assert.equal(view.percent, 63);
});

test("processing state helper recognizes every active public state", () => {
  for (const state of ["queued", "downloading", "separating", "analyzing", "processing"]) {
    assert.equal(isProcessingActive({ state }), true);
  }
  assert.equal(isProcessingActive({ state: "ready" }), false);
});

test("upload-to-worker progress never moves backwards", () => {
  const states = [
    { state: "queued", phase: "upload", percent: 5 },
    { state: "queued", phase: "source", percent: 0 },
    { state: "separating", phase: "separation", percent: 5 },
    { state: "separating", phase: "separation", percent: 22 }
  ];
  const merged = states.slice(1).reduce(
    (result, next) => [...result, mergeProcessingProgress(result.at(-1), next)],
    [states[0]]
  );
  assert.deepEqual(merged.map((entry) => entry.percent), [5, 5, 5, 22]);
  assert.equal(merged[1].phase, "source");
});
