# FGR audio processing service

FGR now has a real local development flow:

```text
MP3 / WAV / FLAC / M4A / AIFF -> localhost API -> Demucs 6-stem worker
      |                                  |
      +-> original mix                   +-> bass, drums, guitar,
                                             piano, vocals, other
                                             |
                                             +-> server chord analysis
                                             +-> aligned lead/bass note events
```

The browser keeps the imported/captured source in IndexedDB, so it remains playable even
when the processing service is stopped. The service stores its own uploads,
job state, generated stems and confirmed chord chart below `.fgr-processing/`.
That directory is intentionally ignored by Git.

## Run on Windows

The service requires Python 3.11+, FFmpeg on `PATH` and Demucs installed in the
same Python environment that runs the service. New monophonic note tracks use
pYIN/Viterbi first because it explicitly models voicing and pitch continuity on
an isolated bass or lead stem. Basic Pitch is a secondary detector when pYIN
does not pass the quality gate, followed by NumPy/pure-Python autocorrelation
fallbacks.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-processing.txt
python -m pip install --no-deps basic-pitch==0.4.0
ffmpeg -version
python -m demucs --help
python processing_service.py --check-dependencies
python processing_service.py
```

The `--no-deps` Basic Pitch install intentionally avoids its old TensorFlow
pin on Python 3.12; FGR uses the bundled ONNX model. If Windows reports that a
SciPy/ONNX DLL is blocked by an application-control policy, unblock only this
project virtual environment once:

```powershell
Get-ChildItem .\.venv\Lib\site-packages -Recurse -File | Unblock-File
```

By default it listens on `http://127.0.0.1:8765`, accepts MP3, PCM WAV, FLAC,
M4A and uncompressed AIFF/AIF files up to 512 MiB and allows browser requests
only from localhost origins. Useful
development options are:

```powershell
python processing_service.py --port 8765 --workers 1 --verbose
python processing_service.py --data-root D:\fgr-processing --max-upload-mib 512
```

Separation defaults to four Demucs stabilization shifts and 50% chunk overlap,
which is slower than the upstream fast preset but gives cleaner practice stems.
They can be tuned per machine before starting the service:

```powershell
$env:FGR_DEMUCS_SHIFTS = "4"
$env:FGR_DEMUCS_OVERLAP = "0.5"
```

The static PWA can be served separately, for example on port 4173. Import a
song from `+ Dodaj pesmu -> Audio fajl`; local playback is immediate and the PWA
will upload and queue the six-channel separation automatically.

## Processing state

The client and service share one `processing` object:

```json
{
  "state": "separating",
  "stage": "separation",
  "message": "Separating six practice stems.",
  "percent": 44.5,
  "phase": "separation",
  "phaseIndex": 1,
  "phaseCount": 4,
  "stageDetail": { "worker": "demucs", "workerPercent": 59 },
  "updatedAt": "2026-07-11T12:00:00Z"
}
```

Allowed states are `queued`, `downloading`, `separating`, `analyzing`, `ready`,
`failed` and `needs-service`. `needs-service` means that the source audio is safe in the
browser and playable, but the localhost worker is not running yet.

Demucs progress is streamed from the worker instead of presenting a frozen
step. The overall percentage is monotonic: source/queue 0-5%, separation
5-71.5%, beat grid from 72%, chords from 76%, note transcription from 86%,
persistence from 96% and ready at 100%. A failed job keeps its last reached
percentage and can be retried.

## Implemented API

```text
POST   /v1/songs/:songId/uploads              multipart field: file
POST   /v1/songs/:songId/process              queue/retry asynchronous job
GET    /v1/songs/:songId/process              current job state and error
GET    /v1/songs/:songId/assets               mix, stem URLs and chord chart
GET    /v1/songs/:songId/assets/mix           original audio (Range supported)
GET    /v1/songs/:songId/assets/stems/:stem    generated WAV/MP3 (Range supported)
PATCH  /v1/songs/:songId/chords               confirmed manual/browser chart
GET    /v1/health                              dependency/capability preflight
```

The upload endpoint accepts `.mp3`, validated PCM `.wav`, `.flac`, `.m4a`,
uncompressed `.aif` and `.aiff`. A browser
YouTube-tab capture sends a JSON `sourceMetadata` multipart field alongside the
24-bit PCM WAV. The server preserves that WAV byte-for-byte, reports
`audio/wav`, supports Range playback, and passes the WAV itself to Demucs. The
client helper `processCapturedYouTubeAudio()` performs WAV encoding, upload and
job queuing while keeping the existing stems/chords/note-track response contract.

The bundled Demucs worker keeps each separated channel as the original
common-scale float32 WAV produced by Demucs. It no longer performs a second
per-stem MP3 encode, so channel mixing, muting and soloing do not add another
lossy generation. The asset store preserves each worker output's real suffix
and content type; custom or test processors that still return MP3 remain
supported and are served as `audio/mpeg`.

`GET /assets` also returns `noteTracks.melody` and `noteTracks.bass`. Each track
contains mix-aligned seconds and explicit provenance instead of pretending a
raw vocal or guitar stem is the melody:

```json
{
  "status": "ready",
  "role": "lead",
  "sourceStems": ["other"],
  "algorithm": "librosa-pyin-viterbi-v1+exact-register-v2",
  "timeBase": "mix-seconds",
  "timeOffset": 0,
  "hopSeconds": 0.015,
  "confidence": 0.84,
  "octaveStabilization": {
    "algorithm": "exact-detected-register-v2",
    "changedEvents": 0,
    "before": { "octaveJumpRate": 0.02 },
    "after": { "octaveJumpRate": 0.02 }
  },
  "events": [
    { "t": 8.963, "d": 0.075, "midi": 67, "detectedMidi": 67, "confidence": 0.932 }
  ]
}
```

The melody candidates are `other`, then `piano`, then `guitar`; vocals are
never treated as the instrumental melody. `other` is where the six-stem Demucs
model normally places clarinet, accordion, brass and similar lead instruments.
The bass line is transcribed only from the isolated bass stem. A track is
reported as `low-confidence` or `unavailable` when there is not enough reliable
monophonic evidence, so the UI can avoid presenting guesses as exact notes.
Detected MIDI register, timestamps and durations stay on the original mix
clock. User keyboard octave/voicing settings are never applied to AI playback.
Each result includes detector candidates and QA metrics, so low-confidence or
pathologically jumpy output is not presented as an exact transcription.

The bundled Luis demo has a generated, real analysis at
`samples/luis-sve-se-osim-tuge-deli/note-tracks.json`, produced from its local
`other.mp3` and `bass.mp3` stems rather than handwritten notes.

`POST /process` returns `202 Accepted` and a job ID immediately. Separation is
never performed inside the HTTP request. Job metadata is written atomically so
status survives a normal service restart; an interrupted active job becomes an
explicit failure that can be retried.

## Beat grid

`beat_grid.py` measures one shared rhythmic grid per song before harmony is
analysed, because every later layer is expressed against it. `GET /assets`
returns it as `beatGrid`:

```json
{
  "status": "ready",
  "meterStatus": "ready",
  "algorithm": "librosa-beat-track-v1+metric-phase-v1",
  "bpm": 76.0,
  "beatsPerBar": 4,
  "downbeatIndex": 2,
  "beats": [0.1625, 0.9519, 1.7647],
  "downbeats": [1.7647, 5.1548],
  "confidence": 1.0,
  "halfTimeApplied": true,
  "rawBpm": 151.999
}
```

The pulse comes from the `drums` stem (summed mix when drums are missing or
silent). Bar position is then chosen by testing 4, 3, 8 and 6 beat candidates
against a per-beat accent cue built from harmonic change, drum onsets and bass
onsets. Each cue is weighted by how much periodic structure it actually
carries, so an uninformative channel cannot dilute a strong one.

`beats` and `meterStatus` fail independently. A steady pulse with no clear
accent keeps `status: ready` and reports `meterStatus: uncertain`: notes can
still be quantised to beats, but bar-aware features must not trust the
downbeat. `halfTimeApplied` records that a bar spanning eight tracked beats was
folded, which is how an eighth-note tactus becomes the tempo people count.

Interval jitter of up to one analysis frame is inherent to the hop size and is
not charged against tempo stability.

The client mirror is `js/beat-grid.js`, which normalises the same document and
provides beat/bar lookup, beat-position conversion and grid-aware quantisation.
The timeline draws the grid so a wrong tempo or downbeat is visible before
anything is quantised against it.

## Chord recognition

Demucs supplies cleaner harmonic channels (`piano`, `guitar`, `other`). The
server mixes the available harmonic channels, evaluates major and minor triad
templates, uses bass context, and refines
audible change boundaries against the original mix clock.

The server chord vocabulary is currently **major/minor triads only**
(`CHORD_TEMPLATES` in `chord_pipeline.py`), which is narrower than the browser
fallback in `js/chord-analysis.js`. Chord decoding also still runs in free time
rather than against the beat grid above: measured on the bundled demo, only
9 of 63 chord boundaries land within 50 ms of a beat, with a median offset of
244 ms. Widening the vocabulary and decoding beat-synchronously is the next
planned step; see `docs/STUDIO_MATRIX_PLAN.md`. A manual chart made
after a job started is never overwritten. A stale browser-analysis fallback is
blocked while server analysis is active; if an older client races anyway, the
worker result replaces it and is also retained as `aiCandidateChords` for audit.

The current `htdemucs_6s` guitar and piano channels remain experimental in the
upstream model. FGR therefore preserves Demucs float32 WAV output and relative
channel gains without another lossy encode, but does not run an unverified
second separation/masking pass. Cleaner semantic guitar/harmony separation
needs a measured model upgrade and regression corpus rather than an expensive
untested dual pipeline.

This is intended as a reliable starting chart, not a claim of perfect musical
transcription. The UI always leaves the chart editable and asks before a manual
re-analysis replaces existing chords.

## Production boundary

The localhost implementation is deliberately dependency-free apart from the
audio worker and is suitable for development or a single trusted machine. A
hosted version should replace direct upload with authenticated signed object
storage, move jobs to a durable queue/GPU worker, use expiring CDN URLs and
authorize every song endpoint. User audio and generated stems must never be
committed to Git.

## Tests

```powershell
python -m unittest tests.test_processing_service tests.test_chord_pipeline tests.test_beat_grid
node tests\chord-analysis.test.mjs
node tests\beat-grid.test.mjs
```
