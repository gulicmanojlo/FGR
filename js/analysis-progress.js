const ACTIVE_PROCESSING_STATES = new Set([
  "queued",
  "downloading",
  "separating",
  "analyzing",
  "processing"
]);

const STAGE_LABELS = Object.freeze({
  source: "Priprema izvora",
  queued: "Priprema izvora",
  upload: "Slanje audio fajla",
  decode: "Pretvaranje u WAV",
  separating: "Razdvajanje AI kanala",
  separation: "Razdvajanje AI kanala",
  stems: "Razdvajanje AI kanala",
  grid: "Merenje tempa i taktova",
  "beat-grid": "Merenje tempa i taktova",
  melody: "Prepoznavanje melodije i basa",
  notes: "Prepoznavanje melodije i basa",
  note_tracks: "Prepoznavanje melodije i basa",
  chords: "Prepoznavanje akorda",
  "chord-analysis": "Prepoznavanje akorda",
  boundaries: "Usklađivanje promena akorda",
  qa: "Provera kvaliteta",
  publish: "Čuvanje rezultata",
  finalizing: "Čuvanje rezultata",
  complete: "Analiza je spremna",
  assets: "Učitavanje rezultata"
});

function finitePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function progressFromProcessing(processing, state) {
  if (state === "ready") return 100;
  const direct = [
    processing?.percent,
    processing?.progressPercent,
    processing?.progress_percent,
    typeof processing?.progress === "number" ? processing.progress : null,
    processing?.progress?.percent
  ];
  for (const value of direct) {
    const percent = finitePercent(value);
    if (percent !== null) return percent;
  }
  if (state === "queued") return 3;
  if (state === "downloading") return 8;
  if (state === "separating") return 15;
  if (state === "analyzing" || state === "processing") return 72;
  return 0;
}

function stageTitle(processing, state) {
  const stage = String(processing?.phase || processing?.stage || "").trim().toLowerCase();
  if (STAGE_LABELS[stage]) return STAGE_LABELS[stage];
  if (state === "ready") return "Analiza je spremna";
  if (state === "failed") return "Analiza nije uspela";
  if (state === "needs-service") return "Processing servis nije dostupan";
  return "Automatska AI obrada";
}

/**
 * Pure presentation model for the single automatic processing control.
 * It deliberately does not infer that a local source is ready from an old
 * chord chart: only source/stem/job state may advance this progress display.
 */
export function buildAnalysisProgressView(song, options = {}) {
  const recording = Boolean(options.recording || options.captureStarting || options.captureStopping);
  const localAudio = Boolean(options.localAudio);
  const processing = song?.processing || {};
  const rawState = String(processing.state || "").trim().toLowerCase();
  const stemsReady = Boolean(song?.stems && (song?.availableStems?.length || 0) > 0);
  const state = ACTIVE_PROCESSING_STATES.has(rawState)
    ? rawState
    : stemsReady && rawState !== "failed"
      ? "ready"
      : (rawState || "idle");

  if (!song) {
    return {
      state: "idle",
      percent: 0,
      indeterminate: false,
      title: "Izaberi pesmu",
      message: "Uvezeni audio se obrađuje automatski.",
      active: false,
      canRecord: false,
      canRetry: false
    };
  }

  if (recording) {
    return {
      state: "recording",
      percent: 0,
      indeterminate: true,
      title: options.captureStarting ? "Čekam YouTube zvuk" : "Snimanje u WAV kvalitetu",
      message: "Po završetku se analiza pokreće automatski.",
      active: true,
      canRecord: true,
      canRetry: false
    };
  }

  if (!localAudio && song.videoId) {
    if (rawState === "failed") {
      return {
        state: "failed",
        percent: progressFromProcessing(processing, rawState),
        indeterminate: false,
        title: "Snimanje nije uspelo",
        message: String(processing.message || "YouTube tab nije dao upotrebljiv zvuk."),
        active: false,
        canRecord: true,
        canRetry: false
      };
    }
    return {
      state: "awaiting-source",
      percent: 0,
      indeterminate: false,
      title: "Snimi i analiziraj",
      message: "Podeli YouTube tab sa uključenim zvukom; ostalo je automatski.",
      active: false,
      canRecord: true,
      canRetry: false
    };
  }

  if (localAudio && rawState === "ready" && !stemsReady) {
    return {
      state: "processing",
      percent: 99,
      indeterminate: false,
      title: "Učitavanje rezultata",
      message: "Analiza je završena; učitavam AI kanale i chart…",
      active: true,
      canRecord: false,
      canRetry: false
    };
  }

  const active = ACTIVE_PROCESSING_STATES.has(state);
  const failed = state === "failed" || state === "needs-service";
  const percent = progressFromProcessing(processing, state);
  const channelCount = Number(song.availableStems?.length) || 0;
  const chordCount = Array.isArray(song.chords) ? song.chords.length : 0;
  const readyMessage = `Spremno: ${channelCount || 6} kanala${chordCount ? ` · ${chordCount} akorda` : ""}.`;

  return {
    state,
    percent,
    indeterminate: active && percent <= 0,
    title: stageTitle(processing, state),
    message: state === "ready"
      ? readyMessage
      : String(processing.message || (active ? "Analiza je u toku…" : "Audio čeka automatsku obradu.")),
    active,
    canRecord: Boolean(song.videoId && !localAudio),
    canRetry: failed || (localAudio && !active && state !== "ready")
  };
}

export function isProcessingActive(processing) {
  return ACTIVE_PROCESSING_STATES.has(String(processing?.state || "").trim().toLowerCase());
}

export function mergeProcessingProgress(previous, next) {
  if (!next || typeof next !== "object") return next;
  const previousPercent = Number(previous?.percent ?? previous?.progress?.percent);
  const nextPercent = Number(next?.percent ?? next?.progress?.percent);
  if (!Number.isFinite(previousPercent) || !Number.isFinite(nextPercent) || nextPercent >= previousPercent) {
    return next;
  }
  return {
    ...next,
    percent: previousPercent,
    progress: {
      ...(next.progress || {}),
      percent: previousPercent
    }
  };
}
