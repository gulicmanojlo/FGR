const NOTE_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H"];

const QUALITY_DEFINITIONS = [
  { suffix: "", intervals: [0, 4, 7], priority: 0.035 },
  { suffix: "m", intervals: [0, 3, 7], priority: 0.035 },
  { suffix: "7", intervals: [0, 4, 7, 10], priority: 0 },
  { suffix: "m7", intervals: [0, 3, 7, 10], priority: 0 },
  { suffix: "maj7", intervals: [0, 4, 7, 11], priority: -0.005 },
  { suffix: "dim", intervals: [0, 3, 6], priority: -0.015 },
  { suffix: "sus4", intervals: [0, 5, 7], priority: -0.02 }
];

export const CHORD_TEMPLATES = QUALITY_DEFINITIONS.flatMap((quality) =>
  NOTE_NAMES.map((name, root) => ({
    name: `${name}${quality.suffix}`,
    root,
    suffix: quality.suffix,
    intervals: quality.intervals,
    tones: quality.intervals.map((interval) => (root + interval) % 12),
    priority: quality.priority
  }))
);

export function normalizeChromaFrame(values) {
  const source = Array.from({ length: 12 }, (_, index) => Math.max(0, Number(values?.[index]) || 0));
  const sorted = [...source].sort((a, b) => a - b);
  const noiseFloor = sorted[2] || 0;
  const compressed = source.map((value) => Math.sqrt(Math.max(0, value - noiseFloor * 0.7)));
  const total = compressed.reduce((sum, value) => sum + value, 0);
  if (!(total > 1e-8)) return new Array(12).fill(0);
  return compressed.map((value) => value / total);
}

export function detectChordFromChroma(chroma, options = {}) {
  const rawEnergy = Array.from({ length: 12 }, (_, index) => Math.max(0, Number(chroma?.[index]) || 0))
    .reduce((sum, value) => sum + value, 0);
  const minEnergy = Number.isFinite(options.minEnergy) ? options.minEnergy : 1e-5;
  if (!(rawEnergy > minEnergy)) return null;

  const normalized = normalizeChromaFrame(chroma);
  const peak = Math.max(...normalized);
  const ordered = [...normalized].sort((a, b) => a - b);
  const median = (ordered[5] + ordered[6]) / 2;
  if (peak < 0.155 || peak - median < 0.055) return null;

  const bass = normalizeChromaFrame(options.bassChroma || []);
  const keyPitchClass = Number.isInteger(options.keyPitchClass) ? mod12(options.keyPitchClass) : null;
  const keyMode = options.keyMode === "minor" ? "minor" : options.keyMode === "major" ? "major" : null;

  // A practice chart should favour stable harmonic roots over momentary
  // melody tones interpreted as maj7/sus/dim extensions. The detailed
  // detector remains available for chord tools, while offline song analysis
  // can request a deliberately conservative major/minor vocabulary.
  const templates = options.simpleChart
    ? CHORD_TEMPLATES.filter((template) => template.suffix === "" || template.suffix === "m")
    : CHORD_TEMPLATES;

  const scored = templates.map((template) => {
    const toneSet = new Set(template.tones);
    const weights = template.intervals.map((interval, index) => {
      if (interval === 0) return 1.28;
      if (index === 1) return 1.08;
      if (interval === 7) return 0.94;
      return 0.78;
    });
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    let chordCoverage = 0;
    let templateNorm = 0;
    let dot = 0;
    let chromaNorm = 0;

    template.tones.forEach((pitchClass, index) => {
      const weight = weights[index];
      chordCoverage += normalized[pitchClass] * weight;
      dot += normalized[pitchClass] * weight;
      templateNorm += weight * weight;
    });
    normalized.forEach((value) => { chromaNorm += value * value; });
    chordCoverage /= weightTotal;

    const leakage = normalized.reduce(
      (sum, value, pitchClass) => sum + (toneSet.has(pitchClass) ? 0 : value),
      0
    );
    const cosine = dot / (Math.sqrt(chromaNorm * templateNorm) || 1);
    const rootSupport = normalized[template.root];
    const bassSupport = bass[template.root] || 0;
    const thirdPitch = template.tones[1];
    const thirdSupport = normalized[thirdPitch] || 0;
    const fifthSupport = normalized[(template.root + 7) % 12] || 0;
    const missingCorePenalty = Math.max(0, 0.055 - Math.min(rootSupport, thirdSupport, fifthSupport)) * 1.2;

    let score =
      chordCoverage * 1.9 +
      cosine * 0.58 +
      rootSupport * 0.34 +
      bassSupport * 0.34 -
      leakage * 0.72 -
      missingCorePenalty +
      template.priority;

    if (keyPitchClass !== null && isDiatonicRoot(template.root, keyPitchClass, keyMode)) {
      score += 0.025;
    }

    return { template, score };
  }).sort((a, b) => b.score - a.score);

  const best = simplifyExtension(scored[0], scored, normalized);
  const runnerUp = scored.find((item) => item.template.name !== best.template.name) || scored[1];
  const margin = best.score - (runnerUp?.score ?? best.score);
  const confidence = clamp01((best.score - 0.34) * 1.55 + margin * 1.8);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.48;
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence : 0.2;
  if (best.score < minScore || confidence < minConfidence) return null;

  return {
    name: best.template.name,
    root: best.template.root,
    suffix: best.template.suffix,
    score: best.score,
    confidence,
    margin
  };
}

