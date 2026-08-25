import http.client
import io
import json
import math
import tempfile
import threading
import time
import unittest
import wave
from array import array
from pathlib import Path
from unittest import mock

from processing_service import (
    APIError,
    ExistingStemProcessor,
    BASS_PITCH_CONFIG,
    DEFAULT_MAX_UPLOAD_BYTES,
    MELODY_PITCH_CONFIG,
    ProcessingDependencyError,
    ProcessingResult,
    SongStore,
    create_server,
    build_argument_parser,
    extract_monophonic_note_track,
    normalize_beat_grid,
    segment_pitch_contour,
    normalize_note_tracks,
    note_track_octave_jump_metrics,
    pitch_frames_to_events,
    stabilize_note_event_octaves,
    _pitch_frames_python,
)


class FakeProcessor:
    def process(self, song_id, source_path, workspace, progress, *, reference_chords=None):
        self.source_payload = Path(source_path).read_bytes()
        self.source_suffix = Path(source_path).suffix.lower()
        self.reference_chords = reference_chords
        progress("analyzing", "analysis", "Preparing deterministic test stems.")
        output = Path(workspace) / "fake-output"
        output.mkdir(parents=True, exist_ok=True)
        stems = {}
        for name in ("piano", "vocals"):
            path = output / f"{name}.mp3"
            path.write_bytes(b"ID3" + name.encode("ascii"))
            stems[name] = path
        return ProcessingResult(
            stems=stems,
            chords=[{"t": 0.0, "n": "C"}, {"t": 1.237, "n": "G"}],
            note_tracks={
                "melody": {
                    "status": "ready",
                    "events": [{"t": 0.125, "d": 0.25, "midi": 69, "confidence": 0.9}],
                    "sourceStems": ["piano"],
                    "algorithm": "test-transcriber",
                    "hopSeconds": 0.02,
                    "confidence": 0.9,
                }
            },
            beat_grid={
                "status": "ready",
                "meterStatus": "ready",
                "algorithm": "test-grid",
                "sourceStems": ["drums"],
                "bpm": 120.0,
                "bpmRange": [119.5, 120.5],
                "beatsPerBar": 4,
                "downbeatIndex": 1,
                "beats": [round(index * 0.5, 4) for index in range(16)],
                "confidence": 0.9,
                "qa": {"beatCount": 16, "barCount": 4, "tempoStability": 1.0},
            },
        )


class ProcessingServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_root = Path(self.temporary.name) / "service-data"
        self.processor = FakeProcessor()
        self.server = create_server(
            "127.0.0.1",
            0,
            data_root=self.data_root,
            max_upload_bytes=512,
            processor=self.processor,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.app.close(wait=True)
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=b"", headers=None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=5)
        request_headers = dict(headers or {})
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        result_headers = {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        return response.status, result_headers, payload

    @staticmethod
    def multipart(
        payload,
        filename="track.mp3",
        boundary="fgr-test-boundary",
        content_type=None,
        source_metadata=None,
    ):
        media_type = content_type or ("audio/wav" if filename.lower().endswith(".wav") else "audio/mpeg")
        body = b""
        if source_metadata is not None:
            body += (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="sourceMetadata"\r\n'
                "Content-Type: application/json\r\n\r\n"
                f"{json.dumps(source_metadata)}\r\n"
            ).encode("utf-8")
        body += (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="'
            f"{filename}\"\r\n"
            f"Content-Type: {media_type}\r\n\r\n"
        ).encode("ascii") + payload + f"\r\n--{boundary}--\r\n".encode("ascii")
        return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}

    @staticmethod
    def wav_payload():
        target = io.BytesIO()
        with wave.open(target, "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(3)
            wav.setframerate(48000)
            wav.writeframes(b"\x00\x00\x00\x00\x00\x00" * 4)
        return target.getvalue()

    @staticmethod
    def flac_payload():
        packed = (44_100 << 44) | (1 << 41) | (15 << 36) | 4
        streaminfo = b"\x00" * 10 + packed.to_bytes(8, "big") + b"\x00" * 16
        return b"fLaC" + b"\x80" + len(streaminfo).to_bytes(3, "big") + streaminfo

    @staticmethod
    def m4a_payload():
        return (24).to_bytes(4, "big") + b"ftyp" + b"M4A " + b"\x00\x00\x00\x00" + b"isommp42"

    @staticmethod
    def aiff_payload():
        extended_44k1 = bytes.fromhex("400eac44000000000000")
        common = (2).to_bytes(2, "big") + (2).to_bytes(4, "big") + (16).to_bytes(2, "big") + extended_44k1
        comm_chunk = b"COMM" + len(common).to_bytes(4, "big") + common
        samples = b"\x00" * 8
        sound = b"\x00" * 8 + samples
        ssnd_chunk = b"SSND" + len(sound).to_bytes(4, "big") + sound
        contents = b"AIFF" + comm_chunk + ssnd_chunk
        return b"FORM" + len(contents).to_bytes(4, "big") + contents

    def upload(self, song_id="test-song", payload=b"ID3\x04\x00\x00test-audio"):
        body, headers = self.multipart(payload)
        status, response_headers, raw = self.request(
            "POST",
            f"/v1/songs/{song_id}/uploads",
            body,
            {**headers, "Origin": "http://localhost:3000"},
        )
        return status, response_headers, json.loads(raw)

    def test_real_multipart_upload_is_persisted_and_mix_supports_ranges(self):
        status, headers, response = self.upload()
        self.assertEqual(status, 201)
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:3000")
        self.assertRegex(response["sourceAssetId"], r"^src_[0-9a-f]{32}$")
        self.assertEqual(response["asset"]["filename"], "track.mp3")
        self.assertNotIn("path", response["asset"])

        state_files = list(self.data_root.glob("songs/test-song/uploads/*.mp3"))
        self.assertEqual(len(state_files), 1)
        self.assertEqual(state_files[0].read_bytes(), b"ID3\x04\x00\x00test-audio")

        status, headers, payload = self.request(
            "GET",
            "/v1/songs/test-song/assets/mix",
            headers={"Range": "bytes=0-2", "Origin": "http://127.0.0.1:8080"},
        )
        self.assertEqual(status, 206)
        self.assertEqual(payload, b"ID3")
        self.assertEqual(headers["content-range"], "bytes 0-2/16")

    def test_pcm_wav_capture_is_preserved_with_metadata_and_processed_losslessly(self):
        wav_payload = self.wav_payload()
        source_metadata = {
            "type": "youtube-capture",
            "videoId": "dQw4w9WgXcQ",
            "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Browser capture",
            "capturedAt": "2026-07-15T10:00:00Z",
            "videoOffsetSeconds": 0.137,
        }
        body, headers = self.multipart(
            wav_payload,
            filename="youtube-capture.wav",
            source_metadata=source_metadata,
        )
        status, _, raw = self.request("POST", "/v1/songs/wav-song/uploads", body, headers)
        response = json.loads(raw)
        self.assertEqual(status, 201, raw)
        self.assertEqual(response["asset"]["contentType"], "audio/wav")
        self.assertEqual(response["asset"]["filename"], "youtube-capture.wav")
        self.assertEqual(response["asset"]["audio"]["container"], "wav")
        self.assertEqual(response["asset"]["audio"]["codec"], "pcm")
        self.assertEqual(response["asset"]["audio"]["sampleRate"], 48000)
        self.assertEqual(response["asset"]["audio"]["channels"], 2)
        self.assertEqual(response["asset"]["audio"]["bitDepth"], 24)
        self.assertEqual(response["asset"]["source"]["type"], "youtube-capture")
        self.assertEqual(response["asset"]["source"]["videoId"], "dQw4w9WgXcQ")
        self.assertEqual(response["asset"]["source"]["videoOffsetSeconds"], 0.137)

        files = list(self.data_root.glob("songs/wav-song/uploads/*.wav"))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_bytes(), wav_payload)
        status, range_headers, ranged = self.request(
            "GET",
            "/v1/songs/wav-song/assets/mix",
            headers={"Range": "bytes=0-11"},
        )
        self.assertEqual(status, 206)
        self.assertEqual(range_headers["content-type"], "audio/wav")
        self.assertEqual(ranged, wav_payload[:12])

        request_body = json.dumps({"sourceAssetId": response["sourceAssetId"]}).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/v1/songs/wav-song/process",
            request_body,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 202, raw)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            _, _, raw = self.request("GET", "/v1/songs/wav-song/process")
            if json.loads(raw)["processing"]["state"] in {"ready", "failed"}:
                break
            time.sleep(0.01)
        self.assertEqual(self.processor.source_suffix, ".wav")
        self.assertEqual(self.processor.source_payload, wav_payload)

    def test_health_lists_supported_sources_and_worker_readiness(self):
        status, _, raw = self.request("GET", "/v1/health")
        health = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertTrue(health["ready"])
        self.assertEqual(health["acceptedSourceFormats"], ["mp3", "wav", "flac", "m4a", "aif", "aiff"])

    def test_lossless_and_high_quality_import_formats_are_validated_and_preserved(self):
        fixtures = [
            ("track.flac", self.flac_payload(), "audio/flac", "flac"),
            ("track.m4a", self.m4a_payload(), "audio/mp4", "m4a"),
            ("track.aiff", self.aiff_payload(), "audio/aiff", "aiff"),
        ]
        for index, (filename, payload, content_type, container) in enumerate(fixtures):
            with self.subTest(filename=filename):
                body, headers = self.multipart(payload, filename=filename, content_type=content_type)
                status, _, raw = self.request("POST", f"/v1/songs/format-{index}/uploads", body, headers)
                response = json.loads(raw)
                self.assertEqual(status, 201, raw)
                self.assertEqual(response["asset"]["contentType"], content_type)
                self.assertEqual(response["asset"]["audio"]["container"], container)

    def test_processing_job_is_async_and_lists_exact_usable_stems(self):
        _, _, upload = self.upload()
        body = json.dumps({"sourceAssetId": upload["sourceAssetId"]}).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/v1/songs/test-song/process",
            body,
            {"Content-Type": "application/json"},
        )
        accepted = json.loads(raw)
        self.assertEqual(status, 202)
        self.assertRegex(accepted["jobId"], r"^job_[0-9a-f]{32}$")

        deadline = time.monotonic() + 3
        current = None
        while time.monotonic() < deadline:
            status, _, raw = self.request("GET", "/v1/songs/test-song/process")
            self.assertEqual(status, 200)
            current = json.loads(raw)
            if current["processing"]["state"] in {"ready", "failed"}:
                break
            time.sleep(0.01)
        self.assertEqual(current["processing"]["state"], "ready")
        self.assertEqual(self.processor.source_payload, b"ID3\x04\x00\x00test-audio")

        status, _, raw = self.request("GET", "/v1/songs/test-song/assets")
        assets = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(assets["availableStems"], ["piano", "vocals"])
        self.assertEqual(set(assets["stems"]), {"piano", "vocals"})
        self.assertEqual(assets["stems"]["piano"]["contentType"], "audio/mpeg")
        self.assertTrue(assets["stems"]["piano"]["filename"].endswith("-piano.mp3"))
        self.assertEqual(assets["processing"]["state"], "ready")
        self.assertEqual(assets["noteTracks"]["melody"]["sourceStems"], ["piano"])
        self.assertEqual(
            assets["noteTracks"]["melody"]["events"],
            [{"t": 0.125, "d": 0.25, "midi": 69, "confidence": 0.9}],
        )
        self.assertEqual(assets["noteTrackRevision"], 1)
        self.assertEqual(assets["beatGrid"]["status"], "ready")
        self.assertEqual(assets["beatGrid"]["bpm"], 120.0)
        self.assertEqual(assets["beatGrid"]["beatsPerBar"], 4)
        self.assertEqual(assets["beatGrid"]["downbeats"], [0.5, 2.5, 4.5, 6.5])
        self.assertEqual(assets["beatGridRevision"], 1)
        self.assertEqual(assets["chords"], [{"t": 0.0, "n": "C"}, {"t": 1.237, "n": "G"}])
        self.assertEqual(assets["chordRevision"], 1)
        self.assertEqual(assets["chordTimeBase"], "mix-seconds")
        self.assertEqual(assets["chordTimingOffsetSeconds"], 0.0)
        self.assertEqual(assets["chordSourceSha256"], assets["mix"]["sha256"])
        self.assertEqual(assets["chordProvenance"]["origin"], "ai-analysis")

        status, _, piano = self.request("GET", assets["stems"]["piano"]["url"])
        self.assertEqual(status, 200)
        self.assertEqual(piano, b"ID3piano")

        reloaded = SongStore(self.data_root).read("test-song")
        self.assertEqual(reloaded["processing"]["state"], "ready")
        self.assertEqual(set(reloaded["assets"]["stems"]), {"piano", "vocals"})
        self.assertEqual(reloaded["noteTracks"]["melody"]["algorithm"], "test-transcriber")
        self.assertEqual(reloaded["beatGrid"]["algorithm"], "test-grid")

    def test_confirmed_chords_are_validated_sorted_and_persisted(self):
        self.upload()
        body = json.dumps({"chords": [{"t": 4.1259, "n": " G "}, {"t": 0, "n": "Am"}]}).encode("utf-8")
        status, _, raw = self.request(
            "PATCH",
            "/v1/songs/test-song/chords",
            body,
            {"Content-Type": "application/json"},
        )
        result = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(result["chords"], [{"t": 0.0, "n": "Am"}, {"t": 4.126, "n": "G"}])
        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["timeBase"], "mix-seconds")
        self.assertEqual(result["provenance"]["origin"], "manual-edit")

        status, _, raw = self.request("GET", "/v1/songs/test-song/assets")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["chords"], result["chords"])

        stale_body = json.dumps({
            "expectedRevision": 0,
            "chords": [{"t": 0, "n": "C"}],
        }).encode("utf-8")
        status, _, raw = self.request(
            "PATCH",
            "/v1/songs/test-song/chords",
            stale_body,
            {"Content-Type": "application/json"},
        )
        conflict = json.loads(raw)
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "chord_revision_conflict")
        self.assertEqual(conflict["error"]["details"], {"expectedRevision": 0, "currentRevision": 1})

        next_body = json.dumps({
            "expectedRevision": 1,
            "chords": [{"t": 0, "n": "C"}],
        }).encode("utf-8")
        status, _, raw = self.request(
            "PATCH",
            "/v1/songs/test-song/chords",
            next_body,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["revision"], 2)

    def test_verified_reference_chart_is_passed_to_worker(self):
        _, _, upload = self.upload()
        reference = [{"t": 4.25, "n": "G"}, {"t": 0, "n": "Am"}]
        body = json.dumps({
            "sourceAssetId": upload["sourceAssetId"],
            "referenceChords": reference,
            "referenceSourceSha256": upload["asset"]["sha256"],
        }).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/v1/songs/test-song/process",
            body,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 202, raw)

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            _, _, raw = self.request("GET", "/v1/songs/test-song/process")
            if json.loads(raw)["processing"]["state"] in {"ready", "failed"}:
                break
            time.sleep(0.01)
        self.assertEqual(self.processor.reference_chords, [{"t": 0.0, "n": "Am"}, {"t": 4.25, "n": "G"}])

    def test_reference_chart_with_wrong_source_hash_is_rejected(self):
        _, _, upload = self.upload()
        body = json.dumps({
            "sourceAssetId": upload["sourceAssetId"],
            "referenceChords": [{"t": 0, "n": "Am"}],
            "referenceSourceSha256": "0" * 64,
        }).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/v1/songs/test-song/process",
            body,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(raw)["error"]["code"], "reference_source_mismatch")

    def test_rejects_unsafe_ids_non_mp3_and_oversized_uploads(self):
        body, headers = self.multipart(b"ID3safe")
        status, _, raw = self.request("POST", "/v1/songs/%2e%2e/uploads", body, headers)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_song_id")

        body, headers = self.multipart(b"not audio", filename="track.mp3")
        status, _, raw = self.request("POST", "/v1/songs/test-song/uploads", body, headers)
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_mp3")

        body, headers = self.multipart(b"not a wav", filename="track.wav")
        status, _, raw = self.request("POST", "/v1/songs/test-song/uploads", body, headers)
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_wav")

        body, headers = self.multipart(b"fLaC", filename="track.flac")
        status, _, raw = self.request("POST", "/v1/songs/test-song/uploads", body, headers)
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_flac")

        body, headers = self.multipart(b"ID3" + b"x" * 600)
        status, _, raw = self.request("POST", "/v1/songs/test-song/uploads", body, headers)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(raw)["error"]["code"], "upload_too_large")

    def test_cors_preflight_allows_localhost_and_rejects_other_origins(self):
        status, headers, payload = self.request(
            "OPTIONS",
            "/v1/songs/test-song/uploads",
            headers={"Origin": "http://localhost:5173"},
        )
        self.assertEqual(status, 204)
        self.assertEqual(payload, b"")
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertIn("POST", headers["access-control-allow-methods"])

        status, _, raw = self.request(
            "OPTIONS",
            "/v1/songs/test-song/uploads",
            headers={"Origin": "https://example.com"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(raw)["error"]["code"], "origin_not_allowed")


class SongStoreChordIntegrityTests(unittest.TestCase):
    @staticmethod
    def result_with_chords(root, chords):
        stem = Path(root) / "piano.mp3"
        stem.write_bytes(b"ID3piano")
        return ProcessingResult(stems={"piano": stem}, chords=chords)

    def test_changed_source_hash_invalidates_chart_but_identical_reupload_preserves_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(temporary)
            first = store.register_upload("song", "first.mp3", b"ID3-first")
            store.save_chords("song", [{"t": 0.0, "n": "C"}])

            second = store.register_upload("song", "second.mp3", b"ID3-second")
            changed = store.read("song")
            self.assertNotEqual(first["sha256"], second["sha256"])
            self.assertEqual(changed["chords"], [])
            self.assertEqual(changed["chordRevision"], 2)
            self.assertIsNone(changed["chordSourceSha256"])

            store.save_chords("song", [{"t": 1.0, "n": "G"}])
            identical = store.register_upload("song", "same-audio.mp3", b"ID3-second")
            preserved = store.read("song")
            self.assertEqual(preserved["chords"], [{"t": 1.0, "n": "G"}])
            self.assertEqual(preserved["chordRevision"], 3)
            self.assertEqual(preserved["chordSourceSha256"], identical["sha256"])

    def test_retry_keeps_last_usable_stems_and_note_tracks_until_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = SongStore(root / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            first_job = store.start_job("song", source["id"])
            stem = root / "piano.wav"
            stem.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt retry-safe")
            note_tracks = {
                "melody": {
                    "status": "ready",
                    "events": [{"t": 0.1, "d": 0.2, "midi": 67, "confidence": 0.9}],
                    "sourceStems": ["piano"],
                }
            }
            store.complete_job(
                "song",
                first_job["id"],
                ProcessingResult(stems={"piano": stem}, note_tracks=note_tracks),
            )
            before = store.read("song")

            store.start_job("song", source["id"])
            during_retry = store.read("song")

            self.assertEqual(during_retry["assets"]["stems"], before["assets"]["stems"])
            self.assertEqual(during_retry["noteTracks"], before["noteTracks"])

    def test_fresh_retry_does_not_refine_the_previous_manual_chart(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(temporary)
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            manual = [{"t": 0.0, "n": "Am"}, {"t": 2.0, "n": "F"}]
            store.save_chords("song", manual)

            job = store.start_job("song", source["id"], fresh_analysis=True)

            self.assertTrue(job["freshAnalysis"])
            self.assertEqual(job["referenceChords"], [])

    def test_worker_completion_does_not_overwrite_manual_edit_made_after_job_started(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(Path(temporary) / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            job = store.start_job("song", source["id"])
            manual = [{"t": 0.0, "n": "Am"}, {"t": 2.0, "n": "F"}]
            store.save_chords("song", manual)

            store.complete_job(
                "song",
                job["id"],
                self.result_with_chords(temporary, [{"t": 0.0, "n": "C"}]),
            )
            record = store.read("song")
            completed_job = next(item for item in record["jobs"] if item["id"] == job["id"])
            self.assertEqual(record["chords"], manual)
            self.assertEqual(record["chordRevision"], 1)
            self.assertEqual(record["chordProvenance"]["origin"], "manual-edit")
            self.assertEqual(completed_job["chordResult"], "preserved-newer-revision")

    def test_browser_fallback_is_blocked_during_server_analysis(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(temporary)
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            store.start_job("song", source["id"])

            with self.assertRaises(APIError) as caught:
                store.save_chords("song", [{"t": 0.0, "n": "C"}], origin="browser-analysis")

            self.assertEqual(caught.exception.code, "server_analysis_active")
            self.assertEqual(store.read("song")["chords"], [])

    def test_ai_result_replaces_a_raced_browser_fallback_but_remains_a_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(Path(temporary) / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            job = store.start_job("song", source["id"])
            # Simulate a stale client that wrote between the job start and the
            # server-side guard introduced for browser fallback.
            with store._lock:
                record = store._load_unlocked("song")
                record["chords"] = [{"t": 0.0, "n": "Fmaj7"}]
                record["chordRevision"] = 1
                record["chordProvenance"] = {"origin": "browser-analysis"}
                store._write_unlocked("song", record)

            server_chart = [{"t": 0.0, "n": "Am"}, {"t": 4.0, "n": "G"}]
            store.complete_job("song", job["id"], self.result_with_chords(temporary, server_chart))
            record = store.read("song")

            self.assertEqual(record["chords"], server_chart)
            self.assertEqual(record["aiCandidateChords"], server_chart)
            self.assertEqual(record["aiCandidateChordCount"], 2)
            self.assertEqual(record["chordProvenance"]["origin"], "ai-analysis")
            completed = next(item for item in record["jobs"] if item["id"] == job["id"])
            self.assertEqual(completed["chordResult"], "replaced-browser-analysis")

    def test_progress_is_monotonic_and_exposes_phase_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(temporary)
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            job = store.start_job("song", source["id"])
            store.update_job(
                "song",
                job["id"],
                "separating",
                "separation",
                "Half way",
                percent=44.5,
                stage_detail={"workerPercent": 59, "model": "htdemucs_6s"},
            )
            store.update_job("song", job["id"], "separating", "separation", "Stale update", percent=20)
            processing = store.read("song")["processing"]

            self.assertEqual(processing["percent"], 44.5)
            self.assertEqual(processing["progress"]["percent"], 44.5)
            self.assertEqual(processing["progress"]["phase"], "separation")

    def test_worker_chart_is_mix_aligned_and_clears_legacy_timing_offset(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(Path(temporary) / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            job = store.start_job("song", source["id"])
            with store._lock:
                record = store._load_unlocked("song")
                record["chordTimingOffsetSeconds"] = 1.75
                store._write_unlocked("song", record)

            store.complete_job(
                "song",
                job["id"],
                self.result_with_chords(temporary, [{"t": 0.125, "n": "Dm"}]),
            )
            record = store.read("song")
            self.assertNotIn("chordTimingOffsetSeconds", record)
            self.assertEqual(record["chordTimeBase"], "mix-seconds")
            self.assertEqual(record["chordSourceSha256"], source["sha256"])
            self.assertEqual(record["chordProvenance"]["origin"], "ai-analysis")
            self.assertEqual(record["chordProvenance"]["sourceSha256"], source["sha256"])

    def test_empty_worker_chart_does_not_erase_verified_existing_chart(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = SongStore(Path(temporary) / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            existing = [{"t": 0.0, "n": "Am"}]
            store.save_chords("song", existing)
            job = store.start_job("song", source["id"])

            store.complete_job("song", job["id"], self.result_with_chords(temporary, []))
            record = store.read("song")
            completed_job = next(item for item in record["jobs"] if item["id"] == job["id"])
            self.assertEqual(record["chords"], existing)
            self.assertEqual(record["chordRevision"], 1)
            self.assertEqual(completed_job["chordResult"], "no-reliable-result")

    def test_lossless_wav_stem_keeps_its_container_and_content_type(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = SongStore(root / "data")
            source = store.register_upload("song", "track.mp3", b"ID3-track")
            job = store.start_job("song", source["id"])
            stem = root / "piano.wav"
            stem.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt lossless-test")

            store.complete_job("song", job["id"], ProcessingResult(stems={"piano": stem}))

            record = store.read("song")
            metadata = record["assets"]["stems"]["piano"]
            self.assertEqual(metadata["contentType"], "audio/wav")
            self.assertTrue(metadata["filename"].endswith("-piano.wav"))
            self.assertTrue(metadata["path"].endswith("-piano.wav"))
            served_metadata, served_path = store.asset("song", "piano")
            self.assertEqual(served_metadata["contentType"], "audio/wav")
            self.assertEqual(served_path.suffix, ".wav")
            self.assertEqual(served_path.read_bytes(), stem.read_bytes())


class ExistingProcessorTests(unittest.TestCase):
    def test_cli_default_upload_limit_matches_service_default(self):
        with mock.patch.dict("processing_service.os.environ", {}, clear=True):
            args = build_argument_parser().parse_args([])
        self.assertEqual(args.max_upload_mib * 1024 * 1024, DEFAULT_MAX_UPLOAD_BYTES)

    def test_discovers_lossless_wav_and_legacy_mp3_worker_outputs(self):
        for suffix in (".wav", ".mp3"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                script = root / "process_stems.py"
                script.write_text("raise SystemExit(0)\n", encoding="utf-8")
                source = root / "source.mp3"
                source.write_bytes(b"ID3source")
                workspace = root / "job"
                workspace.mkdir()
                processor = ExistingStemProcessor(script)

                class FakePopen:
                    def __init__(self):
                        self.stdout = io.StringIO(
                            'FGR_PROGRESS {"state":"separating","stage":"separation",'
                            '"percent":44.5,"message":"Separating","stageDetail":{"workerPercent":59}}\n'
                        )
                        self.pid = 12345
                        self.returncode = 0

                    def poll(self):
                        return self.returncode

                    def wait(self, timeout=None):
                        return self.returncode

                def fake_popen(*_args, **kwargs):
                    output = Path(kwargs["cwd"]) / "samples" / "safe-song"
                    output.mkdir(parents=True, exist_ok=True)
                    for name in ("bass", "drums", "guitar", "piano", "vocals", "other"):
                        (output / f"{name}{suffix}").write_bytes(b"stem-" + name.encode("ascii"))
                    return FakePopen()

                with mock.patch.object(processor, "require_dependencies", return_value={}):
                    with mock.patch("processing_service.subprocess.Popen", side_effect=fake_popen):
                        with mock.patch("processing_service.extract_chord_chart", return_value=[]):
                            with mock.patch("processing_service.extract_practice_note_tracks", return_value={}):
                                result = processor.process("safe-song", source, workspace, lambda *_: None)

                self.assertEqual(set(result.stems), {"bass", "drums", "guitar", "piano", "vocals", "other"})
                self.assertTrue(all(path.suffix == suffix for path in result.stems.values()))

    def test_machine_readable_worker_progress_is_forwarded_with_details(self):
        received = []

        def progress(state, stage, message, **metadata):
            received.append((state, stage, message, metadata))

        ExistingStemProcessor._consume_worker_progress(
            'prefix FGR_PROGRESS {"state":"separating","stage":"separation",'
            '"percent":38.4,"message":"Razdvajam","stageDetail":{"workerPercent":50}}',
            progress,
        )

        self.assertEqual(len(received), 1)
        self.assertEqual(received[0][:3], ("separating", "separation", "Razdvajam"))
        self.assertEqual(received[0][3]["percent"], 38.4)
        self.assertEqual(received[0][3]["stage_detail"], {"workerPercent": 50})

    def test_missing_worker_dependencies_are_explicit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "process_stems.py"
            script.write_text("raise SystemExit(0)\n", encoding="utf-8")
            source = root / "source.mp3"
            source.write_bytes(b"ID3source")
            workspace = root / "job"
            workspace.mkdir()
            processor = ExistingStemProcessor(script)
            with mock.patch("processing_service.importlib.util.find_spec", return_value=None):
                with mock.patch("processing_service.shutil.which", return_value=None):
                    with self.assertRaisesRegex(ProcessingDependencyError, "demucs, ffmpeg"):
                        processor.process("safe-song", source, workspace, lambda *_: None)

    def test_demucs_python_module_is_valid_when_global_executable_is_absent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "process_stems.py"
            script.write_text("raise SystemExit(0)\n", encoding="utf-8")
            processor = ExistingStemProcessor(script)

            def which(name):
                return "C:/ffmpeg.exe" if name == "ffmpeg" else None

            with mock.patch("processing_service.importlib.util.find_spec", return_value=object()):
                with mock.patch("processing_service.importlib.metadata.version", return_value="4.1.0"):
                    with mock.patch("processing_service.shutil.which", side_effect=which):
                        status = processor.dependency_status()

            self.assertTrue(status["ready"])
            self.assertEqual(status["dependencies"]["demucs"]["version"], "4.1.0")
            self.assertEqual(status["dependencies"]["demucs"]["invocation"][:2], [status["python"], "-m"])


class PitchSegmentationTests(unittest.TestCase):
    def contour(self, midi_sequence, hop=0.015):
        """Neprekidna kriva u centima iz niza MIDI vrednosti po frejmu."""
        times = [index * hop for index in range(len(midi_sequence))]
        cents = [None if value is None else value * 100.0 for value in midi_sequence]
        scores = [0.0 if value is None else 0.9 for value in midi_sequence]
        return times, cents, scores

    def config(self, **overrides):
        base = dict(
            name="melody", role="lead", sample_rate=8000, frame_seconds=0.06,
            hop_seconds=0.015, midi_min=48, midi_max=100, min_note_seconds=0.045,
            highpass_hz=75, lowpass_hz=3400,
        )
        base.update(overrides)
        return MELODY_PITCH_CONFIG.__class__(**base)

    def test_vibrato_stays_one_note(self):
        # Pola poluteona gore-dole oko C4 je vibrato, ne niz nota. Stari
        # pristup je ovo cepao na desetine kratkih dogadjaja.
        wobble = [62.0 + 0.45 * (1 if index % 2 else -1) for index in range(80)]
        times, cents, scores = self.contour(wobble)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual(len(notes), 1, f"vibrato je dao {len(notes)} nota")
        self.assertEqual(notes[0]["midi"], 62)

    def test_a_real_step_becomes_a_new_note(self):
        times, cents, scores = self.contour([62.0] * 40 + [64.0] * 40)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual([note["midi"] for note in notes], [62, 64])

    def test_a_brief_pitch_excursion_is_not_a_note(self):
        # Jedan frejm skoka je prelazni ton, ne nota.
        times, cents, scores = self.contour([62.0] * 40 + [67.0] + [62.0] * 40)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual([note["midi"] for note in notes], [62])

    def test_silence_ends_a_note(self):
        times, cents, scores = self.contour([62.0] * 30 + [None] * 20 + [62.0] * 30)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual(len(notes), 2, "pauza deli isti ton na dva")

    def test_an_onset_starts_a_new_note_at_the_same_pitch(self):
        # Dva ista tona odsvirana uzastopno: samo onset ih razdvaja.
        times, cents, scores = self.contour([62.0] * 80)
        notes = segment_pitch_contour(
            times, cents, scores, self.config(), onset_times=[0.6]
        )
        self.assertEqual(len(notes), 2)
        self.assertEqual({note["midi"] for note in notes}, {62})

    def test_notes_shorter_than_the_floor_are_dropped(self):
        times, cents, scores = self.contour([62.0] * 2 + [None] * 4 + [67.0] * 40)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual([note["midi"] for note in notes], [67])

    def test_pitch_is_the_median_not_the_last_frame(self):
        # Kraj tona sklizne navise; medijana mora da zadrzi pravu visinu.
        times, cents, scores = self.contour([62.0] * 40 + [62.4] * 6)
        notes = segment_pitch_contour(times, cents, scores, self.config())
        self.assertEqual(notes[0]["midi"], 62)

    def test_empty_input_is_safe(self):
        self.assertEqual(segment_pitch_contour([], [], [], self.config()), [])


class BeatGridNormalizationTests(unittest.TestCase):
    def base_grid(self, **overrides):
        grid = {
            "status": "ready",
            "meterStatus": "ready",
            "algorithm": "librosa-beat-track-v1",
            "sourceStems": ["drums"],
            "bpm": 120.0,
            "bpmRange": [119.0, 121.0],
            "beatsPerBar": 4,
            "downbeatIndex": 1,
            "beats": [round(index * 0.5, 4) for index in range(16)],
            "confidence": 0.88,
        }
        grid.update(overrides)
        return grid

    def test_a_valid_grid_is_preserved_and_downbeats_are_derived(self):
        result = normalize_beat_grid(self.base_grid())
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["beatsPerBar"], 4)
        self.assertEqual(result["downbeatIndex"], 1)
        self.assertEqual(result["downbeats"], [0.5, 2.5, 4.5, 6.5])
        self.assertEqual(result["timeBase"], "mix-seconds")

    def test_derived_downbeats_ignore_a_supplied_list(self):
        # The stored downbeats must always follow from beats and the phase, so
        # a hand-edited or stale list cannot desynchronise the two.
        result = normalize_beat_grid(self.base_grid(downbeats=[99.0, 123.0]))
        self.assertEqual(result["downbeats"], [0.5, 2.5, 4.5, 6.5])

    def test_unsorted_negative_and_duplicate_beats_are_repaired(self):
        result = normalize_beat_grid(self.base_grid(beats=[2.0, -1.0, 0.5, 2.0, 1.0, "x", None]))
        self.assertEqual(result["beats"], [0.5, 1.0, 2.0])

    def test_an_empty_beat_list_is_reported_as_unavailable(self):
        result = normalize_beat_grid(self.base_grid(beats=[], status="ready"))
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["downbeats"], [])

    def test_an_out_of_range_phase_is_folded_into_the_bar(self):
        result = normalize_beat_grid(self.base_grid(downbeatIndex=9, beatsPerBar=4))
        self.assertEqual(result["downbeatIndex"], 1)

    def test_an_absurd_bar_length_is_clamped(self):
        self.assertEqual(normalize_beat_grid(self.base_grid(beatsPerBar=999))["beatsPerBar"], 16)
        self.assertEqual(normalize_beat_grid(self.base_grid(beatsPerBar=1))["beatsPerBar"], 2)

    def test_an_unknown_status_falls_back_to_the_beat_evidence(self):
        self.assertEqual(normalize_beat_grid(self.base_grid(status="perfect"))["status"], "ready")
        self.assertEqual(normalize_beat_grid(self.base_grid(meterStatus="great"))["meterStatus"], "uncertain")

    def test_confidence_is_clamped_to_a_probability(self):
        self.assertEqual(normalize_beat_grid(self.base_grid(confidence=7.5))["confidence"], 1.0)
        self.assertEqual(normalize_beat_grid(self.base_grid(confidence=-3))["confidence"], 0.0)
        self.assertEqual(normalize_beat_grid(self.base_grid(confidence="high"))["confidence"], 0.0)

    def test_too_many_beats_are_rejected(self):
        with self.assertRaises(APIError):
            normalize_beat_grid(self.base_grid(beats=[float(index) for index in range(20_001)]))

    def test_a_non_mapping_grid_is_ignored(self):
        self.assertIsNone(normalize_beat_grid(None))
        self.assertIsNone(normalize_beat_grid([1, 2, 3]))

    def test_qa_candidates_are_sanitised(self):
        result = normalize_beat_grid(
            self.base_grid(
                qa={
                    "beatCount": 16,
                    "tempoStability": 1.0,
                    "meterCandidates": [
                        {"beatsPerBar": 4, "phase": 1, "ratio": 1.8},
                        {"beatsPerBar": "bad", "phase": 0, "ratio": 1.0},
                        "nonsense",
                    ],
                    "unexpected": "dropped",
                }
            )
        )
        self.assertNotIn("unexpected", result["qa"])
        self.assertEqual(result["qa"]["meterCandidates"], [{"beatsPerBar": 4, "phase": 1, "ratio": 1.8}])


class NoteTrackSavingTests(unittest.TestCase):
    """Notes corrected by ear have to survive, and keep the machine's copy.

    A correction is the only reference this project has for what the
    transcriber should have produced. Overwriting the machine's version with it
    would destroy the comparison that makes the correction useful beyond the
    song it was made on.
    """

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = SongStore(Path(self.directory.name))
        record = self.store._new_record("pesma")
        record["noteTracks"] = {
            "bass": {"role": "bass", "status": "ready", "events": [{"t": 1.0, "d": 0.5, "midi": 40}]}
        }
        self.store._write_unlocked("pesma", record)

    def test_a_correction_is_stored_and_the_machine_copy_kept(self):
        corrected = {
            "bass": {"role": "bass", "status": "ready", "events": [
                {"t": 1.0, "d": 0.5, "midi": 43},
                {"t": 2.0, "d": 0.5, "midi": 45},
            ]}
        }
        result = self.store.save_note_tracks("pesma", corrected)
        self.assertEqual(result["noteTrackRevision"], 1)

        record = self.store.read("pesma")
        self.assertEqual(len(record["noteTracks"]["bass"]["events"]), 2)
        self.assertEqual(record["noteTracks"]["bass"]["events"][0]["midi"], 43)
        self.assertEqual(record["noteTrackProvenance"]["origin"], "manual-edit")
        # The machine's own attempt is still there to be scored against.
        self.assertEqual(record["aiCandidateNoteTracks"]["bass"]["events"][0]["midi"], 40)

    def test_a_second_correction_does_not_overwrite_the_machine_copy(self):
        self.store.save_note_tracks("pesma", {"bass": {"events": [{"t": 1.0, "d": 0.5, "midi": 43}]}})
        self.store.save_note_tracks("pesma", {"bass": {"events": [{"t": 1.0, "d": 0.5, "midi": 44}]}})
        record = self.store.read("pesma")
        self.assertEqual(record["aiCandidateNoteTracks"]["bass"]["events"][0]["midi"], 40)
        self.assertEqual(record["noteTrackRevision"], 2)

    def test_an_edit_from_a_stale_view_is_refused(self):
        self.store.save_note_tracks("pesma", {"bass": {"events": [{"t": 1.0, "d": 0.5, "midi": 43}]}})
        with self.assertRaises(APIError):
            self.store.save_note_tracks(
                "pesma",
                {"bass": {"events": [{"t": 1.0, "d": 0.5, "midi": 47}]}},
                expected_revision=0,
            )


class NoteTranscriptionTests(unittest.TestCase):
    def test_both_detectors_run_for_bass_and_the_pair_is_preferred(self):
        """The bass is transcribed by one detector and placed by the other.

        pYIN gets the pitch right — 97% of its notes are tones of the chord the
        musician confirmed by ear — but reports the bass sounding for 36% of a
        song whose bass line barely stops. Basic Pitch finds twice as many
        notes and puts them an octave out. Neither is usable alone, so both run
        and the paired result is preferred when it passes the quality gate.
        """

        pyin_event = {"t": 0.0, "d": 0.5, "midi": 45, "confidence": 0.9}
        basic_events = [
            {"t": 0.0, "d": 0.5, "midi": 45, "confidence": 0.9},
            {"t": 0.6, "d": 0.5, "midi": 47, "confidence": 0.9},
        ]
        passed = {
            "passed": True,
            "reasons": [],
            "score": 0.9,
            "confidence": 0.9,
            "eventCount": 2,
            "eventRate": 1.0,
            "voicedCoverage": 0.5,
            "ultraShortCount": 0,
            "ultraShortRate": 0.0,
            "adjacentPairs": 0,
            "octaveJumps": 0,
            "octaveJumpRate": 0.0,
            "largeLeaps": 0,
            "largeLeapRate": 0.0,
        }
        with mock.patch("processing_service._extract_pyin", return_value=([pyin_event], "librosa-pyin-test", 1.0)):
            with mock.patch("processing_service.evaluate_note_track_qa", return_value=passed):
                with mock.patch(
                    "processing_service._extract_basic_pitch",
                    return_value=(basic_events, "basic-pitch-test"),
                ) as basic_pitch:
                    track = extract_monophonic_note_track("unused.wav", BASS_PITCH_CONFIG, "bass")

        basic_pitch.assert_called_once()
        self.assertEqual(track["status"], "ready")
        self.assertIn("pyin-register", track["algorithm"])
        self.assertEqual(len(track["events"]), 2)

    def test_pyin_alone_is_kept_when_the_pair_finds_no_more_notes(self):
        event = {"t": 0.0, "d": 0.5, "midi": 45, "confidence": 0.9}
        passed = {
            "passed": True,
            "reasons": [],
            "score": 0.9,
            "confidence": 0.9,
            "eventCount": 1,
            "eventRate": 1.0,
            "voicedCoverage": 0.5,
            "ultraShortCount": 0,
            "ultraShortRate": 0.0,
            "adjacentPairs": 0,
            "octaveJumps": 0,
            "octaveJumpRate": 0.0,
            "largeLeaps": 0,
            "largeLeapRate": 0.0,
        }
        with mock.patch("processing_service._extract_pyin", return_value=([event], "librosa-pyin-test", 1.0)):
            with mock.patch("processing_service.evaluate_note_track_qa", return_value=passed):
                with mock.patch(
                    "processing_service._extract_basic_pitch",
                    return_value=([], "basic-pitch-test"),
                ) as basic_pitch:
                    track = extract_monophonic_note_track("unused.wav", BASS_PITCH_CONFIG, "bass")

        basic_pitch.assert_called_once()
        self.assertEqual(track["status"], "ready")
        self.assertTrue(track["algorithm"].startswith("librosa-pyin-test"))
        self.assertEqual(track["events"][0]["midi"], 45)

    def test_basic_pitch_is_secondary_when_pyin_is_unavailable(self):
        event = {"t": 0.0, "d": 0.5, "midi": 67, "confidence": 0.9}
        with mock.patch("processing_service._extract_pyin", return_value=None):
            with mock.patch(
                "processing_service._extract_basic_pitch",
                return_value=([event], "basic-pitch-test"),
            ):
                track = extract_monophonic_note_track("unused.wav", MELODY_PITCH_CONFIG, "other")

        self.assertTrue(track["algorithm"].startswith("basic-pitch-test"))
        self.assertEqual(track["events"][0]["midi"], 67)

    def test_exact_register_preserves_every_accepted_detector_note(self):
        events = [
            {"t": 0.0, "d": 0.15, "midi": 67, "confidence": 0.93},
            {"t": 0.15, "d": 0.06, "midi": 55, "confidence": 0.62},
            {"t": 0.21, "d": 0.20, "midi": 62, "confidence": 0.91},
        ]

        stabilized = stabilize_note_event_octaves(events, MELODY_PITCH_CONFIG)

        self.assertEqual([event["midi"] for event in stabilized], [67, 55, 62])
        self.assertEqual(stabilized[1]["detectedMidi"], 55)
        self.assertEqual(note_track_octave_jump_metrics(events)["octaveJumps"], 1)
        self.assertEqual(note_track_octave_jump_metrics(stabilized)["octaveJumps"], 1)

    def test_exact_register_preserves_supported_octave_register_change(self):
        events = [
            {"t": 0.0, "d": 0.40, "midi": 60, "confidence": 0.97},
            {"t": 0.4, "d": 0.45, "midi": 72, "confidence": 0.98},
            {"t": 0.85, "d": 0.45, "midi": 74, "confidence": 0.98},
            {"t": 1.3, "d": 0.45, "midi": 76, "confidence": 0.98},
        ]

        stabilized = stabilize_note_event_octaves(events, MELODY_PITCH_CONFIG)

        self.assertEqual([event["midi"] for event in stabilized], [60, 72, 74, 76])

    def test_short_detected_octave_excursion_is_not_rewritten(self):
        config = MELODY_PITCH_CONFIG
        # Izlet mora biti duzi od praga trajanja: ovaj test brani da se
        # registar NE prepisuje, a ne da se kratki artefakt zadrzava.
        midis = [67] * 10 + [55] * 8 + [67] * 10
        frames = [
            ((index + 0.5) * config.hop_seconds, midi, 0.9)
            for index, midi in enumerate(midis)
        ]

        events = pitch_frames_to_events(frames, config)

        self.assertEqual([event["midi"] for event in events], [67, 55, 67])
        self.assertTrue(all(event["midi"] == event["detectedMidi"] for event in events))

    def test_excursions_below_the_duration_floor_are_dropped(self):
        # Novo ponasanje: ton kraci od sesnaestine u vodecoj deoniji je
        # mereno artefakt detektora, pa se odbacuje umesto da se svira.
        config = MELODY_PITCH_CONFIG
        midis = [67] * 20 + [55] * 3 + [67] * 20
        frames = [
            ((index + 0.5) * config.hop_seconds, midi, 0.9)
            for index, midi in enumerate(midis)
        ]

        events = pitch_frames_to_events(frames, config)

        self.assertEqual([event["midi"] for event in events], [67, 67])

    def test_short_bass_register_change_is_preserved_across_pluck_gaps(self):
        config = BASS_PITCH_CONFIG
        midis = [38] * 8 + [None] * 20 + [50] * 8 + [None] * 4 + [38] * 8
        frames = [
            ((index + 0.5) * config.hop_seconds, midi, 0.9 if midi is not None else 0.0)
            for index, midi in enumerate(midis)
        ]

        events = pitch_frames_to_events(frames, config)

        self.assertEqual([event["midi"] for event in events], [38, 50, 38])

    def test_ornament_length_register_change_is_preserved_between_same_lead_note(self):
        config = MELODY_PITCH_CONFIG
        midis = [74] * 10 + [None] * 2 + [62] * 8 + [None] * 2 + [74] * 10
        frames = [
            ((index + 0.5) * config.hop_seconds, midi, 0.9 if midi is not None else 0.0)
            for index, midi in enumerate(midis)
        ]

        events = pitch_frames_to_events(frames, config)

        self.assertEqual([event["midi"] for event in events], [74, 62, 74])

    def test_dependency_free_tracker_recovers_synthetic_bass_note_and_timing(self):
        config = BASS_PITCH_CONFIG
        leading_silence = int(config.sample_rate * 0.20)
        sounding = int(config.sample_rate * 0.60)
        samples = array("h", [0] * leading_silence)
        for index in range(sounding):
            envelope = min(1.0, index / 80.0, (sounding - index) / 80.0)
            value = 12_000 * envelope * math.sin(2 * math.pi * 110.0 * index / config.sample_rate)
            samples.append(int(value))
        samples.extend([0] * int(config.sample_rate * 0.20))

        frames = _pitch_frames_python(samples, config)
        events = pitch_frames_to_events(frames, config)

        strong = max(events, key=lambda item: item["d"])
        self.assertEqual(strong["midi"], 45)  # A2
        self.assertAlmostEqual(strong["t"], 0.20, delta=0.06)
        self.assertAlmostEqual(strong["d"], 0.60, delta=0.10)
        self.assertGreater(strong["confidence"], 0.8)

    def test_note_track_schema_is_ordered_bounded_and_has_provenance(self):
        tracks = normalize_note_tracks(
            {
                "bass": {
                    "events": [
                        {"t": 1.0, "d": 0.125, "midi": 40, "confidence": 0.8126},
                        {"t": 1.125, "d": 0.25, "midi": 43, "confidence": 0.75},
                    ],
                    "sourceStems": ["bass"],
                    "algorithm": "unit-test",
                    "confidence": 0.8,
                }
            }
        )
        self.assertEqual(tracks["bass"]["timeBase"], "mix-seconds")
        self.assertEqual(tracks["bass"]["sourceStems"], ["bass"])
        self.assertEqual(tracks["bass"]["events"][0]["confidence"], 0.813)

        with self.assertRaisesRegex(Exception, "ordered"):
            normalize_note_tracks(
                {
                    "melody": {
                        "events": [
                            {"t": 2, "d": 0.1, "midi": 60, "confidence": 0.8},
                            {"t": 1, "d": 0.1, "midi": 62, "confidence": 0.8},
                        ]
                    }
                }
            )


if __name__ == "__main__":
    unittest.main()
