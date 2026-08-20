function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseTimeSignature(value) {
  const match = /^(\d{1,2})\/(2|4|8|16)$/.exec(String(value || ""));
  if (!match) return { numerator: 4, denominator: 4, value: "4/4" };
  const numerator = clamp(Number(match[1]) || 4, 1, 16);
  const denominator = Number(match[2]);
  return { numerator, denominator, value: `${numerator}/${denominator}` };
}

export function beatAccentLevel(beatIndex, signature) {
  const { numerator, denominator } = parseTimeSignature(signature);
  if (beatIndex === 0) return 2;
  if (denominator === 8) {
    if (numerator === 6 && beatIndex === 3) return 1.35;
    if (numerator === 9 && (beatIndex === 3 || beatIndex === 6)) return 1.35;
    if (numerator === 7 && (beatIndex === 2 || beatIndex === 4)) return 1.25;
  }
  return 1;
}

function drumSounds(rhythm, stepIndex) {
  const sounds = [];
  if (rhythm === "rock") {
    if (stepIndex === 0 || stepIndex === 4) sounds.push({ type: "kick", level: 0.9 });
    if (stepIndex === 2 || stepIndex === 6) sounds.push({ type: "snare", level: 0.72 });
    sounds.push({ type: "hat", level: stepIndex % 2 ? 0.34 : 0.45, open: stepIndex === 7 });
  } else if (rhythm === "funk") {
    if ([0, 3, 4].includes(stepIndex)) sounds.push({ type: "kick", level: stepIndex === 3 ? 0.65 : 0.9 });
    if (stepIndex === 2 || stepIndex === 6) sounds.push({ type: "snare", level: 0.72 });
    if (stepIndex === 7) sounds.push({ type: "snare", level: 0.18, ghost: true });
    sounds.push({ type: "hat", level: stepIndex % 2 ? 0.32 : 0.44, open: stepIndex === 5 });
  } else if (rhythm === "rumba") {
    if ([0, 3, 4, 7].includes(stepIndex)) sounds.push({ type: "kick", level: 0.72 });
    if (stepIndex === 2 || stepIndex === 5) sounds.push({ type: "snare", level: 0.58 });
    sounds.push({ type: "hat", level: stepIndex % 2 ? 0.30 : 0.42, open: stepIndex === 3 });
  } else if (rhythm === "swing") {
    if (stepIndex === 0 || stepIndex === 4) sounds.push({ type: "kick", level: 0.62 });
    if (stepIndex === 2 || stepIndex === 6) sounds.push({ type: "snare", level: 0.58 });
    sounds.push({ type: "hat", level: stepIndex % 2 ? 0.30 : 0.48, open: stepIndex === 7 });
  }
  return sounds;
}

export function buildMetronomePattern(options = {}) {
  const signature = parseTimeSignature(options.signature || "4/4");
  const requestedRhythm = String(options.rhythm || "click");
  const drumPreset = ["rock", "funk", "rumba", "swing"].includes(requestedRhythm);
  const effectiveRhythm = drumPreset && signature.value !== "4/4" ? "click" : requestedRhythm;
  const requestedSubdivision = clamp(Math.round(Number(options.subdivision) || 1), 1, 4);
  const subdivision = effectiveRhythm === "click" ? requestedSubdivision : 2;
  const swingPercent = clamp(Number(options.swingPercent) || 66, 50, 75) / 100;
  const useSwing = effectiveRhythm === "swing" || (effectiveRhythm === "click" && subdivision === 2 && options.swing === true);
  const totalSteps = signature.numerator * subdivision;
  const steps = [];

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const beatIndex = Math.floor(stepIndex / subdivision);
    const subdivisionIndex = stepIndex % subdivision;
    let durationPulses = 1 / subdivision;
    if (useSwing && subdivision === 2) {
      durationPulses = subdivisionIndex === 0 ? swingPercent : 1 - swingPercent;
    }
    const accent = subdivisionIndex === 0 ? beatAccentLevel(beatIndex, signature.value) : 0.38;
    const sounds = effectiveRhythm === "click"
      ? [{ type: "click", level: accent, subdivision: subdivisionIndex !== 0 }]
      : drumSounds(effectiveRhythm, stepIndex);
    steps.push({
      stepIndex,
      beatIndex,
      subdivisionIndex,
      durationPulses,
      accent,
      sounds
    });
  }

  return {
    signature: signature.value,
    beats: signature.numerator,
    denominator: signature.denominator,
    requestedRhythm,
    effectiveRhythm,
    subdivision,
    swingPercent: Math.round(swingPercent * 100),
    measurePulses: signature.numerator,
    steps
  };
}

export function buildCountInPattern(signatureValue, bars = 1) {
  const signature = parseTimeSignature(signatureValue);
  const barCount = clamp(Math.round(Number(bars) || 0), 0, 4);
  const steps = [];
  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    for (let beatIndex = 0; beatIndex < signature.numerator; beatIndex += 1) {
      const accent = beatAccentLevel(beatIndex, signature.value);
      steps.push({
        barIndex,
        beatIndex,
        durationPulses: 1,
        accent,
        sounds: [{ type: "click", level: accent, subdivision: false, countIn: true }]
      });
    }
  }
  return { signature: signature.value, bars: barCount, beats: signature.numerator, steps };
}

export function timelineSecondsFromClientX(options = {}) {
  const clientX = Number(options.clientX) || 0;
  const timelineLeft = Number(options.timelineLeft) || 0;
  const pixelsPerSecond = Math.max(0.001, Number(options.pixelsPerSecond) || 1);
  const duration = Math.max(0, Number(options.duration) || 0);
  return clamp((clientX - timelineLeft) / pixelsPerSecond, 0, duration);
}