export function buildChordTimeline(frames, options = {}) {
  const sortedFrames = (Array.isArray(frames) ? frames : [])
    .map((frame) => normalizeFrame(frame, options))
    .filter((frame) => Number.isFinite(frame.t))
    .sort((a, b) => a.t - b.t);
  if (!sortedFrames.length) return [];

  const smoothed = smoothFrameLabels(sortedFrames, options.smoothingRadius ?? 1);
  const hop = estimateHop(smoothed);
  const maxGap = Number.isFinite(options.maxGapSeconds) ? options.maxGapSeconds : Math.max(0.5, hop * 2.5);
  const minSegment = Number.isFinite(options.minSegmentSeconds) ? options.minSegmentSeconds : Math.max(0.45, hop * 3);
  let segments = framesToSegments(smoothed, hop);
  segments = bridgeSameChordGaps(segments, maxGap);
  segments = absorbShortSegments(segments, minSegment);
  segments = mergeAdjacentSegments(segments);

  return segments
    .filter((segment) => segment.name && segment.end - segment.start >= Math.min(minSegment, hop * 2))
    .map((segment) => ({
      // Keep millisecond precision internally. The UI may still render a short
      // label, but rounding analysis results to tenths moved every transition by
      // as much as 50 ms before playback even started.
      t: Math.max(0, Math.round(segment.start * 1000) / 1000),
      n: segment.name,
      confidence: Math.round(segment.confidence * 100) / 100
    }))
    .filter((segment, index, all) => index === 0 || segment.n !== all[index - 1].n);
}

/**
 * Tighten the timestamps of an existing, human-curated chart without letting
 * the detector rewrite its harmony.
 *
 * Each old boundary is treated as a prior. In a small window around it we
 * compare every chroma frame only against the chord before and the chord after
 * that boundary. The winning split is the midpoint between two analysis-frame
 * centres, which avoids inheriting a complete hop of latency. Weak or
 * ambiguous evidence leaves the old timestamp untouched.
 */
