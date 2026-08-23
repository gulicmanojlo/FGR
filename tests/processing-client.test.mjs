import assert from "node:assert/strict";

import {
  beginProcessingRun,
  createYouTubeCaptureMetadata,
  createProcessingClient,
  foldMidiIntoRange,
  getActiveNoteEvents,
  getNoteEventsStartingBetween,
  normalizeAssetsResponse,
  normalizeNoteTracks,
  normalizeProcessingState,
  normalizeServiceHealth,
  normalizeSongId,
  reusableProcessingSource
} from "../js/processing-client.js";

const normalizedProgress = normalizeProcessingState({
  state: "separating",
  stage: "stems",
  percent: 47.36,
  phase: "separation",
  phaseIndex: 2,
  phaseCount: 4,
  stageDetail: { demucsPercent: 62 }
});
assert.equal(normalizedProgress.percent, 47.4);
assert.equal(normalizedProgress.phase, "separation");
assert.equal(normalizedProgress.progress.phaseIndex, 2);
assert.equal(normalizedProgress.stageDetail.demucsPercent, 62);

assert.equal(normalizeSongId("pesma-1"), "pesma-1");
assert.throws(() => normalizeSongId("Pesma sa razmakom"), /invalid/i);

const normalizedAssets = normalizeAssetsResponse({
  mix: { url: "/v1/songs/pesma-1/assets/mix" },
  stems: { vocals: { url: "/v1/songs/pesma-1/assets/stems/vocals" } },
  chord_revision: 4,
  chord_time_base: "mix-seconds",
  chord_timing_offset_seconds: 0,
  chord_source_sha256: "a".repeat(64),
  chord_provenance: { origin: "ai-analysis" },
  aiCandidateChords: [{ t: 1, n: "Am" }],
  aiCandidateChordCount: 1
}, { baseUrl: "http://127.0.0.1:8765" });
assert.equal(normalizedAssets.mix.url, "http://127.0.0.1:8765/v1/songs/pesma-1/assets/mix");
assert.deepEqual(normalizedAssets.availableStems, ["vocals"]);
assert.equal(normalizedAssets.chordRevision, 4);
assert.equal(normalizedAssets.chordTimeBase, "mix-seconds");
assert.equal(normalizedAssets.chordTimingOffsetSeconds, 0);
assert.equal(normalizedAssets.chordSourceSha256, "a".repeat(64));
assert.equal(normalizedAssets.chordProvenance.origin, "ai-analysis");
assert.deepEqual(normalizedAssets.aiCandidateChords, [{ t: 1, n: "Am" }]);

const normalizedTracks = normalizeNoteTracks({
  melody: {
    timeBase: "mix-seconds",
    timeOffset: 0.05,
    events: [
      { t: 1, d: 0.25, midi: 64, confidence: 0.9 },
      { t: 1.25, d: 0.2, midi: 64, confidence: 0.8 }
    ]
  },
  bass_line: [{ start: 2, end: 2.4, note: "A2" }]
});
assert.equal(normalizedTracks.melody.timeOffset, 0.05);
assert.equal(normalizedTracks.bass.events[0].midi, 45);
assert.equal(getActiveNoteEvents(normalizedTracks.melody.events, 1.05 - normalizedTracks.melody.timeOffset)[0].index, 0);
assert.equal(getActiveNoteEvents(normalizedTracks.melody.events, 1.3 - normalizedTracks.melody.timeOffset)[0].index, 1);
assert.equal(foldMidiIntoRange(24), 36);
assert.equal(foldMidiIntoRange(33), 45);
assert.equal(foldMidiIntoRange(67), 67);
assert.equal(foldMidiIntoRange(108), 96);
assert.deepEqual(
  getNoteEventsStartingBetween(normalizedTracks.melody.events, 0.9, 1.25).map((event) => event.index),
  [0, 1]
);

