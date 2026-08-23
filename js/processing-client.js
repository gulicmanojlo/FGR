import { normalizeBeatGrid } from "./beat-grid.js?v=174";
import { createPcmWavFile } from "./pcm-wav.js?v=174";

/**
 * Browser client for the FGR audio-processing service.
 *
 * The module deliberately has no DOM or application-state dependency. An empty
 * base URL puts it in local-only mode, which lets the UI keep an imported File
 * while reporting the contract's `needs-service` state.
 */

export const PROCESSING_STATES = Object.freeze([
  "queued",
  "downloading",
  "separating",
  "analyzing",
  "ready",
  "failed",
  "needs-service"
]);

export const TERMINAL_PROCESSING_STATES = Object.freeze([
  "ready",
  "failed",
  "needs-service"
]);

export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_PROCESSING_SERVICE_URL = "http://127.0.0.1:8765";

const STATE_ALIASES = Object.freeze({
  pending: "queued",
  waiting: "queued",
  uploading: "queued",
  download: "downloading",
  separating_stems: "separating",
  separation: "separating",
  processing: "analyzing",
  running: "analyzing",
  in_progress: "analyzing",
  analysis: "analyzing",
  complete: "ready",
  completed: "ready",
  success: "ready",
  succeeded: "ready",
  error: "failed",
  cancelled: "failed",
  canceled: "failed",
  offline: "needs-service",
  local: "needs-service"
});

const DEFAULT_STAGE = Object.freeze({
  queued: "source",
  downloading: "source",
  separating: "stems",
  analyzing: "chords",
  ready: "complete",
  failed: "error",
  "needs-service": "source"
});