export function refineChordBoundaries(frames, referenceChords, options = {}) {
  const references = (Array.isArray(referenceChords) ? referenceChords : []).map((chord) => ({
    ...chord,
    t: Number(chord?.t),
    n: String(chord?.n || "")
  }));
  if (!references.length) return [];

  const analyzedFrames = (Array.isArray(frames) ? frames : [])
    .map((frame) => ({
      t: Number(frame?.t),
      chroma: frame?.chroma,
      bassChroma: frame?.bassChroma,
      onsetStrength: Math.max(0, Number(frame?.onsetStrength) || 0)
    }))
    .filter((frame) => Number.isFinite(frame.t) && Array.isArray(frame.chroma))
    .sort((first, second) => first.t - second.t);

  const roundedReferences = references.map((chord) => ({
    ...chord,
    t: Number.isFinite(chord.t) ? roundMilliseconds(Math.max(0, chord.t)) : chord.t
  }));
  if (references.length < 2 || analyzedFrames.length < 4) return roundedReferences;

  const hop = estimateRawFrameHop(analyzedFrames);
  const positiveOnsets = analyzedFrames
    .map((frame) => frame.onsetStrength)
    .filter((value) => value > 0)
    .sort((first, second) => first - second);
  const onsetScale = positiveOnsets.length
    ? positiveOnsets[Math.min(positiveOnsets.length - 1, Math.floor(positiveOnsets.length * 0.92))]
    : 0;
  if (onsetScale > 1e-8) {
    analyzedFrames.forEach((frame) => {
      frame.onsetStrength = Math.min(1.5, frame.onsetStrength / onsetScale);
    });
  }
  const searchWindow = Math.max(
    hop,
    Number.isFinite(options.refinementWindowSeconds) ? options.refinementWindowSeconds : 1.2
  );
  const evidenceWindow = Math.max(
    hop * 2,
    Number.isFinite(options.evidenceWindowSeconds) ? options.evidenceWindowSeconds : 0.75
  );
  const minimumContrast = Number.isFinite(options.minBoundaryContrast)
    ? options.minBoundaryContrast
    : 0.075;
  const minimumImprovement = Number.isFinite(options.minBoundaryImprovement)
    ? options.minBoundaryImprovement
    : 0.018;
  const priorStrength = Number.isFinite(options.boundaryPriorStrength)
    ? options.boundaryPriorStrength
    : 0.035;
  const minimumGap = Math.max(0.02, hop * 0.45);
  const refined = roundedReferences.map((chord) => ({ ...chord }));

  for (let index = 1; index < references.length; index += 1) {
    const previousTemplate = chordTemplateFromName(references[index - 1].n);
    const nextTemplate = chordTemplateFromName(references[index].n);
    const oldBoundary = references[index].t;
    if (!previousTemplate || !nextTemplate || !Number.isFinite(oldBoundary)) continue;
    if (previousTemplate.name === nextTemplate.name) continue;

    const previousBoundary = Number(references[index - 1].t);
    const followingBoundary = Number(references[index + 1]?.t);
    const lowerBound = Math.max(
      Number.isFinite(previousBoundary) ? previousBoundary + minimumGap : 0,
      refined[index - 1].t + minimumGap,
      oldBoundary - searchWindow
    );
    const upperBound = Math.min(
      Number.isFinite(followingBoundary) ? followingBoundary - minimumGap : Infinity,
      oldBoundary + searchWindow
    );
    if (!(upperBound > lowerBound)) continue;

    const pairStart = Number.isFinite(previousBoundary) ? previousBoundary : oldBoundary - evidenceWindow * 2;
    const pairEnd = Number.isFinite(followingBoundary) ? followingBoundary : oldBoundary + evidenceWindow * 2;
    const scoredFrames = analyzedFrames
      .filter((frame) => frame.t >= pairStart && frame.t <= pairEnd)
      .map((frame) => ({
        ...frame,
        preference:
          scoreChromaForTemplate(frame.chroma, frame.bassChroma, previousTemplate) -
          scoreChromaForTemplate(frame.chroma, frame.bassChroma, nextTemplate)
      }));
    if (scoredFrames.length < 4) continue;

    const candidates = [];
    for (let frameIndex = 1; frameIndex < scoredFrames.length; frameIndex += 1) {
      const candidateTime = midpoint(scoredFrames[frameIndex - 1].t, scoredFrames[frameIndex].t);
      if (candidateTime < lowerBound || candidateTime > upperBound) continue;
      const candidate = scoreBoundaryCandidate(
        scoredFrames,
        candidateTime,
        evidenceWindow,
        pairStart,
        pairEnd,
        hop
      );
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) continue;

    const baseline = scoreBoundaryCandidate(
      scoredFrames,
      oldBoundary,
      evidenceWindow,
      pairStart,
      pairEnd,
      hop
    );
    candidates.forEach((candidate) => {
      // Long-window contrast chooses the correct chord pair. The short local
      // score change and an acoustic attack resolve that broad plateau to the
      // heard strum/bass onset without applying a song-wide timing offset.
      candidate.effectiveScore = candidate.contrast +
        Math.min(0.16, Math.max(0, candidate.localChange) * 0.22) +
        Math.min(0.05, Math.max(0, candidate.onsetStrength) * 0.035) -
        priorStrength * Math.abs(candidate.t - oldBoundary) / searchWindow;
    });
    candidates.sort((first, second) =>
      second.effectiveScore - first.effectiveScore ||
      Math.abs(first.t - oldBoundary) - Math.abs(second.t - oldBoundary)
    );
    const best = candidates[0];
    if (!best || best.contrast < minimumContrast) continue;

    const baselineContrast = baseline?.contrast ?? -Infinity;
    const baselineEffective = baseline
      ? baseline.contrast +
        Math.min(0.16, Math.max(0, baseline.localChange) * 0.22) +
        Math.min(0.05, Math.max(0, baseline.onsetStrength) * 0.035)
      : -Infinity;
    const isNearbyFrameSnap =
      Math.abs(best.t - oldBoundary) <= hop * 1.25 &&
      best.contrast >= baselineContrast - 0.01;
    const hasMeaningfulGain = best.effectiveScore >= baselineEffective + minimumImprovement;
    if (!isNearbyFrameSnap && !hasMeaningfulGain) continue;

    refined[index].t = roundMilliseconds(best.t);
  }

  return options.allowLabelCorrection
    ? correctRefinedChordLabels(analyzedFrames, refined, hop, options)
    : refined;
}