const captureBuffer = {
  numberOfChannels: 2,
  length: 2,
  sampleRate: 48000,
  getChannelData(channel) {
    return channel === 0 ? new Float32Array([-1, 1]) : new Float32Array([0.5, -0.5]);
  }
};
const captureMetadata = createYouTubeCaptureMetadata({
  videoId: "dQw4w9WgXcQ",
  videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Captured song",
  capturedAt: "2026-07-15T10:00:00Z",
  videoOffsetSeconds: 0.137
}, captureBuffer, 24);
assert.equal(captureMetadata.type, "youtube-capture");
assert.equal(captureMetadata.audio.bitDepth, 24);
assert.equal(captureMetadata.audio.sampleRate, 48000);
assert.equal(captureMetadata.videoOffsetSeconds, 0.137);
assert.throws(() => createYouTubeCaptureMetadata({ videoUrl: "https://example.com/video" }), /YouTube URL/i);

assert.deepEqual(normalizeServiceHealth({
  service: "fgr-processing",
  ready: true,
  acceptedSourceFormats: ["MP3", "wav"],
  worker: { ready: true, missing: [] }
}).acceptedSourceFormats, ["mp3", "wav"]);

const overlappingEvents = normalizeNoteTracks({
  melody: [
    { t: 0, d: 4, midi: 60 },
    { t: 2, d: 0.1, midi: 64 },
    { t: 3, d: 1, midi: 67 }
  ]
}).melody.events;
assert.deepEqual(getActiveNoteEvents(overlappingEvents, 3.5).map((event) => event.midi), [60, 67]);

const nestedTracks = normalizeAssetsResponse({
  noteTracks: {},
  assets: { noteTracks: { bass: [{ t: 1, d: 0.2, midi: 40 }] } },
  analysis: { noteTracks: { melody: [{ t: 2, d: 0.2, midi: 62 }] } }
});
assert.equal(nestedTracks.noteTracks.bass.events[0].midi, 40);
assert.equal(nestedTracks.noteTracks.melody.events[0].midi, 62);

const calls = [];
const responses = [
  new Response(JSON.stringify({
    songId: "pesma-1",
    sourceAssetId: "src_123",
    asset: { id: "src_123", sha256: "b".repeat(64) }
  }), {
    status: 201,
    headers: { "content-type": "application/json" }
  }),
  new Response(JSON.stringify({
    songId: "pesma-1",
    jobId: "job_123",
    processing: { state: "queued", stage: "source", message: "Queued" }
  }), {
    status: 202,
    headers: { "content-type": "application/json" }
  }),
  new Response(JSON.stringify({
    songId: "pesma-1",
    jobId: "job_123",
    processing: { state: "ready", stage: "complete", message: "Ready" }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }),
  new Response(JSON.stringify({
    songId: "pesma-1",
    mix: { url: "/v1/songs/pesma-1/assets/mix" },
    stems: {
      bass: { url: "/v1/songs/pesma-1/assets/stems/bass" },
      vocals: { url: "/v1/songs/pesma-1/assets/stems/vocals" }
    },
    availableStems: ["bass", "vocals"]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
];

const client = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }
});

const file = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], "pesma.mp3", {
  type: "audio/mpeg"
});
const upload = await client.uploadFile("pesma-1", file, { uploadMode: "direct" });
assert.equal(upload.uploaded, true);
assert.equal(upload.sourceAssetId, "src_123");

const job = await client.startProcess("pesma-1", upload, {
  referenceChords: [{ t: 2, n: "G" }, { t: 0, n: "C" }]
});
assert.equal(job.jobId, "job_123");
assert.equal(job.processing.state, "queued");

const status = await client.getProcess("pesma-1");
assert.equal(status.processing.state, "ready");