export class ProcessingClientError extends Error {
  constructor(message, options = {}) {
    super(String(message || "Processing service request failed."));
    this.name = "ProcessingClientError";
    this.code = String(options.code || "processing-error");
    this.status = Number.isFinite(Number(options.status)) ? Number(options.status) : 0;
    this.retryable = Boolean(options.retryable);
    this.details = options.details ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      details: this.details
    };
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function cleanString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function createYouTubeCaptureMetadata(options = {}, audioBuffer = null, bitDepth = 24) {
  const videoId = cleanString(options.videoId);
  if (videoId && !/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) {
    throw new ProcessingClientError("YouTube video ID is invalid.", { code: "invalid-youtube-video-id" });
  }
  const videoUrl = cleanString(firstValue(options.videoUrl, options.url));
  if (videoUrl) {
    let parsed;
    try { parsed = new URL(videoUrl); } catch (cause) {
      throw new ProcessingClientError("YouTube URL is invalid.", { code: "invalid-youtube-url", cause });
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const officialHost = host === "youtu.be"
      || host === "youtube.com"
      || host.endsWith(".youtube.com")
      || host === "youtube-nocookie.com"
      || host.endsWith(".youtube-nocookie.com");
    if (parsed.protocol !== "https:" || !officialHost) {
      throw new ProcessingClientError("YouTube URL must use an official HTTPS host.", { code: "invalid-youtube-url" });
    }
  }
  const metadata = {
    type: "youtube-capture",
    captureMethod: "browser-decoded-pcm",
    defaultPlaybackMode: "local-mix",
    capturedAt: cleanString(options.capturedAt) || new Date().toISOString(),
    audio: {
      container: "wav",
      codec: "pcm",
      bitDepth,
      ...(audioBuffer ? {
        sampleRate: Math.round(Number(audioBuffer.sampleRate) || 0),
        channels: Math.round(Number(audioBuffer.numberOfChannels) || 0),
        frames: Math.round(Number(audioBuffer.length) || 0)
      } : {})
    }
  };
  if (videoId) metadata.videoId = videoId;
  if (videoUrl) metadata.videoUrl = videoUrl;
  const title = cleanString(options.title);
  if (title) metadata.title = title.slice(0, 300);
  const videoOffsetSeconds = Number(options.videoOffsetSeconds);
  if (Number.isFinite(videoOffsetSeconds) && videoOffsetSeconds >= 0) {
    metadata.videoOffsetSeconds = Math.round(videoOffsetSeconds * 1000) / 1000;
  }
  return metadata;
}

function normalizeSha256(value) {
  const digest = cleanString(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : "";
}

function hasHeader(headers, name) {
  const wanted = String(name).toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function mergeHeaders(...sources) {
  const result = {};
  sources.forEach((source) => {
    if (!source) return;
    if (typeof source.forEach === "function") {
      source.forEach((value, key) => { result[String(key)] = String(value); });
      return;
    }
    if (Array.isArray(source)) {
      source.forEach(([key, value]) => { result[String(key)] = String(value); });
      return;
    }
    Object.entries(source).forEach(([key, value]) => {
      if (value !== undefined && value !== null) result[key] = String(value);
    });
  });
  return result;
}

/** Empty is a valid value and means that processing stays in the browser. */
export function normalizeBaseUrl(value, { allowEmpty = true } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (allowEmpty) return "";
    throw new ProcessingClientError("Processing service URL is required.", {
      code: "invalid-base-url"
    });
  }

  const input = String(value).trim();
  if (/^[\u0000-\u0020]/.test(input) || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new ProcessingClientError("Processing service URL contains invalid characters.", {
      code: "invalid-base-url"
    });
  }

  if (/^(?:\/|\.\/|\.\.\/)/.test(input) && !input.startsWith("//")) {
    if (/[?#]/.test(input)) {
      throw new ProcessingClientError("Processing service URL cannot contain a query or fragment.", {
        code: "invalid-base-url"
      });
    }
    return input.replace(/\/+$/, "") || "/";
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch (cause) {
    throw new ProcessingClientError("Processing service URL must be HTTP(S) or root-relative.", {
      code: "invalid-base-url",
      cause
    });
  }

  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProcessingClientError("Processing service URL must be an HTTP(S) URL without credentials, query, or fragment.", {
      code: "invalid-base-url"
    });
  }

  return parsed.href.replace(/\/+$/, "");
}

export const validateBaseUrl = normalizeBaseUrl;

export function normalizeSongId(value) {
  if (value === undefined || value === null) {
    throw new ProcessingClientError("Song ID is required.", { code: "invalid-song-id" });
  }
  const songId = String(value).trim();
  if (!/^[a-z0-9_-]{1,64}$/.test(songId)) {
    throw new ProcessingClientError("Song ID is invalid.", {
      code: "invalid-song-id",
      details: { songId }
    });
  }
  return songId;
}

export const validateSongId = normalizeSongId;

export function buildSongEndpoint(baseUrl, songId, resource) {
  const base = normalizeBaseUrl(baseUrl, { allowEmpty: false }).replace(/\/+$/, "");
  const id = encodeURIComponent(normalizeSongId(songId));
  const suffix = cleanString(resource).replace(/^\/+|\/+$/g, "");
  if (!suffix || /[?#]/.test(suffix)) {
    throw new ProcessingClientError("Processing resource is invalid.", { code: "invalid-resource" });
  }
  return `${base}/v1/songs/${id}/${suffix}`;
}

function canonicalState(value, fallback = "queued") {
  const raw = cleanString(value).toLowerCase().replace(/[ -]+/g, "_");
  const mapped = STATE_ALIASES[raw] || raw;
  if (PROCESSING_STATES.includes(mapped)) return mapped;
  return PROCESSING_STATES.includes(fallback) ? fallback : "failed";
}

export function normalizeProcessingState(value, fallback = {}) {
  const outer = isObject(value) ? value : {};
  const source = isObject(outer.processing)
    ? outer.processing
    : isObject(outer.status)
      ? outer.status
      : outer;
  const fallbackObject = typeof fallback === "string" ? { state: fallback } : (fallback || {});
  const errorValue = firstValue(source.error, outer.error);
  const rawState = firstValue(
    source.state,
    typeof source.status === "string" ? source.status : undefined,
    errorValue ? "failed" : undefined,
    fallbackObject.state,
    "queued"
  );
  const normalizedRaw = cleanString(rawState).toLowerCase().replace(/[ -]+/g, "_");
  const knownRaw = PROCESSING_STATES.includes(normalizedRaw) || Boolean(STATE_ALIASES[normalizedRaw]);
  const state = canonicalState(rawState, knownRaw ? "queued" : "failed");
  const normalizedError = errorValue ? normalizeProcessingError(errorValue) : null;
  const progressSource = isObject(source.progress) ? source.progress : {};
  const rawPercent = firstValue(
    source.percent,
    source.progressPercent,
    source.progress_percent,
    progressSource.percent,
    fallbackObject.percent,
    fallbackObject.progress?.percent
  );
  const percentNumber = Number(rawPercent);
  const percent = Number.isFinite(percentNumber)
    ? Math.max(0, Math.min(100, Math.round(percentNumber * 10) / 10))
    : state === "ready" ? 100 : 0;
  const phase = cleanString(firstValue(source.phase, progressSource.phase, fallbackObject.phase));
  const phaseIndex = Math.max(0, Number(firstValue(
    source.phaseIndex,
    source.phase_index,
    progressSource.phaseIndex,
    progressSource.phase_index,
    fallbackObject.phaseIndex,
    0
  )) || 0);
  const phaseCount = Math.max(0, Number(firstValue(
    source.phaseCount,
    source.phase_count,
    progressSource.phaseCount,
    progressSource.phase_count,
    fallbackObject.phaseCount,
    0
  )) || 0);
  const etaSecondsValue = Number(firstValue(
    source.etaSeconds,
    source.eta_seconds,
    progressSource.etaSeconds,
    progressSource.eta_seconds,
    fallbackObject.etaSeconds
  ));
  const stageDetail = isObject(firstValue(source.stageDetail, source.stage_detail, progressSource.stageDetail))
    ? firstValue(source.stageDetail, source.stage_detail, progressSource.stageDetail)
    : {};

  return {
    state,
    stage: cleanString(firstValue(source.stage, fallbackObject.stage, DEFAULT_STAGE[state])),
    message: cleanString(firstValue(
      source.message,
      source.statusMessage,
      source.detail,
      normalizedError?.message,
      fallbackObject.message,
      knownRaw ? "" : `Unknown processing state: ${cleanString(rawState)}`
    )),
    percent,
    phase,
    phaseIndex,
    phaseCount,
    progress: {
      percent,
      phase,
      phaseIndex,
      phaseCount,
      ...(Number.isFinite(etaSecondsValue) && etaSecondsValue >= 0 ? { etaSeconds: etaSecondsValue } : {}),
      ...(Object.keys(stageDetail).length ? { stageDetail: { ...stageDetail } } : {})
    },
    ...(Number.isFinite(etaSecondsValue) && etaSecondsValue >= 0 ? { etaSeconds: etaSecondsValue } : {}),
    ...(Object.keys(stageDetail).length ? { stageDetail: { ...stageDetail } } : {}),
    updatedAt: cleanString(firstValue(source.updatedAt, source.updated_at, fallbackObject.updatedAt))
  };
}

export const normalizeProcessing = normalizeProcessingState;

export function createNeedsServiceState(
  message = "Audio is available locally, but a processing service is not configured.",
  updatedAt = new Date().toISOString()
) {
  return {
    state: "needs-service",
    stage: "source",
    message: cleanString(message),
    updatedAt: cleanString(updatedAt)
  };
}

export function normalizeProcessingError(value, defaults = {}) {
  if (value instanceof ProcessingClientError) return value.toJSON();

  const outer = isObject(value) ? value : {};
  const nested = isObject(outer.error) ? outer.error : {};
  const status = Number(firstValue(nested.status, outer.status, defaults.status, 0)) || 0;
  const originalName = cleanString(firstValue(nested.name, outer.name));
  const abortLike = originalName === "AbortError"
    || cleanString(firstValue(nested.code, outer.code)).toLowerCase() === "aborted";
  const code = cleanString(firstValue(
    nested.code,
    outer.code,
    defaults.code,
    abortLike ? "aborted" : status ? `http-${status}` : "processing-error"
  ));
  const fallbackMessage = typeof value === "string" ? value : "Processing service request failed.";
  const message = cleanString(firstValue(
    nested.message,
    nested.detail,
    outer.message,
    outer.detail,
    defaults.message,
    fallbackMessage
  ));
  const retryableDefault = code === "network-error"
    || code === "service-unavailable"
    || status === 408
    || status === 429
    || status >= 500;

  return {
    name: "ProcessingClientError",
    code,
    message,
    status,
    retryable: Boolean(firstValue(nested.retryable, outer.retryable, defaults.retryable, retryableDefault)),
    details: firstValue(nested.details, outer.details, defaults.details, null)
  };
}

export function asProcessingClientError(value, defaults = {}) {
  if (value instanceof ProcessingClientError) return value;
  const normalized = normalizeProcessingError(value, defaults);
  return new ProcessingClientError(normalized.message, {
    ...normalized,
    cause: value instanceof Error ? value : undefined
  });
}

export function normalizeJobResponse(payload, fallback = {}) {
  const data = isObject(payload) ? payload : {};
  const processing = normalizeProcessingState(data, fallback.processing || fallback);
  const rawError = firstValue(data.error, data.processing?.error);
  const error = rawError
    ? normalizeProcessingError(rawError)
    : processing.state === "failed"
      ? normalizeProcessingError({ message: processing.message, code: "processing-failed" })
      : null;

  return {
    songId: cleanString(firstValue(data.songId, data.song_id, fallback.songId)),
    jobId: cleanString(firstValue(data.jobId, data.job_id, data.id, fallback.jobId)),
    processing,
    error
  };
}

export const normalizeJobState = normalizeJobResponse;

export function normalizeChordChart(value, { strict = true } = {}) {
  const input = Array.isArray(value) ? value : (Array.isArray(value?.chords) ? value.chords : null);
  if (!input) {
    throw new ProcessingClientError("Chord chart must be an array.", { code: "invalid-chords" });
  }
  if (input.length > 10_000) {
    throw new ProcessingClientError("Chord chart cannot contain more than 10,000 entries.", {
      code: "invalid-chords",
      details: { count: input.length }
    });
  }

  const chords = [];
  input.forEach((entry, index) => {
    const source = Array.isArray(entry) ? { t: entry[0], n: entry[1] } : entry;
    const time = Number(firstValue(source?.t, source?.time, source?.start));
    const name = cleanString(firstValue(source?.n, source?.name, source?.chord));
    const invalidTime = typeof firstValue(source?.t, source?.time, source?.start) === "boolean"
      || !Number.isFinite(time)
      || time < 0;
    if (invalidTime || !name || name.length > 32) {
      if (strict) {
        throw new ProcessingClientError(`Chord at index ${index} is invalid.`, {
          code: "invalid-chords",
          details: { index }
        });
      }
      return;
    }
    chords.push({ t: Math.round(time * 1000) / 1000, n: name });
  });

  return chords.sort((a, b) => a.t - b.t);
}

export const normalizeChords = normalizeChordChart;

function resolveServiceUrl(value, baseUrl) {
  const url = cleanString(value);
  if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url;
  const base = cleanString(baseUrl);
  if (!base) return url;
  try {
    if (/^https?:/i.test(base)) return new URL(url, `${base.replace(/\/+$/, "")}/`).href;
  } catch {}
  if (url.startsWith("/")) return url;
  return `${base.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

function normalizeAssetEntry(entry, baseUrl) {
  if (typeof entry === "string") return resolveServiceUrl(entry, baseUrl);
  if (!isObject(entry)) return entry ?? null;
  const url = firstValue(entry.url, entry.href, entry.downloadUrl, entry.download_url);
  return url ? { ...entry, url: resolveServiceUrl(url, baseUrl) } : { ...entry };
}

function normalizeStemNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((name) => cleanString(name)).filter(Boolean))];
}

const NOTE_TRACK_ALIASES = Object.freeze({
  melody: "melody",
  melodic: "melody",
  lead: "melody",
  lead_melody: "melody",
  bass: "bass",
  bassline: "bass",
  bass_line: "bass"
});

function noteNameToMidi(value) {
  const text = cleanString(value)
    .replace(/cis/ig, "C#")
    .replace(/dis/ig, "D#")
    .replace(/fis/ig, "F#")
    .replace(/gis/ig, "G#")
    .replace(/ais/ig, "A#");
  const match = /^([A-Ha-h])([#b]?)(-?\d+)$/.exec(text);
  if (!match) return NaN;
  const pitchClasses = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 10, H: 11 };
  let pitchClass = pitchClasses[match[1].toUpperCase()];
  if (match[2] === "#") pitchClass += 1;
  if (match[2] === "b") pitchClass -= 1;
  return (Number(match[3]) + 1) * 12 + ((pitchClass % 12) + 12) % 12;
}

function normalizeNoteEvent(event, index) {
  const source = Array.isArray(event)
    ? { t: event[0], d: event[1], midi: event[2], confidence: event[3] }
    : isObject(event) ? event : {};
  const rawTime = firstValue(source.t, source.time, source.start, source.onset);
  const rawEnd = firstValue(source.end, source.stop, source.offset);
  const rawDuration = firstValue(source.d, source.duration, source.length);
  const rawMidi = firstValue(source.midi, source.note, source.pitch, source.n);
  const frequency = Number(firstValue(source.frequency, source.hz));
  const time = Number(rawTime);
  const parsedMidi = Number(rawMidi);
  const midi = Number.isFinite(parsedMidi)
    ? parsedMidi
    : Number.isFinite(frequency) && frequency > 0
      ? 69 + 12 * Math.log2(frequency / 440)
      : noteNameToMidi(rawMidi);
  let duration = Number(rawDuration);
  if (!Number.isFinite(duration) && Number.isFinite(Number(rawEnd))) {
    duration = Number(rawEnd) - time;
  }
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(midi) || midi < 0 || midi > 127) return null;

  const confidence = Number(firstValue(source.confidence, source.conf, source.probability, source.score));
  const velocity = Number(firstValue(source.velocity, source.vel));
  const detectedMidi = Number(firstValue(source.detectedMidi, source.detected_midi, source.rawMidi, source.raw_midi));
  // Izmerena dinamika napada; bez nje klavir svira sve tonove jednako glasno.
  const noteVelocity = Number(firstValue(source.vel));
  return {
    t: Math.round(time * 1000) / 1000,
    d: Number.isFinite(duration) && duration > 0 ? Math.round(Math.min(duration, 30) * 1000) / 1000 : null,
    midi: Math.round(midi),
    ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
    ...(Number.isFinite(noteVelocity) ? { vel: Math.max(0, Math.min(1, noteVelocity)) } : {}),
    ...(Number.isFinite(velocity) ? { velocity: Math.max(0, Math.min(1, velocity > 1 ? velocity / 127 : velocity)) } : {}),
    ...(Number.isFinite(detectedMidi) && detectedMidi >= 0 && detectedMidi <= 127
      ? { detectedMidi: Math.round(detectedMidi) }
      : {}),
    _order: index
  };
}

export function normalizeNoteEvents(value) {
  if (!Array.isArray(value)) return [];
  const events = value
    .map(normalizeNoteEvent)
    .filter(Boolean)
    .sort((first, second) => first.t - second.t || first._order - second._order);

  return events.map((event, index) => {
    const next = events[index + 1];
    const inferredDuration = next ? Math.max(0.05, Math.min(0.4, next.t - event.t)) : 0.25;
    const { _order, ...clean } = event;
    return { ...clean, d: event.d || Math.round(inferredDuration * 1000) / 1000 };
  });
}

const noteEventIndexCache = new WeakMap();

function noteEventIndex(events) {
  let cached = noteEventIndexCache.get(events);
  if (cached && cached.length === events.length) return cached;

  const starts = new Float64Array(events.length);
  const prefixMaxEnds = new Float64Array(events.length);
  let maximumEnd = -Infinity;
  events.forEach((event, index) => {
    const start = Math.max(0, Number(event?.t) || 0);
    const duration = Math.max(0.03, Number(event?.d) || 0.15);
    starts[index] = start;
    maximumEnd = Math.max(maximumEnd, start + duration);
    prefixMaxEnds[index] = maximumEnd;
  });
  cached = { length: events.length, starts, prefixMaxEnds };
  noteEventIndexCache.set(events, cached);
  return cached;
}

function upperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalizeNoteTrackEntry(entry, baseUrl) {
  if (Array.isArray(entry)) return { events: normalizeNoteEvents(entry) };
  if (!isObject(entry)) {
    const url = resolveServiceUrl(entry, baseUrl);
    return url ? { url } : null;
  }
  const rawEvents = firstValue(entry.events, entry.notes, entry.noteEvents, entry.note_events);
  const normalizedAsset = normalizeAssetEntry(entry, baseUrl);
  const result = isObject(normalizedAsset) ? { ...normalizedAsset } : {};
  if (Array.isArray(rawEvents)) result.events = normalizeNoteEvents(rawEvents);
  return result.url || result.events ? result : null;
}

export function normalizeNoteTracks(value, { baseUrl = "" } = {}) {
  if (!isObject(value)) return {};
  const tracks = {};
  Object.entries(value).forEach(([rawName, entry]) => {
    const compactName = cleanString(rawName).toLowerCase().replace(/[\s-]+/g, "_");
    const name = NOTE_TRACK_ALIASES[compactName];
    if (!name) return;
    const normalized = normalizeNoteTrackEntry(entry, baseUrl);
    if (normalized) tracks[name] = normalized;
  });
  return tracks;
}

export function getActiveNoteEvents(events, time) {
  const t = Math.max(0, Number(time) || 0);
  if (!Array.isArray(events) || !events.length) return [];
  const { starts, prefixMaxEnds } = noteEventIndex(events);
  const active = [];
  for (let index = upperBound(starts, t) - 1; index >= 0; index -= 1) {
    if (prefixMaxEnds[index] <= t) break;
    const event = events[index];
    if (t < event.t + Math.max(0.03, Number(event.d) || 0.15)) {
      active.push({ ...event, index });
    }
  }
  active.reverse();
  return active;
}

export function foldMidiIntoRange(value, minimum = 36, maximum = 96) {
  let midi = Math.round(Number(value));
  const low = Math.round(Number(minimum));
  const high = Math.round(Number(maximum));
  if (!Number.isFinite(midi) || !Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
  while (midi < low) midi += 12;
  while (midi > high) midi -= 12;
  return midi >= low && midi <= high ? midi : null;
}

export function getNoteEventsStartingBetween(events, startExclusive, endInclusive) {
  if (!Array.isArray(events) || !events.length) return [];
  const start = Number.isFinite(Number(startExclusive)) ? Number(startExclusive) : -Infinity;
  const end = Number.isFinite(Number(endInclusive)) ? Number(endInclusive) : Infinity;
  if (end <= start) return [];
  const { starts } = noteEventIndex(events);
  const first = upperBound(starts, start);
  const afterLast = upperBound(starts, end);
  const result = [];
  for (let index = first; index < afterLast; index += 1) {
    result.push({ ...events[index], index });
  }
  return result;
}

export function normalizeAssetsResponse(payload, { baseUrl = "" } = {}) {
  const data = isObject(payload) ? payload : {};
  let stems;
  if (Array.isArray(data.stems)) {
    stems = data.stems.map((entry) => normalizeAssetEntry(entry, baseUrl));
  } else if (isObject(data.stems)) {
    stems = Object.fromEntries(
      Object.entries(data.stems).map(([name, entry]) => [name, normalizeAssetEntry(entry, baseUrl)])
    );
  } else {
    stems = {};
  }

  const inferredNames = Array.isArray(stems)
    ? stems.map((entry) => typeof entry === "string" ? "" : firstValue(entry?.name, entry?.stem, entry?.channel))
    : Object.keys(stems);
  const availableStems = normalizeStemNames(
    Array.isArray(data.availableStems) ? data.availableStems
      : Array.isArray(data.available_stems) ? data.available_stems
        : inferredNames
  );

  const noteTracks = {};
  [
    data.assets?.noteTracks,
    data.assets?.note_tracks,
    data.analysis?.noteTracks,
    data.analysis?.note_tracks,
    data.noteEvents,
    data.note_events,
    data.note_tracks,
    data.noteTracks
  ].forEach((candidate) => {
    Object.assign(noteTracks, normalizeNoteTracks(candidate, { baseUrl }));
  });

  const result = {
    ...data,
    songId: cleanString(firstValue(data.songId, data.song_id)),
    mix: normalizeAssetEntry(firstValue(data.mix, data.original, null), baseUrl),
    stems,
    availableStems,
    noteTracks,
    chordRevision: Math.max(0, Math.trunc(Number(firstValue(data.chordRevision, data.chord_revision, 0)) || 0)),
    chordTimeBase: cleanString(firstValue(data.chordTimeBase, data.chord_time_base)),
    chordTimingOffsetSeconds: Number.isFinite(Number(firstValue(
      data.chordTimingOffsetSeconds,
      data.chord_timing_offset_seconds,
      0
    ))) ? Number(firstValue(data.chordTimingOffsetSeconds, data.chord_timing_offset_seconds, 0)) : 0,
    chordSourceSha256: normalizeSha256(firstValue(data.chordSourceSha256, data.chord_source_sha256)),
    chordProvenance: isObject(firstValue(data.chordProvenance, data.chord_provenance))
      ? { ...firstValue(data.chordProvenance, data.chord_provenance) }
      : null,
    aiCandidateChords: Array.isArray(firstValue(data.aiCandidateChords, data.ai_candidate_chords))
      ? normalizeChordChart(firstValue(data.aiCandidateChords, data.ai_candidate_chords), { strict: false })
      : [],
    aiCandidateChordCount: Math.max(0, Math.trunc(Number(firstValue(
      data.aiCandidateChordCount,
      data.ai_candidate_chord_count,
      0
    )) || 0)),
    chordsUpdatedAt: cleanString(firstValue(data.chordsUpdatedAt, data.chords_updated_at))
  };
  if (Array.isArray(data.chords)) result.chords = normalizeChordChart(data.chords, { strict: false });
  if (data.processing) result.processing = normalizeProcessingState(data.processing);
  result.beatGrid = normalizeBeatGrid(firstValue(data.beatGrid, data.beat_grid, data.assets?.beatGrid));
  return result;
}

export const normalizeAssets = normalizeAssetsResponse;

export function normalizeUploadTicket(payload, { baseUrl = "" } = {}) {
  const data = isObject(payload) ? payload : {};
  const upload = isObject(data.upload) ? data.upload : data;
  const asset = isObject(data.asset)
    ? data.asset
    : isObject(data.sourceAsset)
      ? data.sourceAsset
      : null;
  const uploadUrl = resolveServiceUrl(firstValue(
    upload.uploadUrl,
    upload.upload_url,
    upload.signedUrl,
    upload.signed_url,
    upload.url
  ), baseUrl);
  const sourceAssetId = cleanString(firstValue(
    data.sourceAssetId,
    data.source_asset_id,
    data.assetId,
    data.asset_id,
    upload.sourceAssetId,
    upload.assetId,
    asset?.id,
    asset?.assetId
  ));
  const method = cleanString(firstValue(upload.method, upload.httpMethod, upload.http_method, "PUT")).toUpperCase();

  if (uploadUrl && !["POST", "PUT"].includes(method)) {
    throw new ProcessingClientError("Signed upload method must be PUT or POST.", {
      code: "invalid-upload-ticket"
    });
  }

  return {
    uploadUrl,
    method,
    headers: mergeHeaders(upload.headers),
    fields: isObject(upload.fields) ? { ...upload.fields } : null,
    fileField: cleanString(firstValue(upload.fileField, upload.file_field, "file")),
    sourceAssetId,
    asset: normalizeAssetEntry(asset, baseUrl),
    processing: data.processing ? normalizeProcessingState(data.processing) : null,
    response: data
  };
}

export const normalizeUploadResponse = normalizeUploadTicket;

export function normalizeServiceHealth(payload) {
  const data = isObject(payload) ? payload : {};
  const worker = isObject(data.worker) ? data.worker : {};
  const dependencies = isObject(worker.dependencies) ? worker.dependencies : {};
  return {
    ...data,
    service: cleanString(data.service),
    ready: Boolean(data.ready),
    acceptedSourceFormats: Array.isArray(data.acceptedSourceFormats)
      ? data.acceptedSourceFormats.map((value) => cleanString(value).toLowerCase()).filter(Boolean)
      : [],
    sourceMaxBytes: Math.max(0, Number(data.sourceMaxBytes) || 0),
    worker: {
      ...worker,
      ready: Boolean(worker.ready),
      missing: Array.isArray(worker.missing) ? worker.missing.map(cleanString).filter(Boolean) : [],
      dependencies
    }
  };
}

export function normalizeProcessSource(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string" || typeof value === "number") {
    return { sourceAssetId: cleanString(value) };
  }
  if (!isObject(value)) {
    throw new ProcessingClientError("Process source is invalid.", { code: "invalid-process-source" });
  }

  const sourceAssetId = cleanString(firstValue(
    value.sourceAssetId,
    value.source_asset_id,
    value.assetId,
    value.asset_id,
    value.asset?.id
  ));
  if (sourceAssetId) return { sourceAssetId };

  const reference = firstValue(value.sourceReference, value.source_reference, value.reference, value.sourceRef);
  if (reference !== undefined) return { sourceReference: reference };
  return { ...value };
}

const REUSABLE_SOURCE_REJECTION_CODES = new Set([
  "song_not_found",
  "source_asset_not_found",
  "source_asset_stale"
]);

export function reusableProcessingSource(value) {
  const mix = isObject(value?.assets?.mix)
    ? value.assets.mix
    : isObject(value?.mix)
      ? value.mix
      : isObject(value)
        ? value
        : {};
  const sourceAssetId = cleanString(firstValue(mix.id, mix.sourceAssetId, mix.assetId));
  const sourceSha256 = normalizeSha256(firstValue(mix.sha256, mix.sourceSha256));
  if (!/^src_[0-9a-f]{32}$/i.test(sourceAssetId) || !sourceSha256) return null;
  return { sourceAssetId, sourceSha256 };
}

/**
 * Start a processing run without replacing an already verified server source.
 * Only a missing/stale server record may fall back to uploading the local file;
 * transient failures leave the last usable analysis untouched.
 */
export async function beginProcessingRun(client, songId, options = {}) {
  const reusableSource = reusableProcessingSource(options.currentSource);
  if (reusableSource) {
    try {
      const job = await client.startProcess(songId, reusableSource, options.processOptions || {});
      return { job, upload: null, reusedSource: true, source: reusableSource };
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (!REUSABLE_SOURCE_REJECTION_CODES.has(normalized.code)) throw normalized;
    }
  }

  const upload = await client.uploadFile(songId, options.file, options.uploadOptions || {});
  if (!upload.uploaded || !upload.sourceAssetId) {
    return { job: null, upload, reusedSource: false, source: null };
  }
  const job = await client.startProcess(songId, upload, options.processOptions || {});
  return { job, upload, reusedSource: false, source: null };
}

export function isFileLike(value) {
  return Boolean(value)
    && typeof value === "object"
    && cleanString(value.name).length > 0
    && Number.isFinite(Number(value.size))
    && Number(value.size) >= 0;
}

function emitProgress(callback, loaded, total, phase = "upload") {
  if (typeof callback !== "function") return;
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeLoaded = Math.max(0, Math.min(Number(loaded) || 0, safeTotal || Number(loaded) || 0));
  const progress = safeTotal ? Math.max(0, Math.min(1, safeLoaded / safeTotal)) : 0;
  try {
    callback({
      phase,
      loaded: safeLoaded,
      total: safeTotal,
      progress,
      percent: Math.round(progress * 100)
    });
  } catch {}
}

function shouldRetryAsSigned(error) {
  const status = Number(error?.status) || 0;
  return [400, 405, 415, 422].includes(status);
}

function isUnavailableError(error) {
  const status = Number(error?.status) || 0;
  return ["network-error", "service-unavailable", "fetch-unavailable"].includes(error?.code)
    || [502, 503, 504].includes(status);
}

function abortError(reason) {
  return new ProcessingClientError("Processing request was cancelled.", {
    code: "aborted",
    retryable: false,
    details: reason ? { reason: String(reason) } : null
  });
}

function timeoutError(timeoutMs) {
  return new ProcessingClientError("Processing status polling timed out.", {
    code: "poll-timeout",
    retryable: true,
    details: { timeoutMs }
  });
}

export class ProcessingClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "");
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
    this.fetchImpl = options.fetchImpl || options.fetch || globalFetch;
    this.xhrFactory = options.xhrFactory === null
      ? null
      : options.xhrFactory || (typeof globalThis.XMLHttpRequest === "function"
        ? () => new globalThis.XMLHttpRequest()
        : null);
    this.formDataFactory = options.formDataFactory || (typeof globalThis.FormData === "function"
      ? () => new globalThis.FormData()
      : null);
    this.apiHeaders = options.headers || options.apiHeaders || {};
    this.getAccessToken = typeof options.getAccessToken === "function" ? options.getAccessToken : null;
    this.credentials = options.credentials || "same-origin";
    this.uploadMode = cleanString(options.uploadMode || "auto").toLowerCase();
    if (!["auto", "direct", "signed"].includes(this.uploadMode)) {
      throw new ProcessingClientError("Upload mode must be auto, direct, or signed.", {
        code: "invalid-upload-mode"
      });
    }
    this.pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) || 0);
    this.localOnlyOnUnavailable = options.localOnlyOnUnavailable !== false;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout.bind(globalThis);
    this.polls = new Map();
    this.chordWriteQueues = new Map();
    this.chordRevisions = new Map();
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  isConfigured() {
    return this.configured;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    return this.baseUrl;
  }

  needsService(message) {
    return createNeedsServiceState(message);
  }

  async getHealth(options = {}) {
    if (!this.configured) {
      return normalizeServiceHealth({
        service: "fgr-processing",
        ready: false,
        worker: { ready: false, missing: ["service"] },
        acceptedSourceFormats: []
      });
    }
    const url = resolveServiceUrl("/v1/health", this.baseUrl);
    const headers = await this.resolveApiHeaders({ resource: "health", method: "GET", url });
    try {
      const payload = await this.sendRequest(url, {
        method: "GET",
        headers,
        signal: options.signal,
        credentials: this.credentials
      });
      return normalizeServiceHealth(payload);
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (normalized.status === 503 && isObject(normalized.details)) {
        return normalizeServiceHealth(normalized.details);
      }
      throw normalized;
    }
  }

  endpoint(songId, resource) {
    return buildSongEndpoint(this.baseUrl, songId, resource);
  }

  localOnlyResult(songId, extra = {}, error = null) {
    return {
      ...extra,
      songId: normalizeSongId(songId),
      localOnly: true,
      needsService: true,
      processing: createNeedsServiceState(),
      error: error ? normalizeProcessingError(error) : null
    };
  }

  async resolveApiHeaders(context) {
    const configured = typeof this.apiHeaders === "function"
      ? await this.apiHeaders(context)
      : this.apiHeaders;
    const headers = mergeHeaders(configured);
    if (this.getAccessToken && !hasHeader(headers, "authorization")) {
      const token = cleanString(await this.getAccessToken(context));
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async parseResponse(response) {
    if (!response || Number(response.status) === 204 || Number(response.status) === 205) return null;
    const contentType = cleanString(response.headers?.get?.("content-type")).toLowerCase();
    if (contentType.includes("json") && typeof response.json === "function") {
      try { return await response.json(); } catch { return null; }
    }
    if (typeof response.text === "function") {
      const text = await response.text();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    }
    if (typeof response.json === "function") {
      try { return await response.json(); } catch { return null; }
    }
    return null;
  }

  httpError(status, payload, statusText = "") {
    const nested = isObject(payload?.error) ? payload.error : {};
    const message = cleanString(firstValue(
      nested.message,
      nested.detail,
      payload?.message,
      payload?.detail,
      typeof payload === "string" ? payload : undefined,
      statusText,
      `Processing service returned HTTP ${status}.`
    ));
    return new ProcessingClientError(message, {
      code: cleanString(firstValue(nested.code, payload?.code, `http-${status}`)),
      status,
      retryable: status === 408 || status === 429 || status >= 500,
      details: firstValue(nested.details, payload?.details, isObject(payload) ? payload : null)
    });
  }

  async sendWithFetch(url, options) {
    if (typeof this.fetchImpl !== "function") {
      throw new ProcessingClientError("Fetch is not available in this browser.", {
        code: "fetch-unavailable",
        retryable: true
      });
    }
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    emitProgress(options.onProgress, 0, options.total, options.phase);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: options.signal,
        credentials: options.credentials
      });
      const payload = await this.parseResponse(response);
      const status = Number(response?.status) || 0;
      const successful = typeof response?.ok === "boolean"
        ? response.ok
        : status >= 200 && status < 300;
      if (!successful) throw this.httpError(status, payload, response?.statusText);
      emitProgress(options.onProgress, options.total, options.total, options.phase);
      return payload;
    } catch (error) {
      if (error instanceof ProcessingClientError) throw error;
      if (options.signal?.aborted || error?.name === "AbortError") throw abortError(options.signal?.reason);
      throw new ProcessingClientError("Could not reach the processing service.", {
        code: "network-error",
        retryable: true,
        cause: error
      });
    }
  }

  sendWithXhr(url, options) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError(options.signal.reason));
        return;
      }

      let xhr;
      try {
        xhr = this.xhrFactory();
        xhr.open(options.method, url, true);
        xhr.withCredentials = options.credentials === "include";
        Object.entries(options.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      } catch (error) {
        reject(asProcessingClientError(error, { code: "network-error", retryable: true }));
        return;
      }

      let settled = false;
      const cleanup = () => options.signal?.removeEventListener?.("abort", onSignalAbort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onSignalAbort = () => {
        try { xhr.abort(); } catch {}
        finish(reject, abortError(options.signal?.reason));
      };

      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          emitProgress(
            options.onProgress,
            event.loaded,
            event.lengthComputable ? event.total : options.total,
            options.phase
          );
        };
      }
      xhr.onload = () => {
        const status = Number(xhr.status) || 0;
        let payload = xhr.responseText || null;
        if (payload) {
          try { payload = JSON.parse(payload); } catch {}
        }
        if (status >= 200 && status < 300) {
          emitProgress(options.onProgress, options.total, options.total, options.phase);
          finish(resolve, payload);
        } else {
          finish(reject, this.httpError(status, payload, xhr.statusText));
        }
      };
      xhr.onerror = () => finish(reject, new ProcessingClientError("Could not reach the processing service.", {
        code: "network-error",
        retryable: true
      }));
      xhr.onabort = () => finish(reject, abortError(options.signal?.reason));
      options.signal?.addEventListener?.("abort", onSignalAbort, { once: true });

      emitProgress(options.onProgress, 0, options.total, options.phase);
      try {
        xhr.send(options.body);
      } catch (error) {
        finish(reject, asProcessingClientError(error, { code: "network-error", retryable: true }));
      }
    });
  }

  async sendRequest(url, options = {}) {
    const request = {
      method: cleanString(options.method || "GET").toUpperCase(),
      headers: mergeHeaders(options.headers),
      body: options.body,
      signal: options.signal,
      credentials: options.credentials ?? this.credentials,
      onProgress: options.onProgress,
      total: Math.max(0, Number(options.total) || 0),
      phase: options.phase || "upload"
    };
    if (typeof options.onProgress === "function" && request.body !== undefined && this.xhrFactory) {
      return this.sendWithXhr(url, request);
    }
    return this.sendWithFetch(url, request);
  }

  async apiRequest(songId, resource, options = {}) {
    const url = this.endpoint(songId, resource);
    const method = cleanString(options.method || "GET").toUpperCase();
    const apiHeaders = await this.resolveApiHeaders({ songId: normalizeSongId(songId), resource, method, url });
    const headers = mergeHeaders(apiHeaders, options.headers);
    let body = options.body;
    if (options.json !== undefined) {
      if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    return this.sendRequest(url, { ...options, method, headers, body });
  }

  createFormData(file, fields = {}, fileField = "file") {
    if (!this.formDataFactory) {
      throw new ProcessingClientError("FormData is not available in this browser.", {
        code: "form-data-unavailable"
      });
    }
    const form = this.formDataFactory();
    Object.entries(fields || {}).forEach(([name, value]) => form.append(name, value));
    try {
      form.append(fileField || "file", file, file.name);
    } catch {
      form.append(fileField || "file", file);
    }
    return form;
  }

  uploadMetadata(file, metadata = {}) {
    return {
      fileName: cleanString(file.name),
      contentType: cleanString(file.type) || "application/octet-stream",
      size: Number(file.size),
      ...(Number.isFinite(Number(file.lastModified)) ? { lastModified: Number(file.lastModified) } : {}),
      ...metadata
    };
  }

  async listSongs(options = {}) {
    if (!this.configured) return [];
    const response = await fetch(resolveServiceUrl("/v1/songs", this.baseUrl), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal
    });
    if (!response.ok) {
      throw new ProcessingClientError(`Service listing failed (${response.status}).`, { code: "listing-failed" });
    }
    const payload = await response.json();
    return Array.isArray(payload?.songs) ? payload.songs : [];
  }

  async deleteSong(songId, options = {}) {
    if (!this.configured) return false;
    const id = cleanString(songId);
    if (!id) return false;
    const response = await fetch(resolveServiceUrl(`/v1/songs/${id}`, this.baseUrl), {
      method: "DELETE",
      headers: { Accept: "application/json" },
      signal: options.signal
    });
    return response.ok;
  }

  async requestUploadTicket(songId, file, options = {}) {
    const payload = await this.apiRequest(songId, "uploads", {
      method: "POST",
      json: this.uploadMetadata(file, {
        ...(options.metadata || {}),
        ...(options.sourceMetadata ? { sourceMetadata: options.sourceMetadata } : {})
      }),
      signal: options.signal
    });
    return normalizeUploadTicket(payload, { baseUrl: this.baseUrl });
  }

  async uploadDirect(songId, file, options = {}) {
    const fields = { ...(options.formFields || {}) };
    if (options.sourceMetadata) {
      try {
        fields.sourceMetadata = JSON.stringify(options.sourceMetadata);
      } catch (cause) {
        throw new ProcessingClientError("Source metadata could not be encoded.", {
          code: "invalid-source-metadata",
          cause
        });
      }
    }
    const form = this.createFormData(file, fields, options.fileField || "file");
    const payload = await this.apiRequest(songId, "uploads", {
      method: "POST",
      body: form,
      signal: options.signal,
      onProgress: options.onProgress,
      total: Number(file.size),
      phase: "upload"
    });
    return normalizeUploadTicket(payload, { baseUrl: this.baseUrl });
  }

  async putSignedUpload(ticket, file, options = {}) {
    if (!ticket.uploadUrl) {
      throw new ProcessingClientError("Processing service did not return an upload URL.", {
        code: "invalid-upload-ticket"
      });
    }
    const body = ticket.fields
      ? this.createFormData(file, ticket.fields, ticket.fileField)
      : file;
    const headers = mergeHeaders(ticket.headers, options.uploadHeaders);
    if (!ticket.fields && !hasHeader(headers, "content-type") && file.type) {
      headers["Content-Type"] = file.type;
    }
    return this.sendRequest(ticket.uploadUrl, {
      method: ticket.method,
      headers,
      body,
      signal: options.signal,
      credentials: "omit",
      onProgress: options.onProgress,
      total: Number(file.size),
      phase: "upload"
    });
  }

  completedUpload(songId, file, ticket, signedResponse = null) {
    const response = ticket.response || {};
    const responseTicket = isObject(signedResponse)
      ? normalizeUploadTicket(signedResponse, { baseUrl: this.baseUrl })
      : null;
    const sourceAssetId = cleanString(firstValue(ticket.sourceAssetId, responseTicket?.sourceAssetId));
    if (!sourceAssetId) {
      throw new ProcessingClientError("Upload response did not include a source asset ID.", {
        code: "invalid-upload-response"
      });
    }
    return {
      ...response,
      songId: cleanString(firstValue(response.songId, response.song_id, songId)),
      localOnly: false,
      needsService: false,
      uploaded: true,
      sourceAssetId,
      assetId: sourceAssetId,
      asset: ticket.asset || responseTicket?.asset || null,
      fileName: file.name,
      processing: ticket.processing || normalizeProcessingState({
        state: "queued",
        stage: "source",
        message: "Source audio uploaded."
      })
    };
  }

  async uploadFile(songId, file, options = {}) {
    const id = normalizeSongId(songId);
    if (!isFileLike(file)) {
      throw new ProcessingClientError("A valid File is required for upload.", { code: "invalid-file" });
    }
    if (!this.configured) {
      emitProgress(options.onProgress, 0, Number(file.size), "local");
      return this.localOnlyResult(id, {
        uploaded: false,
        sourceAssetId: "",
        assetId: "",
        file,
        fileName: file.name
      });
    }

    const mode = cleanString(options.uploadMode || this.uploadMode).toLowerCase();
    if (!["auto", "direct", "signed"].includes(mode)) {
      throw new ProcessingClientError("Upload mode must be auto, direct, or signed.", {
        code: "invalid-upload-mode"
      });
    }

    try {
      let ticket;
      if (mode === "signed") {
        ticket = await this.requestUploadTicket(id, file, options);
      } else {
        try {
          ticket = await this.uploadDirect(id, file, options);
        } catch (error) {
          if (mode !== "auto" || !shouldRetryAsSigned(error)) throw error;
          ticket = await this.requestUploadTicket(id, file, options);
        }
      }

      let signedResponse = null;
      if (ticket.uploadUrl) signedResponse = await this.putSignedUpload(ticket, file, options);
      return this.completedUpload(id, file, ticket, signedResponse);
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (this.localOnlyOnUnavailable && isUnavailableError(normalized)) {
        return this.localOnlyResult(id, {
          uploaded: false,
          sourceAssetId: "",
          assetId: "",
          file,
          fileName: file.name
        }, normalized);
      }
      throw normalized;
    }
  }

  async uploadCapturedYouTubeAudio(songId, audioBuffer, options = {}) {
    const id = normalizeSongId(songId);
    const bitDepth = Number(options.bitDepth ?? 24);
    const file = createPcmWavFile(audioBuffer, {
      bitDepth,
      fileName: cleanString(options.fileName) || `${id}-youtube-capture.wav`,
      lastModified: options.lastModified
    });
    const sourceMetadata = createYouTubeCaptureMetadata(options, audioBuffer, bitDepth);
    const upload = await this.uploadFile(id, file, {
      ...options,
      uploadMode: options.uploadMode || "direct",
      sourceMetadata
    });
    return { ...upload, file, sourceMetadata };
  }

  async processCapturedYouTubeAudio(songId, audioBuffer, options = {}) {
    const upload = await this.uploadCapturedYouTubeAudio(songId, audioBuffer, options);
    if (!upload.uploaded || !upload.sourceAssetId) {
      return { ...upload, job: null, jobId: "" };
    }
    const job = await this.startProcess(songId, upload, {
      ...(options.processOptions || {}),
      ...(options.referenceChords ? { referenceChords: options.referenceChords } : {}),
      ...(options.referenceSourceSha256 ? { referenceSourceSha256: options.referenceSourceSha256 } : {})
    });
    return {
      ...upload,
      job,
      jobId: job.jobId,
      processing: job.processing
    };
  }

  async startProcess(songId, source, options = {}) {
    const id = normalizeSongId(songId);
    if (!this.configured) return this.localOnlyResult(id, { jobId: "" });
    const body = { ...normalizeProcessSource(source), ...(options.body || {}) };
    if (options.freshAnalysis === true) body.freshAnalysis = true;
    const rawReferenceChords = firstValue(options.referenceChords, body.referenceChords, body.reference_chords);
    if (rawReferenceChords !== undefined) {
      body.referenceChords = normalizeChordChart(rawReferenceChords);
      delete body.reference_chords;
      const referenceSourceSha256 = normalizeSha256(firstValue(
        options.referenceSourceSha256,
        body.referenceSourceSha256,
        body.reference_source_sha256,
        source?.asset?.sha256,
        source?.response?.asset?.sha256
      ));
      if (!referenceSourceSha256) {
        throw new ProcessingClientError(
          "A source SHA-256 digest is required when refining reference chords.",
          { code: "reference-source-required" }
        );
      }
      body.referenceSourceSha256 = referenceSourceSha256;
      delete body.reference_source_sha256;
    }
    try {
      const payload = await this.apiRequest(id, "process", {
        method: "POST",
        json: body,
        signal: options.signal
      });
      const job = normalizeJobResponse(payload, {
        songId: id,
        processing: { state: "queued", stage: "source" }
      });
      if (!job.jobId) {
        throw new ProcessingClientError("Process response did not include a job ID.", {
          code: "invalid-process-response"
        });
      }
      return job;
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (this.localOnlyOnUnavailable && !options.strict && isUnavailableError(normalized)) {
        return this.localOnlyResult(id, { jobId: "" }, normalized);
      }
      throw normalized;
    }
  }

  async getProcess(songId, options = {}) {
    const id = normalizeSongId(songId);
    if (!this.configured) return this.localOnlyResult(id, { jobId: "" });
    try {
      const payload = await this.apiRequest(id, "process", {
        method: "GET",
        signal: options.signal
      });
      return normalizeJobResponse(payload, { songId: id });
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (this.localOnlyOnUnavailable && !options.strict && isUnavailableError(normalized)) {
        return this.localOnlyResult(id, { jobId: "" }, normalized);
      }
      throw normalized;
    }
  }

  getStatus(songId, options = {}) {
    return this.getProcess(songId, options);
  }

  async fetchAssets(songId, options = {}) {
    const id = normalizeSongId(songId);
    if (!this.configured) {
      return this.localOnlyResult(id, { mix: null, stems: {}, availableStems: [], chords: [] });
    }
    try {
      const payload = await this.apiRequest(id, "assets", {
        method: "GET",
        signal: options.signal
      });
      const assets = normalizeAssetsResponse(payload, { baseUrl: this.baseUrl });
      this.chordRevisions.set(id, assets.chordRevision);
      return assets;
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (this.localOnlyOnUnavailable && isUnavailableError(normalized)) {
        return this.localOnlyResult(id, {
          mix: null,
          stems: {},
          availableStems: [],
          chords: []
        }, normalized);
      }
      throw normalized;
    }
  }

  getAssets(songId, options = {}) {
    return this.fetchAssets(songId, options);
  }

  async patchChords(songId, chords, options = {}) {
    const id = normalizeSongId(songId);
    const normalizedChords = normalizeChordChart(chords);
    const previous = this.chordWriteQueues.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this._patchChordsNow(id, normalizedChords, options));
    this.chordWriteQueues.set(id, operation);
    operation.then(
      () => {
        if (this.chordWriteQueues.get(id) === operation) this.chordWriteQueues.delete(id);
      },
      () => {
        if (this.chordWriteQueues.get(id) === operation) this.chordWriteQueues.delete(id);
      }
    );
    return operation;
  }

  async _patchChordsNow(id, normalizedChords, options = {}) {
    if (!this.configured) return this.localOnlyResult(id, { chords: normalizedChords });
    const requestBody = { ...(options.body || {}), chords: normalizedChords };
    const rawExpectedRevision = firstValue(
      options.expectedRevision,
      requestBody.expectedRevision,
      requestBody.expected_revision,
      this.chordRevisions.get(id)
    );
    if (rawExpectedRevision !== undefined) {
      const expectedRevision = Number(rawExpectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new ProcessingClientError("Expected chord revision must be a non-negative integer.", {
          code: "invalid-chord-revision"
        });
      }
      requestBody.expectedRevision = expectedRevision;
      delete requestBody.expected_revision;
    }
    try {
      const payload = await this.apiRequest(id, "chords", {
        method: "PATCH",
        json: requestBody,
        signal: options.signal
      });
      const data = isObject(payload) ? payload : {};
      const result = {
        ...data,
        songId: cleanString(firstValue(data.songId, data.song_id, id)),
        chords: normalizeChordChart(Array.isArray(data.chords) ? data.chords : normalizedChords),
        timeBase: cleanString(firstValue(data.timeBase, data.time_base, "mix-seconds")),
        sourceSha256: normalizeSha256(firstValue(data.sourceSha256, data.source_sha256)),
        provenance: isObject(data.provenance) ? { ...data.provenance } : null
      };
      const revision = Number(firstValue(data.revision, data.chordRevision, data.chord_revision));
      if (Number.isInteger(revision) && revision >= 0) this.chordRevisions.set(id, revision);
      return result;
    } catch (error) {
      const normalized = asProcessingClientError(error);
      if (normalized.status === 409 && normalized.code === "chord_revision_conflict") {
        const currentRevision = Number(normalized.details?.currentRevision);
        if (Number.isInteger(currentRevision) && currentRevision >= 0) {
          this.chordRevisions.set(id, currentRevision);
        }
      }
      if (this.localOnlyOnUnavailable && isUnavailableError(normalized)) {
        return this.localOnlyResult(id, { chords: normalizedChords }, normalized);
      }
      throw normalized;
    }
  }

  saveChords(songId, chords, options = {}) {
    return this.patchChords(songId, chords, options);
  }

  wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal.reason));
        return;
      }
      const timer = this.setTimeoutImpl(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        this.clearTimeoutImpl(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(abortError(signal.reason));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  pollProcess(songId, options = {}) {
    const id = normalizeSongId(songId);
    this.cancelPolling(id, "replaced");
    const controller = new AbortController();
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });

    const intervalMs = Math.max(0, Number(options.intervalMs ?? this.pollIntervalMs) || 0);
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const maxErrors = Math.max(0, Number(options.maxConsecutiveErrors ?? 3) || 0);
    const terminalStates = new Set(
      (options.terminalStates || TERMINAL_PROCESSING_STATES).map((state) => canonicalState(state, "failed"))
    );
    const startedAt = this.now();

    const promise = (async () => {
      let consecutiveErrors = 0;
      while (true) {
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        if (timeoutMs && this.now() - startedAt >= timeoutMs) throw timeoutError(timeoutMs);
        try {
          const job = await this.getProcess(id, { signal: controller.signal, strict: true });
          consecutiveErrors = 0;
          if (typeof options.onUpdate === "function") await options.onUpdate(job);
          if (terminalStates.has(job.processing.state)) return job;
        } catch (error) {
          const normalized = asProcessingClientError(error);
          if (normalized.code === "aborted") throw normalized;
          consecutiveErrors += 1;
          if (typeof options.onError === "function") await options.onError(normalized, consecutiveErrors);
          if (!normalized.retryable || consecutiveErrors > maxErrors) throw normalized;
        }
        await this.wait(intervalMs, controller.signal);
      }
    })();

    Object.defineProperties(promise, {
      promise: { value: promise },
      signal: { value: controller.signal },
      active: { get: () => !controller.signal.aborted && this.polls.get(id) === promise },
      cancel: {
        value: (reason = "cancelled") => {
          if (!controller.signal.aborted) controller.abort(reason);
        }
      }
    });

    this.polls.set(id, promise);
    const cleanup = () => {
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
      if (this.polls.get(id) === promise) this.polls.delete(id);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  pollUntilComplete(songId, options = {}) {
    return this.pollProcess(songId, options);
  }

  cancelPolling(songId, reason = "cancelled") {
    let id;
    try { id = normalizeSongId(songId); } catch { return false; }
    const poll = this.polls.get(id);
    if (!poll) return false;
    poll.cancel(reason);
    return true;
  }

  cancelAllPolling(reason = "cancelled") {
    const count = this.polls.size;
    [...this.polls.values()].forEach((poll) => poll.cancel(reason));
    return count;
  }
}

export function createProcessingClient(options = {}) {
  return new ProcessingClient(options);
}

export default createProcessingClient;