/**
 * Return the last chord whose boundary has actually been crossed.
 *
 * Keeping this independent from the DOM makes playback changes deterministic
 * at exact boundaries and avoids the old hard-coded 80 ms look-ahead. A song
 * may carry a small measured correction (for legacy/imported charts) through
 * `timingOffsetSeconds`: a positive value moves its boundaries later.
 */
export function findActiveChordIndex(chords, playbackTime, options = {}) {
  if (!Array.isArray(chords) || !chords.length) return -1;
  const time = Number(playbackTime);
  if (!Number.isFinite(time)) return -1;
  const timingOffset = Number.isFinite(options.timingOffsetSeconds)
    ? options.timingOffsetSeconds
    : 0;
  const target = time - timingOffset;
  let low = 0;
  let high = chords.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const boundary = Number(chords[middle]?.t);
    if (Number.isFinite(boundary) && boundary <= target + 1e-9) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function chordChartFingerprint(chords) {
  const source = (Array.isArray(chords) ? chords : [])
    .map((chord) => `${String(chord?.n || "")}@${(Number(chord?.t) || 0).toFixed(3)}`)
    .join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function needsBundledChordChartUpgrade(song, options = {}) {
  const expectedSongId = String(options.songId || "");
  const targetRevision = Math.max(1, Number(options.targetRevision) || 1);
  const fingerprints = new Set(Array.isArray(options.legacyFingerprints) ? options.legacyFingerprints : []);
  if (!song || (expectedSongId && String(song.id || "") !== expectedSongId)) return false;
  if ((Number(song.chordChartRevision) || 0) >= targetRevision) return false;
  return fingerprints.has(chordChartFingerprint(song.chords));
}

export function centerAnalysisFrameTime(frameEndTime, fftSize, sampleRate) {
  const frameEnd = Number(frameEndTime);
  const samples = Number(fftSize);
  const rate = Number(sampleRate);
  if (!Number.isFinite(frameEnd) || !(samples > 0) || !(rate > 0)) return 0;
  return Math.max(0, frameEnd - samples / rate / 2);
}

export function parseKeySignature(value) {
  const text = String(value || "")
    .trim()
    .replace(/♯/g, "is")
    .replace(/#/g, "is")
    .replace(/♭/g, "b")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  if (!text) return { keyPitchClass: null, keyMode: null };
  const aliases = [
    ["db", 1], ["eb", 3], ["gb", 6], ["ab", 8], ["bb", 10],
    ["cis", 1], ["dis", 3], ["fis", 6], ["gis", 8],
    ["c", 0], ["d", 2], ["e", 4], ["f", 5], ["g", 7], ["a", 9], ["b", 10], ["h", 11]
  ];
  const match = aliases.find(([name]) => text.startsWith(name));
  if (!match) return { keyPitchClass: null, keyMode: null };
  const rest = text.slice(match[0].length);
  return {
    keyPitchClass: match[1],
    keyMode: rest.startsWith("m") || rest.includes("mol") ? "minor" : "major"
  };
}

function normalizeFrame(frame, options) {
  if (frame?.chord && typeof frame.chord === "object") {
    return {
      t: Number(frame.t),
      name: String(frame.chord.name || "") || null,
      confidence: clamp01(Number(frame.chord.confidence) || 0)
    };
  }
  if (typeof frame?.chord === "string") {
    return { t: Number(frame.t), name: frame.chord || null, confidence: clamp01(frame.confidence ?? 0.7) };
  }
  const detection = detectChordFromChroma(frame?.chroma, {
    ...options,
    bassChroma: frame?.bassChroma
  });
  return {
    t: Number(frame?.t),
    name: detection?.name || null,
    confidence: detection?.confidence || 0
  };
}

function smoothFrameLabels(frames, radius) {
  if (!(radius > 0)) return frames;
  return frames.map((frame, index) => {
    const votes = new Map();
    for (let offset = -radius; offset <= radius; offset += 1) {
      const candidate = frames[index + offset];
      if (!candidate?.name) continue;
      const distanceWeight = 1 / (1 + Math.abs(offset));
      const vote = Math.max(0.15, candidate.confidence) * distanceWeight;
      votes.set(candidate.name, (votes.get(candidate.name) || 0) + vote);
    }
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!winner) return frame;
    const originalVote = frame.name ? (votes.get(frame.name) || 0) : 0;
    const name = winner[1] > originalVote * 1.15 ? winner[0] : frame.name;
    const matching = frames.slice(Math.max(0, index - radius), index + radius + 1)
      .filter((candidate) => candidate.name === name);
    const confidence = matching.length
      ? matching.reduce((sum, candidate) => sum + candidate.confidence, 0) / matching.length
      : frame.confidence;
    return { ...frame, name, confidence };
  });
}

function framesToSegments(frames, hop) {
  const groups = [];
  frames.forEach((frame) => {
    const current = groups[groups.length - 1];
    if (current && current.name === frame.name) {
      current.lastFrameTime = frame.t;
      current.confidenceTotal += frame.confidence;
      current.count += 1;
      current.confidence = current.confidenceTotal / current.count;
      return;
    }
    groups.push({
      name: frame.name,
      firstFrameTime: frame.t,
      lastFrameTime: frame.t,
      confidence: frame.confidence,
      confidenceTotal: frame.confidence,
      count: 1
    });
  });

  // A frame describes the audio around its centre. Therefore a label change
  // belongs halfway between the last centre carrying the old label and the
  // first centre carrying the new one. The previous implementation subtracted
  // a complete hop from the first new frame and produced overlapping segments.
  return groups.map((group, index) => {
    const previous = groups[index - 1];
    const next = groups[index + 1];
    const start = previous
      ? midpoint(previous.lastFrameTime, group.firstFrameTime)
      : Math.max(0, group.firstFrameTime - hop / 2);
    const end = next
      ? midpoint(group.lastFrameTime, next.firstFrameTime)
      : group.lastFrameTime + hop / 2;
    return {
      name: group.name,
      start,
      end: Math.max(start, end),
      confidence: group.confidence,
      confidenceTotal: group.confidenceTotal,
      count: group.count
    };
  });
}

function bridgeSameChordGaps(segments, maxGap) {
  const result = [...segments];
  for (let index = 1; index < result.length - 1; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    const next = result[index + 1];
    if (!current.name && previous.name && previous.name === next.name && current.end - current.start <= maxGap) {
      current.name = previous.name;
      current.confidence = Math.min(previous.confidence, next.confidence) * 0.85;
    }
  }
  return mergeAdjacentSegments(result);
}

function absorbShortSegments(segments, minimumDuration) {
  const result = segments.map((segment) => ({ ...segment }));
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index];
    if (current.end - current.start >= minimumDuration) continue;
    const previous = result[index - 1];
    const next = result[index + 1];

    // A brief uncertain frame between two different, stable chords is a
    // transition zone, not evidence that either chord owns the complete gap.
    // Split it at its centre so neither boundary is systematically delayed.
    if (!current.name && previous?.name && next?.name && previous.name !== next.name) {
      const boundary = midpoint(current.start, current.end);
      previous.end = boundary;
      next.start = boundary;
      current.start = boundary;
      current.end = boundary;
      continue;
    }
    const replacement = chooseNeighbor(previous, next);
    if (replacement?.name) {
      current.name = replacement.name;
      current.confidence = Math.min(current.confidence || replacement.confidence, replacement.confidence) * 0.9;
    }
  }
  return mergeAdjacentSegments(result);
}

