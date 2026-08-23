import assert from "node:assert/strict";
import {
  beatAccentLevel,
  buildCountInPattern,
  buildMetronomePattern,
  clampChordBoundaryTime,
  computeTimelineFollowScroll,
  normalizeTimelineZoom,
  parseTimeSignature,
  resolveChordInsertionTime,
  stepTimelineZoom,
  timelineSecondsFromClientX,
  timelineTickSeconds,
  timelineZoomScrollLeft
} from "../js/practice-timing.js";

assert.deepEqual(parseTimeSignature("7/8"), { numerator: 7, denominator: 8, value: "7/8" });
assert.deepEqual(parseTimeSignature("bad"), { numerator: 4, denominator: 4, value: "4/4" });
assert.equal(beatAccentLevel(3, "6/8"), 1.35);

const eighthClicks = buildMetronomePattern({ signature: "4/4", rhythm: "click", subdivision: 2 });
assert.equal(eighthClicks.steps.length, 8);
assert.equal(eighthClicks.steps[0].accent, 2);
assert.equal(eighthClicks.steps[1].accent, 0.38);
assert.equal(eighthClicks.steps.reduce((sum, step) => sum + step.durationPulses, 0), 4);

const swing = buildMetronomePattern({ signature: "4/4", rhythm: "swing", swingPercent: 67 });
assert.equal(swing.subdivision, 2);
assert.equal(swing.steps[0].durationPulses, 0.67);
assert.ok(Math.abs(swing.steps[1].durationPulses - 0.33) < 1e-9);
assert.deepEqual(swing.steps[0].sounds.map((sound) => sound.type), ["kick", "hat"]);
assert.deepEqual(swing.steps[2].sounds.map((sound) => sound.type), ["snare", "hat"]);

const nonFourFourRock = buildMetronomePattern({ signature: "3/4", rhythm: "rock", subdivision: 1 });
assert.equal(nonFourFourRock.effectiveRhythm, "click");
assert.equal(nonFourFourRock.steps.length, 3);

const countIn = buildCountInPattern("3/4", 2);
assert.equal(countIn.steps.length, 6);
assert.equal(countIn.steps[0].accent, 2);
assert.equal(countIn.steps[3].accent, 2);

assert.equal(timelineSecondsFromClientX({ clientX: 250, timelineLeft: 20, pixelsPerSecond: 23, duration: 200 }), 10);
assert.equal(timelineSecondsFromClientX({ clientX: -10, timelineLeft: 20, pixelsPerSecond: 23, duration: 200 }), 0);
assert.equal(timelineSecondsFromClientX({ clientX: 9999, timelineLeft: 20, pixelsPerSecond: 23, duration: 200 }), 200);

assert.equal(normalizeTimelineZoom(null), 23);
assert.equal(normalizeTimelineZoom(500), 128);
assert.equal(stepTimelineZoom(23, 1), 32);
assert.equal(stepTimelineZoom(23, -1), 16);
assert.equal(stepTimelineZoom(128, 1), 128);
assert.equal(timelineTickSeconds(8), 15);
assert.equal(timelineTickSeconds(23), 5);
assert.equal(timelineTickSeconds(92), 1);

// The musical instant below the pointer remains below the pointer after zoom.
assert.equal(timelineZoomScrollLeft({
  scrollLeft: 100,
  viewportWidth: 500,
  anchorViewportX: 250,
  oldPixelsPerSecond: 10,
  newPixelsPerSecond: 20,
  newContentWidth: 2000
}), 450);
assert.equal(timelineZoomScrollLeft({
  scrollLeft: 1900,
  viewportWidth: 500,
  anchorViewportX: 250,
  oldPixelsPerSecond: 20,
  newPixelsPerSecond: 8,
  newContentWidth: 800
}), 300);

// A paused local seek can still report its old transport offset while recLoad
// is pending. The synchronously moved chart cursor must be used for insertion.
assert.equal(resolveChordInsertionTime({
  playbackTime: 0,
  chartCursorTime: 42.375,
  playbackRunning: false,
  duration: 215
}), 42.375);

// Once playback is running, its live clock wins over a cursor left by an
// earlier scrub. Missing cursors must not be coerced into a real zero-second
// edit position.
assert.equal(resolveChordInsertionTime({
  playbackTime: 43.1284,
  chartCursorTime: 42.375,
  playbackRunning: true,
  duration: 215
}), 43.128);
assert.equal(resolveChordInsertionTime({
  playbackTime: 75.25,
  chartCursorTime: undefined,
  playbackRunning: false,
  duration: 215
}), 75.25);
assert.equal(resolveChordInsertionTime({
  playbackTime: 220,
  chartCursorTime: null,
  playbackRunning: false,
  duration: 215
}), 215);

assert.equal(clampChordBoundaryTime({ time: 9.9, previousTime: 10, nextTime: 14, duration: 200 }), 10.05);
assert.equal(clampChordBoundaryTime({ time: 15, previousTime: 10, nextTime: 14, duration: 200 }), 13.95);
assert.equal(clampChordBoundaryTime({ time: -1, nextTime: 4, duration: 200 }), 0);
assert.equal(clampChordBoundaryTime({ time: 205, previousTime: 190, duration: 200 }), 200);
assert.equal(clampChordBoundaryTime({ time: 10.025, previousTime: 10, nextTime: 10.04, duration: 200 }), 10.025);

const follow = computeTimelineFollowScroll({
  playheadPx: 1000,
  viewportWidth: 600,
  scrollWidth: 3000,
  currentScrollLeft: 0,
  easing: 1
});
assert.equal(follow.anchorPx, 108);
assert.equal(follow.targetScrollLeft, 892);
assert.equal(follow.nextScrollLeft, 892);

console.log("practice timing tests passed");