export const TIMELINE_ZOOM_DEFAULT = 23;
export const TIMELINE_ZOOM_STEPS = Object.freeze([8, 12, 16, 23, 32, 46, 64, 92, 128]);

export function normalizeTimelineZoom(value, fallback = TIMELINE_ZOOM_DEFAULT) {
  const number = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : TIMELINE_ZOOM_DEFAULT;
  return clamp(Number.isFinite(number) && number > 0 ? number : safeFallback, TIMELINE_ZOOM_STEPS[0], TIMELINE_ZOOM_STEPS.at(-1));
}

export function stepTimelineZoom(currentValue, direction) {
  const current = normalizeTimelineZoom(currentValue);
  if (Number(direction) > 0) {
    return TIMELINE_ZOOM_STEPS.find((value) => value > current + 0.001) || TIMELINE_ZOOM_STEPS.at(-1);
  }
  if (Number(direction) < 0) {
    return [...TIMELINE_ZOOM_STEPS].reverse().find((value) => value < current - 0.001) || TIMELINE_ZOOM_STEPS[0];
  }
  return current;
}

export function timelineZoomScrollLeft(options = {}) {
  const oldPixelsPerSecond = normalizeTimelineZoom(options.oldPixelsPerSecond);
  const newPixelsPerSecond = normalizeTimelineZoom(options.newPixelsPerSecond);
  const viewportWidth = Math.max(0, Number(options.viewportWidth) || 0);
  const anchorViewportX = clamp(
    Number.isFinite(Number(options.anchorViewportX)) ? Number(options.anchorViewportX) : viewportWidth / 2,
    0,
    viewportWidth
  );
  const scrollLeft = Math.max(0, Number(options.scrollLeft) || 0);
  const anchorTime = (scrollLeft + anchorViewportX) / oldPixelsPerSecond;
  const newContentWidth = Math.max(viewportWidth, Number(options.newContentWidth) || 0);
  return clamp(
    anchorTime * newPixelsPerSecond - anchorViewportX,
    0,
    Math.max(0, newContentWidth - viewportWidth)
  );
}

export function timelineTickSeconds(pixelsPerSecond) {
  const zoom = normalizeTimelineZoom(pixelsPerSecond);
  if (zoom >= 70) return 1;
  if (zoom >= 38) return 2;
  if (zoom >= 18) return 5;
  if (zoom >= 11) return 10;
  return 15;
}

function finiteOptional(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Resolve the timestamp used when a chord is inserted.
 *
 * A paused local seek is asynchronous because the recording buffer may still
 * need to load. The chart cursor is updated synchronously, so it owns the edit
 * position while playback is paused. During playback the transport clock owns
 * the position and any old chart cursor is deliberately ignored.
 */
export function resolveChordInsertionTime(options = {}) {
  const playbackTime = finiteOptional(options.playbackTime);
  const chartCursorTime = finiteOptional(options.chartCursorTime);
  const durationValue = finiteOptional(options.duration);
  const duration = durationValue === null ? null : Math.max(0, durationValue);
  const playbackRunning = options.playbackRunning === true;

  let time = playbackRunning && playbackTime !== null
    ? playbackTime
    : chartCursorTime !== null
      ? chartCursorTime
      : playbackTime !== null
        ? playbackTime
        : 0;

  time = Math.max(0, time);
  if (duration !== null && duration > 0) time = Math.min(time, duration);
  return Math.round(time * 1000) / 1000;
}

export function clampChordBoundaryTime(options = {}) {
  const requested = Number(options.time);
  const previousValue = Number(options.previousTime);
  const nextValue = Number(options.nextTime);
  const previous = Number.isFinite(previousValue) ? Math.max(0, previousValue) : null;
  const next = Number.isFinite(nextValue) ? Math.max(0, nextValue) : null;
  const duration = Math.max(0, Number(options.duration) || 0);
  const minimumGap = Math.max(0, Number(options.minimumGap) || 0.05);
  let minimum = previous === null ? 0 : previous + minimumGap;
  let maximum = next === null ? Math.max(duration, minimum) : next - minimumGap;

  // Very dense or legacy charts can contain boundaries closer than the normal
  // safety gap. In that case keep the boundary between its neighbours without
  // inventing a re-ordering or moving another chord.
  if (maximum < minimum) {
    minimum = previous === null ? 0 : previous;
    maximum = next === null ? Math.max(duration, minimum) : Math.max(minimum, next);
  }

  const fallback = Number.isFinite(requested) ? requested : minimum;
  return Math.round(clamp(fallback, minimum, maximum) * 1000) / 1000;
}

export function computeTimelineFollowScroll(options = {}) {
  const viewportWidth = Math.max(0, Number(options.viewportWidth) || 0);
  const scrollWidth = Math.max(viewportWidth, Number(options.scrollWidth) || viewportWidth);
  const current = clamp(Number(options.currentScrollLeft) || 0, 0, Math.max(0, scrollWidth - viewportWidth));
  const playheadPx = Math.max(0, Number(options.playheadPx) || 0);
  const anchor = clamp(viewportWidth * (Number(options.anchorRatio) || 0.18), 76, 132);
  const maximum = Math.max(0, scrollWidth - viewportWidth);
  const target = clamp(playheadPx - anchor, 0, maximum);
  const easing = clamp(Number(options.easing) || 0.32, 0.05, 1);
  const delta = target - current;
  return {
    anchorPx: anchor,
    targetScrollLeft: target,
    nextScrollLeft: Math.abs(delta) < 0.75 ? target : clamp(current + delta * easing, 0, maximum)
  };
}