function chooseNeighbor(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  if (previous.name && previous.name === next.name) return previous;
  if (!previous.name) return next;
  if (!next.name) return previous;
  const previousWeight = (previous.end - previous.start) * previous.confidence;
  const nextWeight = (next.end - next.start) * next.confidence;
  return previousWeight >= nextWeight ? previous : next;
}

function mergeAdjacentSegments(segments) {
  const result = [];
  segments.forEach((segment) => {
    const previous = result[result.length - 1];
    if (previous && previous.name === segment.name) {
      const previousDuration = previous.end - previous.start;
      const currentDuration = segment.end - segment.start;
      const totalDuration = previousDuration + currentDuration || 1;
      previous.end = Math.max(previous.end, segment.end);
      previous.confidence = (
        previous.confidence * previousDuration + segment.confidence * currentDuration
      ) / totalDuration;
      return;
    }
    result.push({ ...segment });
  });
  return result;
}

function simplifyExtension(best, scored, normalized) {
  if (!best) return best;
  if (!["7", "m7", "maj7"].includes(best.template.suffix)) return best;
  const triadSuffix = best.template.suffix === "m7" ? "m" : "";
  const triad = scored.find((item) =>
    item.template.root === best.template.root && item.template.suffix === triadSuffix
  );
  const seventh = best.template.suffix === "maj7" ? 11 : 10;
  const seventhStrength = normalized[(best.template.root + seventh) % 12] || 0;
  if (triad && (triad.score >= best.score - 0.045 || seventhStrength < 0.055)) return triad;
  return best;
}