const assets = await client.fetchAssets("pesma-1");
assert.deepEqual(assets.availableStems, ["bass", "vocals"]);
assert.match(assets.stems.vocals.url, /^http:\/\/127\.0\.0\.1:8765\//);
assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "GET", "GET"]);
assert.ok(calls[0].body instanceof FormData);
assert.deepEqual(JSON.parse(calls[1].body), {
  sourceAssetId: "src_123",
  referenceChords: [{ t: 0, n: "C" }, { t: 2, n: "G" }],
  referenceSourceSha256: "b".repeat(64)
});

const retainedSource = {
  assets: {
    mix: {
      id: `src_${"d".repeat(32)}`,
      sha256: "e".repeat(64)
    }
  }
};
assert.deepEqual(reusableProcessingSource(retainedSource), {
  sourceAssetId: `src_${"d".repeat(32)}`,
  sourceSha256: "e".repeat(64)
});
const retryCalls = [];
const retryRun = await beginProcessingRun({
  async startProcess(songId, source, processOptions) {
    retryCalls.push({ method: "process", songId, source, processOptions });
    return { jobId: "job_retry", processing: { state: "queued", percent: 0 } };
  },
  async uploadFile() {
    retryCalls.push({ method: "upload" });
    throw new Error("Identical retry source must not be uploaded again");
  }
}, "pesma-1", {
  currentSource: retainedSource,
  file,
  processOptions: { freshAnalysis: true }
});
assert.equal(retryRun.reusedSource, true);
assert.equal(retryRun.job.jobId, "job_retry");
assert.deepEqual(retryCalls, [{
  method: "process",
  songId: "pesma-1",
  source: {
    sourceAssetId: `src_${"d".repeat(32)}`,
    sourceSha256: "e".repeat(64)
  },
  processOptions: { freshAnalysis: true }
}]);

let freshAnalysisBody = null;
const freshAnalysisClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async (_url, options) => {
    freshAnalysisBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      songId: "pesma-1",
      jobId: "job_fresh",
      processing: { state: "queued", stage: "source" }
    }), { status: 202, headers: { "content-type": "application/json" } });
  }
});
await freshAnalysisClient.startProcess("pesma-1", `src_${"f".repeat(32)}`, { freshAnalysis: true });
assert.deepEqual(freshAnalysisBody, {
  sourceAssetId: `src_${"f".repeat(32)}`,
  freshAnalysis: true
});

const captureCalls = [];
const captureClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async (url, options) => {
    captureCalls.push({ url, options });
    if (captureCalls.length === 1) {
      return new Response(JSON.stringify({
        songId: "yt-song",
        sourceAssetId: "src_capture",
        asset: {
          id: "src_capture",
          filename: "yt-song-youtube-capture.wav",
          contentType: "audio/wav",
          sha256: "c".repeat(64),
          source: { type: "youtube-capture", defaultPlaybackMode: "local-mix" }
        }
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      songId: "yt-song",
      jobId: "job_capture",
      processing: { state: "queued", stage: "source" }
    }), { status: 202, headers: { "content-type": "application/json" } });
  }
});
const captured = await captureClient.processCapturedYouTubeAudio("yt-song", captureBuffer, {
  videoId: "dQw4w9WgXcQ",
  videoUrl: "https://youtu.be/dQw4w9WgXcQ",
  capturedAt: "2026-07-15T10:00:00Z"
});
assert.equal(captured.file.type, "audio/wav");
assert.equal(captured.file.name, "yt-song-youtube-capture.wav");
assert.equal(captured.jobId, "job_capture");
assert.equal(captureCalls.length, 2);
const capturedForm = captureCalls[0].options.body;
assert.ok(capturedForm instanceof FormData);
const capturedMetadata = JSON.parse(capturedForm.get("sourceMetadata"));
assert.equal(capturedMetadata.type, "youtube-capture");
assert.equal(capturedMetadata.audio.channels, 2);
assert.equal(capturedForm.get("file").type, "audio/wav");
assert.deepEqual(JSON.parse(captureCalls[1].options.body), { sourceAssetId: "src_capture" });

const healthClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async () => new Response(JSON.stringify({
    service: "fgr-processing",
    ready: true,
    acceptedSourceFormats: ["mp3", "wav"],
    worker: { ready: true, missing: [], dependencies: { demucs: { available: true } } }
  }), { status: 200, headers: { "content-type": "application/json" } })
});
assert.equal((await healthClient.getHealth()).worker.dependencies.demucs.available, true);

const localOnly = createProcessingClient({ baseUrl: "" });
const localResult = await localOnly.uploadFile("pesma-1", file);
assert.equal(localResult.needsService, true);
assert.equal(localResult.processing.state, "needs-service");

let pollingAttempts = 0;
const pollingClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async () => {
    pollingAttempts += 1;
    if (pollingAttempts < 3) throw new Error("temporary network interruption");
    return new Response(JSON.stringify({
      songId: "pesma-1",
      jobId: "job_123",
      processing: { state: "ready", stage: "complete", message: "Ready" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
const polled = await pollingClient.pollProcess("pesma-1", {
  intervalMs: 0,
  maxConsecutiveErrors: 3
});
assert.equal(polled.processing.state, "ready");
assert.equal(pollingAttempts, 3);

let releaseFirstChordWrite;
const serializedCalls = [];
const serializedClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async (_url, options) => {
    if (options.method === "GET") {
      return new Response(JSON.stringify({ songId: "pesma-1", chordRevision: 4, chords: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    serializedCalls.push(JSON.parse(options.body));
    if (serializedCalls.length === 1) {
      return new Promise((resolve) => {
        releaseFirstChordWrite = () => resolve(new Response(JSON.stringify({
          songId: "pesma-1",
          revision: 5,
          chords: serializedCalls[0].chords
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      });
    }
    return new Response(JSON.stringify({
      songId: "pesma-1",
      revision: 6,
      chords: serializedCalls[1].chords
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
await serializedClient.fetchAssets("pesma-1");
const firstChordWrite = serializedClient.patchChords("pesma-1", [{ t: 0, n: "C" }]);
const secondChordWrite = serializedClient.patchChords("pesma-1", [{ t: 0, n: "G" }]);
for (let attempt = 0; attempt < 10 && !releaseFirstChordWrite; attempt += 1) await Promise.resolve();
assert.equal(serializedCalls.length, 1);
assert.equal(serializedCalls[0].expectedRevision, 4);
releaseFirstChordWrite();
await firstChordWrite;
await secondChordWrite;
assert.equal(serializedCalls.length, 2);
assert.equal(serializedCalls[1].expectedRevision, 5);
assert.deepEqual(serializedCalls[1].chords, [{ t: 0, n: "G" }]);

const conflictCalls = [];
const conflictClient = createProcessingClient({
  baseUrl: "http://127.0.0.1:8765",
  xhrFactory: null,
  fetchImpl: async (_url, options) => {
    if (options.method === "GET") {
      return new Response(JSON.stringify({ songId: "pesma-1", chordRevision: 4, chords: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    conflictCalls.push(JSON.parse(options.body));
    if (conflictCalls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: "chord_revision_conflict",
          message: "Chart changed.",
          details: { expectedRevision: 4, currentRevision: 7 }
        }
      }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      songId: "pesma-1",
      revision: 8,
      chords: conflictCalls[1].chords
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
await conflictClient.fetchAssets("pesma-1");
await assert.rejects(
  conflictClient.patchChords("pesma-1", [{ t: 0, n: "C" }]),
  (error) => error.code === "chord_revision_conflict" && error.status === 409
);
assert.equal(conflictCalls.length, 1); // the conflicting chart was not retried
assert.equal(conflictCalls[0].expectedRevision, 4);
await conflictClient.patchChords("pesma-1", [{ t: 0, n: "Am" }]);
assert.equal(conflictCalls.length, 2);
assert.equal(conflictCalls[1].expectedRevision, 7);

console.log("processing-client tests passed");
