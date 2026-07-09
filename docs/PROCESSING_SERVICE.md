# FGR processing service contract

GitHub Actions is a temporary worker for demo songs and solo development. It is
not the production location for user audio, stem files, or job state.

## Production shape

```text
PWA -> API -> job queue -> GPU worker -> object storage/CDN
              |                         |
              +------ database <--------+
```

The PWA owns the interaction state. The API owns authorization, job state and
asset URLs. The worker owns downloading from approved sources, audio conversion,
separation and chord analysis.

## Song processing state

The client and worker use the same `processing` object:

```json
{
  "state": "queued",
  "stage": "source",
  "message": "Waiting for source audio.",
  "updatedAt": "2026-07-10T12:00:00Z"
}
```

Allowed states are `queued`, `downloading`, `separating`, `analyzing`, `ready`,
`failed` and `needs-service`. `needs-service` is local-only: an audio file is
available in the browser, but it has not been uploaded to a processing service.

## API surface

The backend should expose these endpoints after authentication is chosen:

```text
POST   /v1/songs/:songId/uploads         -> signed object-storage upload URL
POST   /v1/songs/:songId/process         -> creates/retries one job
GET    /v1/songs/:songId/process         -> current status and error
GET    /v1/songs/:songId/assets          -> mix and stem URLs
PATCH  /v1/songs/:songId/chords          -> confirmed user chord chart
```

`POST /process` accepts either an uploaded source asset ID or an approved source
reference. It must return a job ID immediately; it must never keep the browser
request open while separating audio.

## Audio rules

- Preserve the acquired source and worker intermediates as WAV or FLAC.
- Generate web delivery copies after separation (Opus preferred; MP3 fallback).
- Store raw source, masters and browser copies in object storage, never in Git.
- Return a `availableStems` array with the exact usable channels.
- Keep the original mix as the timing reference for the chord timeline.

## Quality gate

Every candidate separator is benchmarked on a fixed internal set before release.
For each song, record vocal bleed, harmonic clarity, artifacts, processing time,
and chord-recognition accuracy after separation. A user-facing result is called
"AI practice stems", not "studio multitrack".

## GitHub after migration

GitHub keeps source code, CI, deployment and small demo assets. The current
workflow can remain as a manually-triggered demo processor, but production jobs
must not be started by commits to `main`.