function estimateHop(frames) {
  const deltas = [];
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].t - frames[index - 1].t;
    if (delta > 0 && Number.isFinite(delta)) deltas.push(delta);
  }
  if (!deltas.length) return 0.25;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

function estimateRawFrameHop(frames) {
  const deltas = [];
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].t - frames[index - 1].t;
    if (delta > 0 && Number.isFinite(delta)) deltas.push(delta);
  }
  if (!deltas.length) return 0.1;
  deltas.sort((first, second) => first - second);
  return deltas[Math.floor(deltas.length / 2)];
}

function chordTemplateFromName(chordName) {
  const source = String(chordName || "").trim().split("/")[0];
  if (!source) return null;
  const aliases = [
    ["Cis", 1], ["Dis", 3], ["Fis", 6], ["Gis", 8],
    ["C#", 1], ["D#", 3], ["F#", 6], ["G#", 8], ["A#", 10],
    ["Db", 1], ["Eb", 3], ["Gb", 6], ["Ab", 8], ["Bb", 10],
    ["C", 0], ["D", 2], ["E", 4], ["F", 5], ["G", 7], ["A", 9], ["B", 10], ["H", 11]
  ];
  const lowerSource = source.toLowerCase();
  const rootMatch = aliases.find(([alias]) => lowerSource.startsWith(alias.toLowerCase()));
  if (!rootMatch) return null;

  const qualityText = lowerSource.slice(rootMatch[0].length).replace(/\s+/g, "");
  let suffix = "";
  if (qualityText.startsWith("maj7")) suffix = "maj7";
  else if (qualityText.startsWith("m7") || qualityText.startsWith("mol7")) suffix = "m7";
  else if (qualityText.startsWith("dim")) suffix = "dim";
  else if (qualityText.startsWith("sus4") || qualityText.startsWith("sus")) suffix = "sus4";
  else if (qualityText.startsWith("m") || qualityText.startsWith("mol")) suffix = "m";
  else if (qualityText.startsWith("7")) suffix = "7";

  const definition = QUALITY_DEFINITIONS.find((quality) => quality.suffix === suffix);
  if (!definition) return null;
  const root = rootMatch[1];
  return {
    name: `${root}:${suffix}`,
    root,
    suffix,
    intervals: definition.intervals,
    tones: definition.intervals.map((interval) => mod12(root + interval))
  };
}

function scoreChromaForTemplate(chroma, bassChroma, template) {
  const normalized = normalizeChromaFrame(chroma);
  const bass = normalizeChromaFrame(bassChroma || []);
  const toneSet = new Set(template.tones);
  const weights = template.intervals.map((interval, index) => {
    if (interval === 0) return 1.25;
    if (index === 1) return 1.1;
    if (interval === 7) return 0.95;
    return 0.72;
  });
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const weightedCoverage = template.tones.reduce(
    (sum, pitchClass, index) => sum + normalized[pitchClass] * weights[index],
    0
  ) / weightTotal;
  const leakage = normalized.reduce(
    (sum, value, pitchClass) => sum + (toneSet.has(pitchClass) ? 0 : value),
    0
  );
  return weightedCoverage + normalized[template.root] * 0.31 + (bass[template.root] || 0) * 0.42 - leakage * 0.38;
}

function correctRefinedChordLabels(frames, chords, hop, options) {
  const simpleTemplates = CHORD_TEMPLATES.filter((template) => template.suffix === "" || template.suffix === "m");
  const minimumFrames = Math.max(5, Math.ceil(0.45 / Math.max(hop, 0.01)));
  const minimumCombinedGain = Number.isFinite(options.labelCorrectionGain)
    ? options.labelCorrectionGain
    : 0.055;
  const minimumHarmonicGain = Number.isFinite(options.labelHarmonicGain)
    ? options.labelHarmonicGain
    : 0.018;
  const minimumWinRatio = Number.isFinite(options.labelWinRatio)
    ? options.labelWinRatio
    : 0.58;
  const corrected = chords.map((chord) => ({ ...chord }));

  corrected.forEach((chord, index) => {
    const currentTemplate = chordTemplateFromName(chord.n);
    if (!currentTemplate || !["", "m"].includes(currentTemplate.suffix)) return;
    const segmentStart = Number(chord.t);
    const segmentEnd = Number(corrected[index + 1]?.t);
    const actualEnd = Number.isFinite(segmentEnd)
      ? segmentEnd
      : (frames[frames.length - 1]?.t || segmentStart) + hop / 2;
    const edgeGuard = Math.min(0.16, Math.max(hop, (actualEnd - segmentStart) * 0.08));
    const segmentFrames = frames.filter((frame) =>
      frame.t >= segmentStart + edgeGuard &&
      frame.t < actualEnd - edgeGuard &&
      frameEnergy(frame.chroma) > 1e-8 &&
      frameEnergy(frame.bassChroma) > 1e-8
    );
    if (segmentFrames.length < minimumFrames) return;

    const aggregates = simpleTemplates.map((template) => ({
      template,
      combined: 0,
      harmonic: 0,
      bassRoot: 0,
      wins: 0
    }));
    segmentFrames.forEach((frame) => {
      const bass = normalizeChromaFrame(frame.bassChroma);
      let frameWinner = null;
      aggregates.forEach((aggregate) => {
        const harmonicScore = scoreChromaForTemplate(frame.chroma, null, aggregate.template);
        const combinedScore = scoreChromaForTemplate(frame.chroma, frame.bassChroma, aggregate.template);
        aggregate.harmonic += harmonicScore;
        aggregate.combined += combinedScore;
        aggregate.bassRoot += bass[aggregate.template.root] || 0;
        if (!frameWinner || combinedScore > frameWinner.score) {
          frameWinner = { aggregate, score: combinedScore };
        }
      });
      if (frameWinner) frameWinner.aggregate.wins += 1;
    });

    aggregates.forEach((aggregate) => {
      aggregate.combined /= segmentFrames.length;
      aggregate.harmonic /= segmentFrames.length;
      aggregate.bassRoot /= segmentFrames.length;
      aggregate.winRatio = aggregate.wins / segmentFrames.length;
    });
    aggregates.sort((first, second) => second.combined - first.combined);
    const candidate = aggregates[0];
    const runnerUp = aggregates[1];
    const current = aggregates.find((aggregate) =>
      aggregate.template.root === currentTemplate.root && aggregate.template.suffix === currentTemplate.suffix
    );
    if (!candidate || !current || candidate.template.name === current.template.name) return;

    const sameRoot = candidate.template.root === current.template.root;
    const bassEvidence = sameRoot
      ? candidate.bassRoot >= 0.18
      : candidate.bassRoot - current.bassRoot >= 0.06;
    const stableWinner = candidate.winRatio >= minimumWinRatio;
    const harmonicGain = candidate.harmonic - current.harmonic;
    const combinedGain = candidate.combined - current.combined;
    const candidateMargin = candidate.combined - (runnerUp?.combined ?? candidate.combined);
    if (
      bassEvidence &&
      stableWinner &&
      harmonicGain >= minimumHarmonicGain &&
      combinedGain >= minimumCombinedGain &&
      candidateMargin >= 0.012
    ) {
      chord.n = candidate.template.name;
    }
  });

  return corrected.filter((chord, index, all) =>
    index === 0 || chord.n !== all[index - 1].n
  );
}

function frameEnergy(values) {
  return Array.from(values || []).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function scoreBoundaryCandidate(frames, boundary, evidenceWindow, pairStart, pairEnd, hop = 0.1) {
  const left = frames.filter((frame) =>
    frame.t < boundary && frame.t >= Math.max(pairStart, boundary - evidenceWindow)
  );
  const right = frames.filter((frame) =>
    frame.t >= boundary && frame.t <= Math.min(pairEnd, boundary + evidenceWindow)
  );
  if (left.length < 2 || right.length < 2) return null;

  const weightedMean = (items, side) => {
    let total = 0;
    let weightTotal = 0;
    items.forEach((frame) => {
      const distance = Math.abs(frame.t - boundary);
      const weight = Math.max(0.25, 1 - distance / Math.max(evidenceWindow, 1e-6));
      total += (side === "left" ? frame.preference : -frame.preference) * weight;
      weightTotal += weight;
    });
    return total / Math.max(weightTotal, 1e-8);
  };

  const leftContrast = weightedMean(left, "left");
  const rightContrast = weightedMean(right, "right");
  // A good split needs evidence on both sides. The weaker side carries more
  // weight than a simple sum so one loud chord cannot drag the boundary into
  // its neighbour's segment.
  const weakerSide = Math.min(leftContrast, rightContrast);
  const contrast = (leftContrast + rightContrast) / 2 + weakerSide * 0.2;
  const localWindow = Math.max(hop * 2.2, Math.min(0.14, evidenceWindow * 0.28));
  const localLeft = frames.filter((frame) => frame.t < boundary && frame.t >= boundary - localWindow);
  const localRight = frames.filter((frame) => frame.t >= boundary && frame.t <= boundary + localWindow);
  const meanPreference = (items) => items.length
    ? items.reduce((sum, frame) => sum + frame.preference, 0) / items.length
    : 0;
  const localChange = localLeft.length && localRight.length
    ? meanPreference(localLeft) - meanPreference(localRight)
    : 0;
  const onsetStrength = frames
    .filter((frame) => Math.abs(frame.t - boundary) <= Math.max(hop * 0.8, 0.025))
    .reduce((maximum, frame) => Math.max(maximum, Number(frame.onsetStrength) || 0), 0);
  return { t: boundary, contrast, leftContrast, rightContrast, localChange, onsetStrength };
}

function roundMilliseconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function midpoint(left, right) {
  return Number(left) + (Number(right) - Number(left)) / 2;
}

function isDiatonicRoot(root, keyPitchClass, mode) {
  if (!mode) return false;
  const intervals = mode === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return intervals.includes(mod12(root - keyPitchClass));
}

function mod12(value) {
  return ((value % 12) + 12) % 12;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
