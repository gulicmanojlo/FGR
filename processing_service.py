"""Local FGR audio-processing API.

This service is deliberately small and dependency-free at the HTTP layer.  It
stores uploads and job state below ``.fgr-processing`` and executes the existing
``process_stems.py`` worker in an isolated directory.  Demucs and ffmpeg remain
explicit runtime dependencies of the worker, not of the API server.

Run it with::

    python processing_service.py

The default address is http://127.0.0.1:8765.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import math
import mimetypes
import os
import re
import queue
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from array import array
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping
from urllib.parse import unquote, urlsplit

from beat_grid import BEAT_GRID_SCHEMA_VERSION, detect_beat_grid
import chord_accuracy
from chord_pipeline import extract_chord_chart


LOGGER = logging.getLogger("fgr.processing")
SONG_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,63})$")
ASSET_ID_RE = re.compile(r"^src_[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
STEM_NAMES = ("bass", "drums", "guitar", "piano", "vocals", "other")
NOTE_TRACK_NAMES = ("melody", "bass")
ACTIVE_STATES = frozenset({"queued", "downloading", "separating", "analyzing"})
MAX_JSON_BYTES = 1024 * 1024
MULTIPART_OVERHEAD_BYTES = 1024 * 1024
DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024
MAX_SOURCE_METADATA_BYTES = 16 * 1024
SOURCE_FORMATS = {
    ".mp3": {"contentType": "audio/mpeg", "container": "mp3"},
    ".wav": {"contentType": "audio/wav", "container": "wav"},
    ".flac": {"contentType": "audio/flac", "container": "flac"},
    ".m4a": {"contentType": "audio/mp4", "container": "m4a"},
    ".aif": {"contentType": "audio/aiff", "container": "aiff"},
    ".aiff": {"contentType": "audio/aiff", "container": "aiff"},
}
STEM_OUTPUT_SUFFIXES = (".wav", ".mp3")
YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
WORKER_PROGRESS_PREFIX = "FGR_PROGRESS "
PROCESSING_PHASE_COUNT = 5
PROCESSING_STAGE_DEFAULTS = {
    "source": (0.0, "queued", 0),
    "separation": (5.0, "separation", 1),
    # The rhythmic grid is measured before harmony because every later layer
    # is expressed against it.
    "beat-grid": (72.0, "grid", 2),
    "chord-analysis": (76.0, "chords", 3),
    "note-transcription": (86.0, "notes", 4),
    "persisting": (96.0, "finalizing", 5),
    "complete": (100.0, "complete", 5),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_progress_metadata(
    state: str,
    stage: str,
    percent: float | None = None,
    *,
    current_percent: float | None = None,
    stage_detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    default_percent, phase, phase_index = PROCESSING_STAGE_DEFAULTS.get(stage, (0.0, stage or "worker", 0))
    if percent is None:
        if state == "failed" and current_percent is not None:
            percent = current_percent
        else:
            percent = default_percent
    percent = max(0.0, min(100.0, float(percent)))
    if state in ACTIVE_STATES and current_percent is not None:
        percent = max(percent, float(current_percent))
    if state == "ready":
        percent = 100.0
        phase, phase_index = "complete", PROCESSING_PHASE_COUNT
    detail: dict[str, Any] = {}
    for key, value in (stage_detail or {}).items():
        if len(detail) >= 12:
            break
        safe_key = str(key)[:40]
        if isinstance(value, bool) or value is None or isinstance(value, str):
            detail[safe_key] = value if not isinstance(value, str) else value[:160]
        elif isinstance(value, (int, float)) and math.isfinite(float(value)):
            detail[safe_key] = round(float(value), 4)
    compact = {
        "percent": round(percent, 1),
        "phase": phase,
        "phaseIndex": phase_index,
        "phaseCount": PROCESSING_PHASE_COUNT,
    }
    if detail:
        compact["stageDetail"] = detail
    return {
        **compact,
        "progress": copy.deepcopy(compact),
    }


class APIError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = code
        self.message = message
        self.details = details


class ProcessingError(RuntimeError):
    code = "processing_failed"


class ProcessingDependencyError(ProcessingError):
    code = "dependency_unavailable"


@dataclass(frozen=True)
class ProcessingResult:
    stems: Mapping[str, Path]
    chords: list[dict[str, Any]] | None = None
    note_tracks: Mapping[str, Any] | None = None
    beat_grid: Mapping[str, Any] | None = None


def validate_song_id(song_id: str) -> str:
    if not SONG_ID_RE.fullmatch(song_id):
        raise APIError(
            HTTPStatus.BAD_REQUEST,
            "invalid_song_id",
            "Song ID must use 1-64 lowercase letters, digits, hyphens or underscores.",
        )
    return song_id


def inspect_wav(payload: bytes) -> dict[str, Any]:
    """Validate a RIFF/WAVE PCM source and return playback metadata.

    Browser captures are intentionally accepted only as uncompressed PCM (or
    IEEE float PCM).  This keeps the source deterministic and prevents a file
    with a ``.wav`` suffix from smuggling another compressed container into the
    worker.
    """

    if len(payload) < 44 or payload[:4] != b"RIFF" or payload[8:12] != b"WAVE":
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "Uploaded file is not a RIFF/WAVE audio file.")
    declared_size = int.from_bytes(payload[4:8], "little") + 8
    if declared_size > len(payload) or declared_size < 44:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "WAV container size is invalid.")

    fmt: bytes | None = None
    data_size = 0
    offset = 12
    while offset + 8 <= declared_size:
        chunk_id = payload[offset:offset + 4]
        chunk_size = int.from_bytes(payload[offset + 4:offset + 8], "little")
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > declared_size:
            raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "WAV chunk exceeds the container size.")
        if chunk_id == b"fmt " and fmt is None:
            fmt = payload[chunk_start:chunk_end]
        elif chunk_id == b"data" and data_size == 0:
            data_size = chunk_size
        offset = chunk_end + (chunk_size & 1)

    if fmt is None or len(fmt) < 16 or data_size <= 0:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "WAV must contain valid fmt and audio data chunks.")

    audio_format = int.from_bytes(fmt[0:2], "little")
    channels = int.from_bytes(fmt[2:4], "little")
    sample_rate = int.from_bytes(fmt[4:8], "little")
    byte_rate = int.from_bytes(fmt[8:12], "little")
    block_align = int.from_bytes(fmt[12:14], "little")
    bit_depth = int.from_bytes(fmt[14:16], "little")
    if audio_format == 0xFFFE and len(fmt) >= 40:
        audio_format = int.from_bytes(fmt[24:26], "little")
    if audio_format not in {1, 3}:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_wav_codec", "WAV must use uncompressed PCM audio.")
    if not 1 <= channels <= 8 or not 8_000 <= sample_rate <= 192_000:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "WAV channel count or sample rate is unsupported.")
    allowed_depths = {8, 16, 24, 32} if audio_format == 1 else {32}
    if bit_depth not in allowed_depths:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_wav_depth", "WAV bit depth is unsupported.")
    expected_align = channels * ((bit_depth + 7) // 8)
    if block_align != expected_align or byte_rate != sample_rate * block_align or data_size % block_align:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_wav", "WAV stream alignment is invalid.")

    return {
        "container": "wav",
        "codec": "pcm-float" if audio_format == 3 else "pcm",
        "sampleRate": sample_rate,
        "channels": channels,
        "bitDepth": bit_depth,
        "frames": data_size // block_align,
        "durationSeconds": round(data_size / byte_rate, 6),
    }


def inspect_flac(payload: bytes) -> dict[str, Any]:
    """Validate FLAC STREAMINFO and expose its lossless audio metadata."""

    if len(payload) < 42 or payload[:4] != b"fLaC":
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_flac", "Uploaded file is not FLAC audio.")
    block_type = payload[4] & 0x7F
    block_size = int.from_bytes(payload[5:8], "big")
    if block_type != 0 or block_size != 34 or len(payload) < 8 + block_size:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_flac", "FLAC STREAMINFO is missing or invalid.")
    streaminfo = payload[8:42]
    packed = int.from_bytes(streaminfo[10:18], "big")
    sample_rate = (packed >> 44) & 0xFFFFF
    channels = ((packed >> 41) & 0x07) + 1
    bit_depth = ((packed >> 36) & 0x1F) + 1
    total_samples = packed & ((1 << 36) - 1)
    if not 8_000 <= sample_rate <= 192_000 or not 1 <= channels <= 8 or not 4 <= bit_depth <= 32:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_flac", "FLAC audio parameters are unsupported.")
    result: dict[str, Any] = {
        "container": "flac",
        "codec": "flac",
        "sampleRate": sample_rate,
        "channels": channels,
        "bitDepth": bit_depth,
        "frames": total_samples,
    }
    if total_samples:
        result["durationSeconds"] = round(total_samples / sample_rate, 6)
    return result


def inspect_m4a(payload: bytes) -> dict[str, Any]:
    """Validate the ISO-BMFF file-type atom used by M4A audio."""

    if len(payload) < 16 or payload[4:8] != b"ftyp":
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_m4a", "Uploaded file is not an M4A container.")
    atom_size = int.from_bytes(payload[:4], "big")
    if atom_size < 16 or atom_size > len(payload):
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_m4a", "M4A file-type atom is invalid.")
    brands = {payload[8:12]}
    brands.update(payload[index:index + 4] for index in range(16, atom_size, 4) if index + 4 <= atom_size)
    accepted_brands = {b"M4A ", b"M4B ", b"isom", b"iso2", b"mp41", b"mp42"}
    if not brands.intersection(accepted_brands):
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_m4a", "M4A container brand is unsupported.")
    return {"container": "m4a", "codec": "compressed"}


def _decode_extended_80(payload: bytes) -> float:
    if len(payload) != 10:
        return 0.0
    exponent = ((payload[0] & 0x7F) << 8) | payload[1]
    mantissa = int.from_bytes(payload[2:], "big")
    if exponent == 0 and mantissa == 0:
        return 0.0
    if exponent == 0x7FFF:
        return float("inf")
    value = math.ldexp(float(mantissa), exponent - 16383 - 63)
    return -value if payload[0] & 0x80 else value


def inspect_aiff(payload: bytes) -> dict[str, Any]:
    """Validate AIFF/AIFC chunks and expose uncompressed audio metadata."""

    if len(payload) < 12 or payload[:4] != b"FORM" or payload[8:12] not in {b"AIFF", b"AIFC"}:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "Uploaded file is not AIFF audio.")
    declared_size = int.from_bytes(payload[4:8], "big") + 8
    if declared_size > len(payload) or declared_size < 12:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF container size is invalid.")
    common: bytes | None = None
    sound_payload_bytes = 0
    offset = 12
    while offset + 8 <= declared_size:
        chunk_id = payload[offset:offset + 4]
        chunk_size = int.from_bytes(payload[offset + 4:offset + 8], "big")
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > declared_size:
            raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF chunk exceeds the container size.")
        if chunk_id == b"COMM" and common is None:
            common = payload[chunk_start:chunk_end]
        elif chunk_id == b"SSND" and sound_payload_bytes == 0:
            if chunk_size < 8:
                raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF sound-data chunk is invalid.")
            sound_offset = int.from_bytes(payload[chunk_start:chunk_start + 4], "big")
            if sound_offset > chunk_size - 8:
                raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF sound-data offset is invalid.")
            sound_payload_bytes = chunk_size - 8 - sound_offset
        offset = chunk_end + (chunk_size & 1)
    if common is None or len(common) < 18 or sound_payload_bytes <= 0:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF must contain COMM and SSND chunks.")
    channels = int.from_bytes(common[0:2], "big")
    frames = int.from_bytes(common[2:6], "big")
    bit_depth = int.from_bytes(common[6:8], "big")
    sample_rate = int(round(_decode_extended_80(common[8:18])))
    if not 1 <= channels <= 8 or not 8_000 <= sample_rate <= 192_000 or not 1 <= bit_depth <= 32:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF audio parameters are unsupported.")
    bytes_per_frame = channels * ((bit_depth + 7) // 8)
    if frames <= 0 or bytes_per_frame <= 0 or sound_payload_bytes < frames * bytes_per_frame:
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_aiff", "AIFF sample data is incomplete.")
    if payload[8:12] == b"AIFC":
        if len(common) < 22 or common[18:22] not in {b"NONE", b"sowt", b"fl32", b"FL32", b"fl64", b"FL64"}:
            raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_aiff_codec", "Compressed AIFC audio is unsupported.")
    result = {
        "container": "aiff",
        "codec": "pcm" if payload[8:12] == b"AIFF" else "aifc",
        "sampleRate": sample_rate,
        "channels": channels,
        "bitDepth": bit_depth,
        "frames": frames,
    }
    if frames:
        result["durationSeconds"] = round(frames / sample_rate, 6)
    return result


def validate_source_audio(filename: str, payload: bytes) -> tuple[str, dict[str, Any]]:
    suffix = Path(filename).suffix.lower()
    source_format = SOURCE_FORMATS.get(suffix)
    if source_format is None:
        raise APIError(
            HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            "audio_format_required",
            "Supported audio formats are MP3, WAV, FLAC, M4A and AIFF.",
        )
    if suffix == ".mp3":
        if not looks_like_mp3(payload):
            raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_mp3", "Uploaded file does not look like MP3 audio.")
        audio = {"container": "mp3"}
    elif suffix == ".wav":
        audio = inspect_wav(payload)
    elif suffix == ".flac":
        audio = inspect_flac(payload)
    elif suffix == ".m4a":
        audio = inspect_m4a(payload)
    else:
        audio = inspect_aiff(payload)
    return suffix, {**source_format, **audio}


def normalize_source_metadata(value: Any, audio: Mapping[str, Any]) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_metadata", "sourceMetadata must be a JSON object.")

    raw_type = str(value.get("type") or value.get("sourceType") or "upload").strip().lower()
    source_type = "youtube-capture" if raw_type in {"youtube", "youtube-capture", "youtube_capture"} else "upload"
    result: dict[str, Any] = {
        "type": source_type,
        "audio": dict(audio),
    }
    if source_type == "youtube-capture":
        video_id = str(value.get("videoId") or "").strip()
        if video_id and not YOUTUBE_VIDEO_ID_RE.fullmatch(video_id):
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_youtube_video_id", "YouTube videoId is invalid.")
        video_url = str(value.get("videoUrl") or value.get("url") or "").strip()
        if video_url:
            try:
                parsed = urlsplit(video_url)
            except ValueError as exc:
                raise APIError(HTTPStatus.BAD_REQUEST, "invalid_youtube_url", "YouTube source URL is invalid.") from exc
            host = (parsed.hostname or "").lower().removeprefix("www.")
            official_host = (
                host == "youtu.be"
                or host == "youtube.com"
                or host.endswith(".youtube.com")
                or host == "youtube-nocookie.com"
                or host.endswith(".youtube-nocookie.com")
            )
            if parsed.scheme != "https" or not official_host:
                raise APIError(HTTPStatus.BAD_REQUEST, "invalid_youtube_url", "YouTube source URL must use an official HTTPS host.")
            result["videoUrl"] = video_url[:2048]
        if video_id:
            result["videoId"] = video_id
        title = str(value.get("title") or "").strip()
        captured_at = str(value.get("capturedAt") or "").strip()
        if title:
            result["title"] = title[:300]
        if captured_at:
            result["capturedAt"] = captured_at[:64]
        video_offset = value.get("videoOffsetSeconds")
        if isinstance(video_offset, (int, float)) and not isinstance(video_offset, bool):
            video_offset = float(video_offset)
            if math.isfinite(video_offset) and 0 <= video_offset <= 60:
                result["videoOffsetSeconds"] = round(video_offset, 3)
        result["captureMethod"] = "browser-decoded-pcm"
        result["defaultPlaybackMode"] = "local-mix"
    return result


def normalize_chords(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chords", "chords must be an array.")
    if len(value) > 10_000:
        raise APIError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_many_chords", "At most 10,000 chords are allowed.")

    chords: list[dict[str, Any]] = []
    for index, chord in enumerate(value):
        if not isinstance(chord, dict):
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chord", f"Chord {index} must be an object.")
        timestamp = chord.get("t")
        name = chord.get("n")
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chord_time", f"Chord {index} has an invalid time.")
        timestamp = float(timestamp)
        if not math.isfinite(timestamp) or timestamp < 0:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chord_time", f"Chord {index} has an invalid time.")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 32:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chord_name", f"Chord {index} has an invalid name.")
        chords.append({"t": round(timestamp, 3), "n": name.strip()})

    chords.sort(key=lambda item: item["t"])
    return chords


BEAT_GRID_STATUSES = ("ready", "low-confidence", "unavailable")
BEAT_GRID_METER_STATUSES = ("ready", "uncertain")
MAX_BEAT_GRID_BEATS = 20_000


def normalize_beat_grid(value: Any) -> dict[str, Any] | None:
    """Validate the shared tempo/beat/bar grid before it is stored or served.

    Beats are the time base every later layer quantises against, so a grid
    that is out of order, negative or absurdly dense is rejected rather than
    silently corrupting chord and note timing downstream.
    """

    if not isinstance(value, Mapping):
        return None

    beats: list[float] = []
    raw_beats = value.get("beats")
    if isinstance(raw_beats, (list, tuple)):
        if len(raw_beats) > MAX_BEAT_GRID_BEATS:
            raise APIError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "too_many_beats",
                f"At most {MAX_BEAT_GRID_BEATS} beats are allowed.",
            )
        for item in raw_beats:
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                continue
            timestamp = float(item)
            if math.isfinite(timestamp) and timestamp >= 0.0:
                beats.append(round(timestamp, 4))
    beats.sort()
    # A duplicated beat time would make bar indexing ambiguous.
    beats = [time for index, time in enumerate(beats) if index == 0 or time > beats[index - 1]]

    status = str(value.get("status") or "").strip().lower()
    if status not in BEAT_GRID_STATUSES:
        status = "ready" if beats else "unavailable"
    if not beats:
        status = "unavailable"

    beats_per_bar = value.get("beatsPerBar")
    beats_per_bar = int(beats_per_bar) if isinstance(beats_per_bar, (int, float)) and not isinstance(beats_per_bar, bool) else 4
    beats_per_bar = max(2, min(16, beats_per_bar))

    downbeat_index = value.get("downbeatIndex")
    downbeat_index = int(downbeat_index) if isinstance(downbeat_index, (int, float)) and not isinstance(downbeat_index, bool) else 0
    downbeat_index = max(0, downbeat_index) % beats_per_bar

    meter_status = str(value.get("meterStatus") or "").strip().lower()
    if meter_status not in BEAT_GRID_METER_STATUSES:
        meter_status = "uncertain"

    def _number(field: str, default: float = 0.0, digits: int = 3) -> float:
        raw = value.get(field)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(float(raw)):
            return round(float(raw), digits)
        return default

    bpm_range = value.get("bpmRange")
    if isinstance(bpm_range, (list, tuple)) and len(bpm_range) == 2:
        pair = [
            round(float(item), 3)
            for item in bpm_range
            if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item))
        ]
        bpm_range = sorted(pair) if len(pair) == 2 else [0.0, 0.0]
    else:
        bpm_range = [0.0, 0.0]

    result: dict[str, Any] = {
        "schemaVersion": BEAT_GRID_SCHEMA_VERSION,
        "status": status,
        "meterStatus": meter_status,
        "timeBase": "mix-seconds",
        "algorithm": str(value.get("algorithm") or "none")[:80],
        "sourceStems": [
            str(item)[:20] for item in (value.get("sourceStems") or []) if str(item).strip()
        ][:8],
        "bpm": max(0.0, _number("bpm")),
        "bpmRange": bpm_range,
        "rawBpm": max(0.0, _number("rawBpm")),
        "beatsPerBar": beats_per_bar,
        "downbeatIndex": downbeat_index,
        "beats": beats,
        "downbeats": beats[downbeat_index::beats_per_bar],
        "confidence": max(0.0, min(1.0, _number("confidence", digits=4))),
        "halfTimeApplied": bool(value.get("halfTimeApplied")),
        "feel": str(value.get("feel") or "")[:24],
        "syncopation": max(0.0, min(1.0, _number("syncopation", digits=4))),
        "message": str(value.get("message") or "")[:200],
    }

    qa = value.get("qa")
    if isinstance(qa, Mapping):
        safe_qa: dict[str, Any] = {}
        for key in (
            "beatCount", "barCount", "tempoStability",
            "pulseConfidence", "meterConfidence", "phaseRatio", "metricScore",
        ):
            raw = qa.get(key)
            if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(float(raw)):
                safe_qa[key] = round(float(raw), 4)
        candidates = qa.get("meterCandidates")
        if isinstance(candidates, (list, tuple)):
            safe_qa["meterCandidates"] = [
                {
                    "beatsPerBar": max(2, min(16, int(item.get("beatsPerBar", 4)))),
                    "phase": max(0, int(item.get("phase", 0))),
                    "ratio": round(float(item.get("ratio", 0.0)), 4),
                }
                for item in candidates[:8]
                if isinstance(item, Mapping)
                and isinstance(item.get("beatsPerBar"), (int, float))
                and isinstance(item.get("ratio"), (int, float))
            ]
        result["qa"] = safe_qa
    return result


def normalize_note_qa(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    numeric_fields = (
        "score", "confidence", "eventRate", "voicedCoverage", "ultraShortRate",
        "octaveJumpRate", "largeLeapRate",
    )
    integer_fields = ("eventCount", "ultraShortCount", "adjacentPairs", "octaveJumps", "largeLeaps")
    result: dict[str, Any] = {"passed": bool(value.get("passed"))}
    reasons = value.get("reasons")
    if isinstance(reasons, (list, tuple)):
        result["reasons"] = [str(item)[:80] for item in reasons[:12] if str(item).strip()]
    else:
        result["reasons"] = []
    for field in numeric_fields:
        raw = value.get(field)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(float(raw)):
            result[field] = round(float(raw), 6)
    for field in integer_fields:
        raw = value.get(field)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(float(raw)):
            result[field] = max(0, int(raw))
    return result


def normalize_note_tracks(value: Any) -> dict[str, dict[str, Any]]:
    """Validate the compact, mix-aligned practice-note timeline.

    Times are seconds from the beginning of the original mix.  Keeping this
    schema small makes it directly usable by WebAudio scheduling code while
    still carrying enough provenance to avoid presenting a guitar/vocal stem
    as if it were a transcribed lead melody.
    """

    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ProcessingError("note_tracks must be an object.")

    normalized: dict[str, dict[str, Any]] = {}
    for track_name, raw_track in value.items():
        if track_name not in NOTE_TRACK_NAMES:
            raise ProcessingError(f"Unsupported note track: {track_name}.")
        if not isinstance(raw_track, Mapping):
            raise ProcessingError(f"Note track '{track_name}' must be an object.")
        raw_events = raw_track.get("events", [])
        if not isinstance(raw_events, list):
            raise ProcessingError(f"Note track '{track_name}' events must be an array.")
        if len(raw_events) > 50_000:
            raise ProcessingError(f"Note track '{track_name}' contains too many events.")

        events: list[dict[str, Any]] = []
        previous_time = -1.0
        for index, raw_event in enumerate(raw_events):
            if not isinstance(raw_event, Mapping):
                raise ProcessingError(f"Note event {track_name}[{index}] must be an object.")
            timestamp = raw_event.get("t")
            duration = raw_event.get("d")
            midi = raw_event.get("midi")
            confidence = raw_event.get("confidence", 0.0)
            numeric_values = (timestamp, duration, midi, confidence)
            if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in numeric_values):
                raise ProcessingError(f"Note event {track_name}[{index}] contains invalid numbers.")
            timestamp = float(timestamp)
            duration = float(duration)
            raw_midi = float(midi)
            confidence = float(confidence)
            if not all(math.isfinite(item) for item in (timestamp, duration, raw_midi, confidence)):
                raise ProcessingError(f"Note event {track_name}[{index}] contains non-finite numbers.")
            midi = int(round(raw_midi))
            if timestamp < 0 or duration <= 0 or not 0 <= midi <= 127 or not 0 <= confidence <= 1:
                raise ProcessingError(f"Note event {track_name}[{index}] is outside the allowed range.")
            if timestamp < previous_time:
                raise ProcessingError(f"Note track '{track_name}' events must be ordered by time.")
            previous_time = timestamp
            events.append(
                {
                    "t": round(timestamp, 3),
                    "d": round(duration, 3),
                    "midi": midi,
                    "confidence": round(confidence, 3),
                }
            )
            # Izmerena dinamika napada. Bez ovoga bi klavir svirao sve tonove
            # jednako glasno, ma koliko ih transkripcija tačno pogodila.
            velocity = raw_event.get("vel")
            if velocity is not None and not isinstance(velocity, bool) and isinstance(velocity, (int, float)):
                velocity = float(velocity)
                if math.isfinite(velocity):
                    events[-1]["vel"] = round(max(0.0, min(1.0, velocity)), 3)
            detected_midi = raw_event.get("detectedMidi")
            if detected_midi is not None:
                if isinstance(detected_midi, bool) or not isinstance(detected_midi, (int, float)):
                    raise ProcessingError(f"Note event {track_name}[{index}] has invalid detectedMidi provenance.")
                detected_midi = int(round(float(detected_midi)))
                if not 0 <= detected_midi <= 127:
                    raise ProcessingError(f"Note event {track_name}[{index}] has invalid detectedMidi provenance.")
                events[-1]["detectedMidi"] = detected_midi

        source_stems = raw_track.get("sourceStems", [])
        if isinstance(source_stems, str):
            source_stems = [source_stems]
        if not isinstance(source_stems, (list, tuple)):
            raise ProcessingError(f"Note track '{track_name}' sourceStems must be an array.")
        source_stems = [str(name) for name in source_stems if str(name) in STEM_NAMES]
        raw_offset = raw_track.get("timeOffset") or 0.0
        raw_hop = raw_track.get("hopSeconds") or 0.02
        raw_track_confidence = raw_track.get("confidence") or 0.0
        if any(
            isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item))
            for item in (raw_offset, raw_hop, raw_track_confidence)
        ):
            raise ProcessingError(f"Note track '{track_name}' contains invalid timing metadata.")
        status = str(raw_track.get("status") or ("ready" if events else "unavailable"))
        if status not in {"ready", "low-confidence", "unavailable"}:
            status = "low-confidence" if events else "unavailable"
        normalized[track_name] = {
            "role": "lead" if track_name == "melody" else "bass",
            "status": status,
            "events": events,
            "sourceStems": source_stems,
            "algorithm": str(raw_track.get("algorithm") or "fgr-monophonic-v1")[:80],
            "timeBase": "mix-seconds",
            "timeOffset": round(float(raw_offset), 3),
            "hopSeconds": round(max(0.001, float(raw_hop)), 3),
            "confidence": round(min(1.0, max(0.0, float(raw_track_confidence))), 3),
        }
        message = str(raw_track.get("message") or "").strip()
        if message:
            normalized[track_name]["message"] = message[:300]
        raw_stabilization = raw_track.get("octaveStabilization")
        if isinstance(raw_stabilization, Mapping):
            normalized_metrics: dict[str, Any] = {
                "algorithm": str(raw_stabilization.get("algorithm") or "exact-detected-register-v2")[:80],
                "changedEvents": max(0, int(raw_stabilization.get("changedEvents") or 0)),
            }
            for phase in ("before", "after"):
                raw_metrics = raw_stabilization.get(phase)
                if not isinstance(raw_metrics, Mapping):
                    continue
                adjacent = max(0, int(raw_metrics.get("adjacentPairs") or 0))
                octave_jumps = max(0, int(raw_metrics.get("octaveJumps") or 0))
                large_leaps = max(0, int(raw_metrics.get("largeLeaps") or 0))
                normalized_metrics[phase] = {
                    "adjacentPairs": adjacent,
                    "octaveJumps": octave_jumps,
                    "octaveJumpRate": round(octave_jumps / max(1, adjacent), 6),
                    "largeLeaps": large_leaps,
                    "largeLeapRate": round(large_leaps / max(1, adjacent), 6),
                }
            normalized[track_name]["octaveStabilization"] = normalized_metrics
        qa = normalize_note_qa(raw_track.get("qa"))
        if qa is not None:
            normalized[track_name]["qa"] = qa
        raw_candidates = raw_track.get("detectorCandidates")
        if isinstance(raw_candidates, list):
            detector_candidates: list[dict[str, Any]] = []
            for raw_candidate in raw_candidates[:8]:
                if not isinstance(raw_candidate, Mapping):
                    continue
                candidate = {
                    "algorithm": str(raw_candidate.get("algorithm") or "unknown")[:80],
                    "selected": bool(raw_candidate.get("selected")),
                    "eventCount": max(0, int(raw_candidate.get("eventCount") or 0)),
                }
                raw_duration = raw_candidate.get("durationSeconds")
                if isinstance(raw_duration, (int, float)) and not isinstance(raw_duration, bool) and math.isfinite(float(raw_duration)):
                    candidate["durationSeconds"] = round(max(0.0, float(raw_duration)), 3)
                candidate_qa = normalize_note_qa(raw_candidate.get("qa"))
                if candidate_qa is not None:
                    candidate["qa"] = candidate_qa
                detector_candidates.append(candidate)
            if detector_candidates:
                normalized[track_name]["detectorCandidates"] = detector_candidates
    return normalized


@dataclass(frozen=True)
class PitchTrackConfig:
    name: str
    role: str
    sample_rate: int
    frame_seconds: float
    hop_seconds: float
    midi_min: int
    midi_max: int
    min_note_seconds: float
    highpass_hz: int
    lowpass_hz: int
    # Mereno na pet nezavisnih verzija iste pesme: bas note pocinju +54.6 do
    # +59.9 ms posle stvarnog napada, jer prozor od 186 ms ne moze da prijavi
    # visinu pre nego sto se napuni. Melodija nema takav pomak (-11..-17 ms).
    onset_correction_seconds: float = 0.0


MELODY_PITCH_CONFIG = PitchTrackConfig(
    name="melody",
    role="lead",
    sample_rate=8000,
    frame_seconds=0.060,
    hop_seconds=0.015,
    midi_min=48,
    midi_max=100,
    # Sesnaestina na 152 BPM je 98 ms. Sve krace od ovoga u vodecoj deonici
    # nije melodija nego treperenje detektora na kanalu koji sadrzi vise
    # instrumenata: mereno, kratke note imaju osetno nizu pouzdanost (0.55
    # naspram 0.66). Podizanje praga sa 45 na 90 ms obara udeo takvih nota sa
    # 54% na 35%, a zigzag artefakte sa 16% na 11%.
    min_note_seconds=0.090,
    highpass_hz=75,
    lowpass_hz=3400,
)
BASS_PITCH_CONFIG = PitchTrackConfig(
    name="bass",
    role="bass",
    sample_rate=4000,
    frame_seconds=0.090,
    hop_seconds=0.020,
    midi_min=28,
    midi_max=64,
    min_note_seconds=0.110,
    highpass_hz=25,
    lowpass_hz=430,
    onset_correction_seconds=0.055,
)


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((float(midi) - 69.0) / 12.0))


def hz_to_midi(frequency: float) -> float:
    return 69.0 + 12.0 * math.log2(float(frequency) / 440.0)


def decode_mono_pcm16(path: Path | str, config: PitchTrackConfig) -> array:
    """Decode one aligned stem without adding any encoder-dependent offset."""

    command = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(Path(path)),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-af",
        f"highpass=f={config.highpass_hz},lowpass=f={config.lowpass_hz}",
        "-ac",
        "1",
        "-ar",
        str(config.sample_rate),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30 * 60,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProcessingError(f"Could not decode the {config.name} analysis stem: {exc}") from exc
    if completed.returncode != 0:
        error = completed.stderr.decode("utf-8", errors="replace")[-1000:].strip()
        raise ProcessingError(f"Could not decode the {config.name} analysis stem. {error}".strip())
    samples = array("h")
    samples.frombytes(completed.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _percentile_block_rms(samples: array, frame_length: int) -> float:
    if not samples:
        return 0.0
    block = max(64, frame_length)
    levels: list[float] = []
    for start in range(0, len(samples), block):
        stop = min(len(samples), start + block)
        count = stop - start
        if count <= 0:
            continue
        energy = 0
        for index in range(start, stop, 2):
            value = int(samples[index])
            energy += value * value
        levels.append(math.sqrt(energy / max(1, (count + 1) // 2)))
    if not levels:
        return 0.0
    levels.sort()
    return levels[min(len(levels) - 1, int(len(levels) * 0.90))]


def _candidate_lags(config: PitchTrackConfig) -> list[int]:
    minimum = max(2, int(math.ceil(config.sample_rate / midi_to_hz(config.midi_max))))
    maximum = max(minimum + 1, int(math.floor(config.sample_rate / midi_to_hz(config.midi_min))))
    return list(range(minimum, maximum + 1))


def _pick_period_from_differences(differences: list[float], lags: list[int]) -> tuple[float, float] | None:
    if not differences:
        return None
    best_index = min(range(len(differences)), key=differences.__getitem__)
    best_value = differences[best_index]
    # A real fundamental is the first strong local minimum.  This avoids the
    # common one-octave-down error caused by equally periodic 2T/3T lags.
    # Permit a slightly weaker first-period minimum before a stronger 2T/3T
    # subharmonic.  Wind/reed lead instruments often make the longer lag look
    # mathematically cleaner even though the audible fundamental is one or two
    # octaves higher.
    allowed = min(0.44, best_value + 0.12)
    selected = best_index
    for index in range(1, len(differences) - 1):
        if (
            differences[index] <= allowed
            and differences[index] <= differences[index - 1]
            and differences[index] < differences[index + 1]
        ):
            selected = index
            break
    lag = float(lags[selected])
    if 0 < selected < len(differences) - 1:
        left, center, right = differences[selected - 1 : selected + 2]
        denominator = left - 2.0 * center + right
        if abs(denominator) > 1e-12:
            lag += max(-0.5, min(0.5, 0.5 * (left - right) / denominator))
    confidence = max(0.0, min(1.0, (0.55 - differences[selected]) / 0.47))
    if confidence <= 0:
        return None
    return lag, confidence


def _pitch_frames_python(samples: array, config: PitchTrackConfig) -> list[tuple[float, int | None, float]]:
    """Deterministic dependency-free fallback for a separated monophonic stem."""

    frame_length = max(64, int(round(config.frame_seconds * config.sample_rate)))
    hop_length = max(1, int(round(config.hop_seconds * config.sample_rate)))
    if len(samples) < frame_length:
        return []
    lags = _candidate_lags(config)
    reference_rms = _percentile_block_rms(samples, frame_length)
    silence_rms = max(42.0, reference_rms * (0.025 if config.name == "melody" else 0.040))
    quiet_rms = max(42.0, reference_rms * (0.075 if config.name == "melody" else 0.040))
    frames: list[tuple[float, int | None, float]] = []
    stride = 4 if config.name == "melody" else 3
    for start in range(0, len(samples) - frame_length + 1, hop_length):
        stop = start + frame_length
        mean = sum(int(samples[index]) for index in range(start, stop, 2)) / ((frame_length + 1) // 2)
        energy = 0.0
        for index in range(start, stop, 2):
            value = int(samples[index]) - mean
            energy += value * value
        rms = math.sqrt(energy / max(1, (frame_length + 1) // 2))
        center_time = (start + frame_length * 0.5) / config.sample_rate
        if rms < silence_rms:
            frames.append((center_time, None, 0.0))
            continue

        differences: list[float] = []
        for lag in lags:
            squared_difference = 0.0
            paired_energy = 0.0
            for offset in range(0, frame_length - lag, stride):
                first = int(samples[start + offset]) - mean
                second = int(samples[start + offset + lag]) - mean
                delta = first - second
                squared_difference += delta * delta
                paired_energy += first * first + second * second
            differences.append(squared_difference / max(1.0, paired_energy))
        period = _pick_period_from_differences(differences, lags)
        if period is None:
            frames.append((center_time, None, 0.0))
            continue
        lag, confidence = period
        midi = int(round(hz_to_midi(config.sample_rate / lag)))
        minimum_confidence = 0.45 if config.name == "melody" else 0.30
        boundary_noise = config.name == "melody" and midi >= config.midi_max - 5 and confidence < 0.72
        quiet_noise = config.name == "melody" and rms < quiet_rms and confidence < 0.80
        if confidence < minimum_confidence or boundary_noise or quiet_noise or not config.midi_min <= midi <= config.midi_max:
            frames.append((center_time, None, 0.0))
        else:
            frames.append((center_time, midi, confidence))
    return frames


def _pitch_frames_numpy(samples: array, config: PitchTrackConfig) -> list[tuple[float, int | None, float]] | None:
    """Fast normalized-autocorrelation backend; returns None without NumPy."""

    try:
        import numpy as np  # type: ignore[import-not-found]
    except ImportError:
        return None

    frame_length = max(64, int(round(config.frame_seconds * config.sample_rate)))
    hop_length = max(1, int(round(config.hop_seconds * config.sample_rate)))
    if len(samples) < frame_length:
        return []
    signal = np.asarray(samples, dtype=np.float64)
    starts = np.arange(0, len(signal) - frame_length + 1, hop_length, dtype=np.int64)
    lags = np.asarray(_candidate_lags(config), dtype=np.int64)
    reference_rms = _percentile_block_rms(samples, frame_length)
    silence_rms = max(42.0, reference_rms * (0.025 if config.name == "melody" else 0.040))
    quiet_rms = max(42.0, reference_rms * (0.075 if config.name == "melody" else 0.040))
    fft_size = 1
    while fft_size < frame_length * 2:
        fft_size *= 2
    output: list[tuple[float, int | None, float]] = []
    batch_size = 256
    offsets = np.arange(frame_length, dtype=np.int64)
    for batch_start in range(0, len(starts), batch_size):
        batch_starts = starts[batch_start : batch_start + batch_size]
        frames = signal[batch_starts[:, None] + offsets[None, :]]
        frames -= frames.mean(axis=1, keepdims=True)
        rms = np.sqrt(np.mean(frames * frames, axis=1))
        spectrum = np.fft.rfft(frames, n=fft_size, axis=1)
        correlation = np.fft.irfft(spectrum * np.conjugate(spectrum), n=fft_size, axis=1)[:, :frame_length]
        squares = frames * frames
        prefix = np.concatenate((np.zeros((len(frames), 1)), np.cumsum(squares, axis=1)), axis=1)
        energy_left = prefix[:, frame_length - lags]
        energy_right = prefix[:, frame_length, None] - prefix[:, lags]
        denominator = np.maximum(1.0, energy_left + energy_right)
        differences = np.maximum(0.0, (denominator - 2.0 * correlation[:, lags]) / denominator)
        for row, absolute_start in enumerate(batch_starts.tolist()):
            center_time = (absolute_start + frame_length * 0.5) / config.sample_rate
            if rms[row] < silence_rms:
                output.append((center_time, None, 0.0))
                continue
            period = _pick_period_from_differences(differences[row].tolist(), lags.tolist())
            if period is None:
                output.append((center_time, None, 0.0))
                continue
            lag, confidence = period
            midi = int(round(hz_to_midi(config.sample_rate / lag)))
            minimum_confidence = 0.45 if config.name == "melody" else 0.30
            boundary_noise = config.name == "melody" and midi >= config.midi_max - 5 and confidence < 0.72
            quiet_noise = config.name == "melody" and rms[row] < quiet_rms and confidence < 0.80
            if confidence < minimum_confidence or boundary_noise or quiet_noise or not config.midi_min <= midi <= config.midi_max:
                output.append((center_time, None, 0.0))
            else:
                output.append((center_time, midi, confidence))
    return output


def _smooth_pitch_frames(
    frames: list[tuple[float, int | None, float]],
    config: PitchTrackConfig,
) -> list[tuple[float, int | None, float]]:
    if len(frames) < 3:
        return frames
    values = [item[1] for item in frames]
    confidences = [item[2] for item in frames]
    # Repair only a missing detector frame between two identical notes. An
    # accepted pitch is never moved to a neighbouring octave (or replaced by
    # either neighbour): the teaching track must preserve the measured MIDI
    # register exactly.
    for index in range(1, len(values) - 1):
        previous, current, following = values[index - 1 : index + 2]
        if current is None and previous is not None and previous == following:
            values[index] = previous
            confidences[index] = min(confidences[index - 1], confidences[index + 1])
    return [(frames[index][0], values[index], confidences[index]) for index in range(len(frames))]


def segment_pitch_contour(
    times: Sequence[float],
    cents: Sequence[float | None],
    confidences: Sequence[float],
    config: PitchTrackConfig,
    *,
    onset_times: Sequence[float] | None = None,
    switch_cents: float = 62.0,
    stable_frames: int = 3,
) -> list[dict[str, Any]]:
    """Podeli neprekidnu visinsku krivu na note.

    Stari pristup je otvarao novu notu čim se promeni zaokružen MIDI broj
    frejma. Vibrato od pola poluteona oko granice zato je jedan izdržan ton
    cepao na pet, a merenje na demo pesmi je pokazalo 56% nota kraćih od
    120 ms i 15% `a-b-a` artefakata.

    Ovde nota traje dok se visina ne udalji od njene medijane za više od
    `switch_cents` i tako **ostane** bar `stable_frames` frejmova, ili dok
    detektovani onset ne najavi novi udarac. Visina note je medijana njenog
    trajanja, ne poslednji frejm.
    """

    stamps = [float(value) for value in times]
    values = [None if value is None else float(value) for value in cents]
    scores = [float(value) for value in confidences]
    if not stamps or len(stamps) != len(values):
        return []

    onsets = sorted(float(value) for value in (onset_times or []))
    onset_cursor = 0
    hop = max(1e-4, float(config.hop_seconds))
    notes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    pending: list[float] = []

    def close(end_index: int) -> None:
        nonlocal current
        if current is None:
            return
        span = current["cents"]
        if span:
            start = stamps[current["start"]] - hop * 0.5
            end = stamps[min(end_index, len(stamps) - 1)] + hop * 0.5
            duration = end - start
            if duration + 1e-9 >= config.min_note_seconds:
                ordered = sorted(span)
                median = ordered[len(ordered) // 2]
                weights = current["scores"] or [0.0]
                notes.append({
                    "t": round(max(0.0, start), 3),
                    "d": round(duration, 3),
                    "midi": int(round(median / 100.0)),
                    "confidence": round(max(0.0, min(1.0, sum(weights) / len(weights))), 3),
                })
        current = None

    for index, value in enumerate(values):
        # Onset unutar trajanja tona znači novi udarac iste ili druge visine.
        crossed_onset = False
        while onset_cursor < len(onsets) and onsets[onset_cursor] <= stamps[index]:
            if current is not None and onsets[onset_cursor] > stamps[current["start"]] + hop:
                crossed_onset = True
            onset_cursor += 1

        if value is None:
            close(index - 1 if index else 0)
            pending.clear()
            continue

        if current is None:
            current = {"start": index, "cents": [value], "scores": [scores[index]]}
            pending.clear()
            continue

        if crossed_onset:
            close(index - 1)
            current = {"start": index, "cents": [value], "scores": [scores[index]]}
            pending.clear()
            continue

        ordered = sorted(current["cents"])
        median = ordered[len(ordered) // 2]
        if abs(value - median) > switch_cents:
            # Odstupanje se prihvata kao nova nota tek kada potraje: kratak
            # izlet je vibrato ili prelazni ton, ne promena.
            pending.append(value)
            if len(pending) >= max(1, stable_frames):
                close(index - len(pending))
                current = {"start": index - len(pending) + 1, "cents": list(pending), "scores": [scores[index]]}
                pending.clear()
            continue

        pending.clear()
        current["cents"].append(value)
        current["scores"].append(scores[index])

    close(len(stamps) - 1)
    return notes


def attach_note_velocities(
    events: list[dict[str, Any]],
    samples: Any,
    sample_rate: int,
) -> list[dict[str, Any]]:
    """Dodaj stvarnu dinamiku iz jačine signala na početku svake note.

    Bez ovoga svaka nota stiže bez `vel`, pa klavir svira sve jednako glasno —
    a razlika u jačini je ono što izvođenje čini živim.
    """

    try:
        import numpy as np
    except Exception:
        return events
    audio = np.asarray(samples, dtype=np.float64)
    if not audio.size or not events:
        return events

    peaks: list[float] = []
    for event in events:
        start = int(max(0, float(event["t"]) * sample_rate))
        # Napad nosi dinamiku; rep note nosi samo odumiranje.
        end = int(min(audio.size, start + max(1, int(0.09 * sample_rate))))
        window = audio[start:end]
        peaks.append(float(np.sqrt(np.mean(np.square(window)))) if window.size else 0.0)

    reference = float(np.percentile(peaks, 90)) if peaks else 0.0
    for event, peak in zip(events, peaks, strict=True):
        if reference <= 1e-9:
            event["vel"] = 0.7
            continue
        # Kvadratni koren širi tihi kraj skale, gde uho najbolje razlikuje.
        event["vel"] = round(max(0.25, min(1.0, (peak / reference) ** 0.5)), 3)
    return events


def note_track_octave_jump_metrics(events: list[Mapping[str, Any]]) -> dict[str, Any]:
    """Return a stable adjacent-event register metric for QA and provenance."""

    adjacent = max(0, len(events) - 1)
    octave_jumps = 0
    large_leaps = 0
    for previous, current in zip(events, events[1:]):
        interval = abs(int(current.get("midi", 0)) - int(previous.get("midi", 0)))
        if interval >= 12:
            large_leaps += 1
        if interval >= 12 and interval % 12 == 0:
            octave_jumps += 1
    return {
        "adjacentPairs": adjacent,
        "octaveJumps": octave_jumps,
        "octaveJumpRate": round(octave_jumps / max(1, adjacent), 6),
        "largeLeaps": large_leaps,
        "largeLeapRate": round(large_leaps / max(1, adjacent), 6),
    }


def evaluate_note_track_qa(
    events: list[Mapping[str, Any]],
    duration_seconds: float,
    config: PitchTrackConfig,
) -> dict[str, Any]:
    """Score a detected line without rewriting any accepted pitch register."""

    duration = max(0.001, float(duration_seconds))
    confidence_numerator = sum(float(event.get("confidence") or 0.0) * float(event.get("d") or 0.0) for event in events)
    voiced_seconds = sum(float(event.get("d") or 0.0) for event in events)
    confidence = confidence_numerator / max(0.001, voiced_seconds)
    metrics = note_track_octave_jump_metrics(events)
    ultra_short_threshold = max(config.min_note_seconds * 1.55, config.hop_seconds * 2.25)
    ultra_short = sum(1 for event in events if float(event.get("d") or 0.0) < ultra_short_threshold)
    ultra_short_rate = ultra_short / max(1, len(events))
    event_rate = len(events) / duration
    octave_limit = 0.065 if config.name == "bass" else 0.12
    large_leap_limit = 0.16 if config.name == "bass" else 0.28
    event_rate_limit = 5.0 if config.name == "bass" else 9.0
    reasons: list[str] = []
    if len(events) < 3:
        reasons.append("too-few-events")
    if confidence < 0.46:
        reasons.append("low-confidence")
    if len(events) >= 12 and float(metrics["octaveJumpRate"]) > octave_limit:
        reasons.append("pathological-octave-jumps")
    if len(events) >= 12 and float(metrics["largeLeapRate"]) > large_leap_limit:
        reasons.append("pathological-large-leaps")
    if len(events) >= 20 and ultra_short_rate > 0.52:
        reasons.append("too-many-ultra-short-notes")
    if event_rate > event_rate_limit:
        reasons.append("implausible-note-density")
    score = (
        confidence
        - float(metrics["octaveJumpRate"]) * 1.75
        - max(0.0, ultra_short_rate - 0.25) * 0.45
        - max(0.0, event_rate - event_rate_limit) * 0.04
    )
    return {
        "passed": not reasons,
        "reasons": reasons,
        "score": round(score, 6),
        "confidence": round(max(0.0, min(1.0, confidence)), 6),
        "eventCount": len(events),
        "eventRate": round(event_rate, 6),
        "voicedCoverage": round(min(1.0, voiced_seconds / duration), 6),
        "ultraShortCount": ultra_short,
        "ultraShortRate": round(ultra_short_rate, 6),
        **metrics,
    }


def stabilize_note_event_octaves(
    events: list[dict[str, Any]],
    config: PitchTrackConfig,
) -> list[dict[str, Any]]:
    """Preserve every accepted detector event in its measured octave.

    The historical name remains part of the processing API, but continuity is
    now a QA metric only. Moving an event by 12 semitones can make a smooth line
    look nicer while teaching a note that never occurred in the recording.
    """

    preserved: list[dict[str, Any]] = []
    for source in events:
        event = dict(source)
        midi = int(round(float(event.get("midi", -1))))
        if not 0 <= midi <= 127 or not config.midi_min <= midi <= config.midi_max:
            continue
        event["midi"] = midi
        event["detectedMidi"] = int(round(float(event.get("detectedMidi", midi))))
        preserved.append(event)
    return preserved


def pitch_frames_to_events(
    frames: list[tuple[float, int | None, float]],
    config: PitchTrackConfig,
    *,
    stabilize_octaves: bool = True,
) -> list[dict[str, Any]]:
    frames = _smooth_pitch_frames(frames, config)
    if not frames:
        return []
    events: list[dict[str, Any]] = []
    run_start = 0
    while run_start < len(frames):
        midi = frames[run_start][1]
        run_end = run_start + 1
        while run_end < len(frames) and frames[run_end][1] == midi:
            run_end += 1
        if midi is not None:
            start = max(0.0, frames[run_start][0] - config.hop_seconds * 0.5)
            end = frames[run_end - 1][0] + config.hop_seconds * 0.5
            duration = end - start
            confidence_values = [item[2] for item in frames[run_start:run_end]]
            confidence = sum(confidence_values) / max(1, len(confidence_values))
            if duration + 1e-9 >= config.min_note_seconds:
                events.append(
                    {
                        "t": round(start, 3),
                        "d": round(duration, 3),
                        "midi": int(midi),
                        "confidence": round(max(0.0, min(1.0, confidence)), 3),
                    }
                )
        run_start = run_end

    # Merge detector dropouts shorter than one hop when the pitch is the same.
    merged: list[dict[str, Any]] = []
    for event in events:
        if merged:
            previous = merged[-1]
            gap = event["t"] - (previous["t"] + previous["d"])
            if event["midi"] == previous["midi"] and -0.002 <= gap <= config.hop_seconds * 1.1:
                previous_end = event["t"] + event["d"]
                previous["d"] = round(previous_end - previous["t"], 3)
                previous["confidence"] = round((previous["confidence"] + event["confidence"]) * 0.5, 3)
                continue
        merged.append(event)
    return stabilize_note_event_octaves(merged, config) if stabilize_octaves else merged


def _extract_basic_pitch(path: Path, config: PitchTrackConfig) -> tuple[list[dict[str, Any]], str] | None:
    """Use Basic Pitch when installed, then reduce its output to one line."""

    try:
        from basic_pitch.inference import predict  # type: ignore[import-not-found]
    except Exception:
        # Some Basic Pitch wheels expose only model files when their selected
        # runtime (ONNX/TensorFlow/CoreML) is missing. Treat that exactly like
        # an optional dependency instead of failing the complete song job.
        return None
    try:
        _model_output, _midi_data, raw_notes = predict(
            str(path),
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=max(30.0, config.min_note_seconds * 1000.0),
            minimum_frequency=midi_to_hz(config.midi_min),
            maximum_frequency=midi_to_hz(config.midi_max),
            multiple_pitch_bends=False,
            melodia_trick=True,
        )
    except Exception:
        LOGGER.warning("Basic Pitch failed for %s; using the deterministic fallback.", path, exc_info=True)
        return None
    notes: list[dict[str, Any]] = []
    for item in raw_notes or []:
        if len(item) < 4:
            continue
        start, end, midi, confidence = item[:4]
        midi = int(round(float(midi)))
        minimum_confidence = 0.30 if config.name == "bass" else 0.35
        if (
            config.midi_min <= midi <= config.midi_max
            and float(end) > float(start)
            and float(confidence) >= minimum_confidence
        ):
            notes.append(
                {
                    "t": round(max(0.0, float(start)), 3),
                    "d": round(float(end) - max(0.0, float(start)), 3),
                    "midi": midi,
                    "confidence": round(max(0.0, min(1.0, float(confidence))), 3),
                }
            )
    # If Basic Pitch emitted overlapping polyphony, retain the most confident
    # voice.  A separated lead/bass stem should normally need no reduction.
    selected: list[dict[str, Any]] = []
    for note in sorted(notes, key=lambda item: (item["t"], -item["confidence"])):
        if selected and note["t"] < selected[-1]["t"] + selected[-1]["d"]:
            if note["confidence"] <= selected[-1]["confidence"]:
                continue
            selected[-1]["d"] = round(max(0.001, note["t"] - selected[-1]["t"]), 3)
        selected.append(note)
    return selected, "basic-pitch-monophonic-v1"


def _extract_pyin(
    path: Path,
    config: PitchTrackConfig,
) -> tuple[list[dict[str, Any]], str, float] | None:
    """Decode a monophonic line with pYIN's probabilistic Viterbi model.

    pYIN is primary for the already-separated monophonic lead/bass stems: its
    explicit voicing model and transition constraint avoid octave aliases that
    a polyphonic note detector can accept. Every chosen register stays on the
    original mix clock and is never post-shifted for keyboard preferences.
    """

    try:
        import librosa  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]
    except Exception:
        return None

    sample_rate = 22_050
    frame_length = 4096 if config.name == "bass" else 2048
    hop_length = max(1, int(round(config.hop_seconds * sample_rate)))
    try:
        samples, _rate = librosa.load(str(path), sr=sample_rate, mono=True)
        if samples is None or len(samples) < frame_length:
            return None
        f0, voiced, voiced_probability = librosa.pyin(
            samples,
            fmin=midi_to_hz(config.midi_min),
            fmax=midi_to_hz(config.midi_max),
            sr=sample_rate,
            frame_length=frame_length,
            hop_length=hop_length,
            center=True,
            max_transition_rate=6.0 if config.name == "bass" else 12.0,
            switch_prob=0.01,
            no_trough_prob=0.01,
        )
    except Exception:
        LOGGER.warning("pYIN failed for %s; using autocorrelation.", path, exc_info=True)
        return None

    times = librosa.frames_to_time(
        np.arange(len(f0)),
        sr=sample_rate,
        hop_length=hop_length,
    )
    minimum_probability = 0.30 if config.name == "bass" else 0.35
    cents: list[float | None] = []
    scores: list[float] = []
    for index in range(len(times)):
        probability = float(voiced_probability[index]) if np.isfinite(voiced_probability[index]) else 0.0
        frequency = float(f0[index]) if np.isfinite(f0[index]) else 0.0
        if not bool(voiced[index]) or probability < minimum_probability or frequency <= 0:
            cents.append(None)
            scores.append(0.0)
            continue
        midi = hz_to_midi(frequency)
        if not config.midi_min - 0.5 <= midi <= config.midi_max + 0.5:
            cents.append(None)
            scores.append(0.0)
            continue
        # Krivu držimo u centima: zaokruživanje na MIDI pre segmentacije je
        # upravo ono što je vibrato pretvaralo u niz kratkih nota.
        cents.append(midi * 100.0)
        scores.append(max(0.0, min(1.0, probability)))

    # Onseti se namerno NE koriste za deljenje nota. Merenjem na stvarnim
    # kanalima ispalo je da samo pogorsavaju: na svakom pragu strogosti udeo
    # nota kracih od 120 ms je rastao (54% bez onseta, 56-59% sa njima), jer
    # "other" kanal nosi i perkusivno curenje pa detektor okida i tamo gde
    # vodeca deonica samo drzi ton. Segmentacija se oslanja na medijanu
    # visine i histerezu, sto je mereno bolje.
    events = segment_pitch_contour(
        [float(value) for value in times], cents, scores, config
    )
    if not events:
        return None
    events = apply_onset_correction(events, config.onset_correction_seconds)
    events = collapse_whole_tone_flicker(events)
    events = attach_note_velocities(events, samples, sample_rate)
    algorithm = "librosa-pyin-viterbi-v2+median-segments+onset-corrected"
    return events, algorithm, len(samples) / sample_rate


def apply_onset_correction(
    events: Sequence[Mapping[str, Any]],
    seconds: float,
) -> list[dict[str, Any]]:
    """Shift note starts back by a measured, detector-specific latency."""

    if not seconds:
        return [dict(event) for event in events]
    corrected: list[dict[str, Any]] = []
    for event in events:
        item = dict(event)
        start = max(0.0, float(item.get("t", 0.0)) - float(seconds))
        # The note ends where it ended; only its start was reported late.
        duration = float(item.get("d", 0.0)) + (float(item.get("t", 0.0)) - start)
        item["t"] = round(start, 3)
        item["d"] = round(max(0.01, duration), 3)
        corrected.append(item)
    return corrected


def collapse_whole_tone_flicker(
    events: Sequence[Mapping[str, Any]],
    maximum_interval: int = 2,
    maximum_middle_seconds: float = 0.22,
    neighbour_ratio: float = 0.5,
) -> list[dict[str, Any]]:
    """Fold an a-b-a wobble back into one held note.

    The duration filter never sees this one: the middle note is a normal
    length, it is the pitch that is wrong. Measured on the bass channel it
    accounts for 21-32% of all note triples, and almost all of it is a
    whole-tone oscillation around the true pitch rather than real playing.
    """

    items = [dict(event) for event in events]
    if len(items) < 3:
        return items

    index = 1
    while index < len(items) - 1:
        previous, middle, following = items[index - 1], items[index], items[index + 1]
        same_pitch = int(previous.get("midi", -1)) == int(following.get("midi", -2))
        interval = abs(int(middle.get("midi", 0)) - int(previous.get("midi", 0)))
        middle_seconds = float(middle.get("d", 0.0))
        short_enough = middle_seconds <= maximum_middle_seconds
        # A played passing note is comparable in length to what surrounds it.
        # A detector wobble is a brief flick inside a longer held note.
        subordinate = middle_seconds <= neighbour_ratio * min(
            float(previous.get("d", 0.0)), float(following.get("d", 0.0))
        )
        if same_pitch and 0 < interval <= maximum_interval and short_enough and subordinate:
            end = float(following.get("t", 0.0)) + float(following.get("d", 0.0))
            previous["d"] = round(max(0.01, end - float(previous.get("t", 0.0))), 3)
            del items[index : index + 2]
            index = max(1, index - 1)
            continue
        index += 1
    return items


def merge_short_notes(
    events: Sequence[Mapping[str, Any]],
    minimum_seconds: float,
    same_pitch_gap_seconds: float = 0.12,
) -> list[dict[str, Any]]:
    """Absorb notes under the duration floor instead of leaving them as debris.

    A note-level model splits a held note whenever its confidence dips, so its
    raw output carries many fragments that are not separate notes. Dropping
    them would leave holes; merging them into the note they belong to keeps the
    line continuous, which is what a player reads off the keyboard.
    """

    minimum = max(0.0, float(minimum_seconds))
    merged: list[dict[str, Any]] = []
    for event in events:
        item = dict(event)
        if merged:
            previous = merged[-1]
            previous_end = float(previous["t"]) + float(previous["d"])
            gap = float(item["t"]) - previous_end
            same_pitch = int(previous.get("midi", -1)) == int(item.get("midi", -2))
            if same_pitch and gap <= same_pitch_gap_seconds:
                end = max(previous_end, float(item["t"]) + float(item["d"]))
                previous["d"] = round(end - float(previous["t"]), 3)
                continue
            if float(item["d"]) < minimum and gap <= same_pitch_gap_seconds:
                # Too short to stand on its own and too close to be separate:
                # it belongs to the note before it.
                end = max(previous_end, float(item["t"]) + float(item["d"]))
                previous["d"] = round(end - float(previous["t"]), 3)
                continue
        if float(item["d"]) < minimum and not merged:
            continue
        merged.append(item)
    return [item for item in merged if float(item["d"]) >= min(minimum, 0.05)]


def snap_octaves_to_reference(
    events: Sequence[Mapping[str, Any]],
    reference: Sequence[Mapping[str, Any]],
    config: PitchTrackConfig,
    window_seconds: float = 4.0,
) -> list[dict[str, Any]]:
    """Move a note by whole octaves to the register the line is actually in.

    The two detectors fail in opposite directions: the note model segments a
    phrase well but puts 13-16% of notes an exact octave off, while the pitch
    tracker misses half the notes and gets the register right. Neither is
    trustworthy alone, but the disagreement is informative, because an octave
    error is exactly the error one of them does not make.
    """

    items = [dict(event) for event in events]
    anchors = [(float(item["t"]), int(item["midi"])) for item in reference if "midi" in item]
    if not items or not anchors:
        return items

    times = [time for time, _midi in anchors]
    pitches = [midi for _time, midi in anchors]
    overall = sorted(pitches)[len(pitches) // 2]

    import bisect

    for item in items:
        moment = float(item.get("t", 0.0))
        left = bisect.bisect_left(times, moment - window_seconds)
        right = bisect.bisect_right(times, moment + window_seconds)
        local = sorted(pitches[left:right])
        target = local[len(local) // 2] if local else overall

        best = int(item.get("midi", target))
        best_distance = abs(best - target)
        for shift in (-24, -12, 12, 24):
            candidate = int(item.get("midi", target)) + shift
            if not config.midi_min <= candidate <= config.midi_max:
                continue
            distance = abs(candidate - target)
            if distance < best_distance:
                best_distance = distance
                best = candidate
        item["midi"] = best
        if "detectedMidi" not in item:
            item["detectedMidi"] = int(event_midi) if (event_midi := item.get("midi")) else best
    return items


def solo_regions(
    events: Sequence[Mapping[str, Any]],
    join_seconds: float = 1.5,
    dilate_seconds: float = 0.5,
) -> list[tuple[float, float]]:
    """Time spans where a lead line is actually playing.

    pYIN finds only about half of a solo, but it finds *something* almost
    everywhere the solo plays, and nothing where only the singer is. That makes
    it a poor transcriber and a good region detector, which is the job it is
    given here.
    """

    spans: list[tuple[float, float]] = []
    for event in events:
        start = float(event.get("t", 0.0))
        end = start + float(event.get("d", 0.0))
        if end <= start:
            continue
        if spans and start - spans[-1][1] <= join_seconds:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return [(max(0.0, start - dilate_seconds), end + dilate_seconds) for start, end in spans]


def keep_events_inside_regions(
    events: Sequence[Mapping[str, Any]],
    regions: Sequence[tuple[float, float]],
) -> list[dict[str, Any]]:
    """Drop notes that fall outside every region where the lead line plays."""

    if not regions:
        return []
    kept: list[dict[str, Any]] = []
    for event in events:
        start = float(event.get("t", 0.0))
        centre = start + 0.5 * float(event.get("d", 0.0))
        for region_start, region_end in regions:
            if region_start <= centre <= region_end:
                kept.append(dict(event))
                break
    return kept


def extract_monophonic_note_track(
    path: Path | str,
    config: PitchTrackConfig,
    source_stem: str,
) -> dict[str, Any]:
    path = Path(path)
    candidates: list[tuple[float, list[dict[str, Any]], str, float, dict[str, Any]]] = []
    selected: tuple[list[dict[str, Any]], str, float, dict[str, Any]] | None = None

    pyin_result = _extract_pyin(path, config)
    if pyin_result is not None and pyin_result[0]:
        pyin_events, pyin_algorithm, pyin_duration = pyin_result
        pyin_qa = evaluate_note_track_qa(pyin_events, pyin_duration, config)
        candidates.append((float(pyin_qa["score"]), pyin_events, pyin_algorithm, pyin_duration, pyin_qa))
        if pyin_qa["passed"]:
            selected = (pyin_events, pyin_algorithm, pyin_duration, pyin_qa)

        # Melodija: pYIN nadje samo 45-48% sola jer prijavi "nema visine" i
        # tamo gde solo drzi ton. Basic Pitch nadje 86-89%, ali kad peva vokal
        # pokupi i pratnju (71.8% njegovih dodatnih nota je u pevanim
        # delovima). Zato jedan transkribuje, a drugi bira gde se slusa.
        if config.name == "melody":
            paired = _extract_basic_pitch(path, config)
            if paired is not None and paired[0]:
                regions = solo_regions(pyin_events)
                gated = keep_events_inside_regions(paired[0], regions)
                gated = merge_short_notes(gated, config.min_note_seconds)
                gated = snap_octaves_to_reference(gated, pyin_events, config)
                gated = collapse_whole_tone_flicker(gated)
                if len(gated) >= max(8, len(pyin_events) // 2):
                    gated_duration = max((event["t"] + event["d"] for event in gated), default=0.0)
                    gated_qa = evaluate_note_track_qa(gated, gated_duration, config)
                    gated_algorithm = f"{paired[1]}+pyin-solo-gate"
                    candidates.append(
                        (float(gated_qa["score"]) + 0.05, gated, gated_algorithm, gated_duration, gated_qa)
                    )
                    if gated_qa["passed"]:
                        selected = (gated, gated_algorithm, gated_duration, gated_qa)

    # Basic Pitch remains a secondary detector for sources on which pYIN has
    # insufficient voicing confidence or pathological register transitions.
    if selected is None:
        basic_pitch_result = _extract_basic_pitch(path, config)
        if basic_pitch_result is not None and basic_pitch_result[0]:
            basic_events, basic_algorithm = basic_pitch_result
            basic_duration = max((event["t"] + event["d"] for event in basic_events), default=0.0)
            basic_qa = evaluate_note_track_qa(basic_events, basic_duration, config)
            candidates.append((float(basic_qa["score"]), basic_events, basic_algorithm, basic_duration, basic_qa))
            if basic_qa["passed"]:
                selected = (basic_events, basic_algorithm, basic_duration, basic_qa)

    if selected is None and candidates:
        _score, detected_events, algorithm, duration_seconds, detector_qa = max(candidates, key=lambda item: item[0])
    elif selected is not None:
        detected_events, algorithm, duration_seconds, detector_qa = selected
    else:
        samples = decode_mono_pcm16(path, config)
        duration_seconds = len(samples) / config.sample_rate
        frames = _pitch_frames_numpy(samples, config)
        algorithm = "fgr-autocorrelation-numpy-v1"
        if frames is None:
            frames = _pitch_frames_python(samples, config)
            algorithm = "fgr-autocorrelation-python-v1"
        detected_events = pitch_frames_to_events(frames, config, stabilize_octaves=False)
        detector_qa = evaluate_note_track_qa(detected_events, duration_seconds, config)
        candidates.append((float(detector_qa["score"]), detected_events, algorithm, duration_seconds, detector_qa))

    before_octave_metrics = note_track_octave_jump_metrics(detected_events)
    events = stabilize_note_event_octaves(detected_events, config)
    after_octave_metrics = note_track_octave_jump_metrics(events)
    changed_events = sum(1 for event in events if event["midi"] != event["detectedMidi"])
    algorithm = f"{algorithm}+exact-register-v2"

    confidence = sum(event["confidence"] * event["d"] for event in events)
    confidence /= max(0.001, sum(event["d"] for event in events))
    qa = evaluate_note_track_qa(events, duration_seconds, config)
    status = "ready" if qa["passed"] else ("low-confidence" if events else "unavailable")
    message = ""
    if status == "low-confidence":
        message = "Detected notes need review before guided practice: " + ", ".join(qa["reasons"] or ["quality gate"])
    elif status == "unavailable":
        message = "No reliable monophonic note line was detected in this stem."
    return {
        "role": config.role,
        "status": status,
        "events": events,
        "sourceStems": [source_stem],
        "algorithm": algorithm,
        "timeBase": "mix-seconds",
        "timeOffset": 0.0,
        "hopSeconds": config.hop_seconds,
        "confidence": round(max(0.0, min(1.0, confidence)), 3),
        "durationSeconds": round(duration_seconds, 3),
        "octaveStabilization": {
            "algorithm": "exact-detected-register-v2",
            "changedEvents": changed_events,
            "before": before_octave_metrics,
            "after": after_octave_metrics,
        },
        "qa": qa,
        "detectorCandidates": [
            {
                "algorithm": candidate_algorithm,
                "eventCount": len(candidate_events),
                "durationSeconds": round(candidate_duration, 3),
                "qa": candidate_qa,
                "selected": candidate_algorithm in algorithm,
            }
            for _candidate_score, candidate_events, candidate_algorithm, candidate_duration, candidate_qa in candidates
        ],
        "message": message,
    }


def _melody_candidate_score(track: Mapping[str, Any], source_stem: str) -> float:
    events = track.get("events") or []
    if not events:
        return -1.0
    duration = max(1.0, float(track.get("durationSeconds") or 0.0))
    voiced = sum(float(event.get("d") or 0.0) for event in events)
    coverage = min(1.0, voiced / duration)
    rate = len(events) / duration
    confidence = float(track.get("confidence") or 0.0)
    # 'other' is where Demucs normally places clarinet, accordion, brass and
    # other lead instruments.  Piano/guitar are fallbacks only when their
    # separated signal is convincingly monophonic.
    source_bonus = {"other": 0.13, "piano": 0.02, "guitar": 0.0}.get(source_stem, 0.0)
    continuity_penalty = max(0.0, coverage - 0.88) * 0.35
    density_penalty = max(0.0, rate - 7.0) * 0.03
    return confidence + source_bonus - continuity_penalty - density_penalty


def extract_practice_note_tracks(
    stems: Mapping[str, Path],
    progress: Callable[[str, str, str], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Transcribe actual lead and bass events from aligned separated stems."""

    if progress:
        progress("analyzing", "note-transcription", "Transcribing time-aligned melody and bass notes.")
    note_tracks: dict[str, dict[str, Any]] = {}
    bass_path = stems.get("bass")
    if bass_path is not None:
        try:
            note_tracks["bass"] = extract_monophonic_note_track(bass_path, BASS_PITCH_CONFIG, "bass")
        except Exception as exc:
            LOGGER.warning("Bass-note transcription failed for %s: %s", bass_path, exc, exc_info=True)
            note_tracks["bass"] = {
                "role": "bass",
                "status": "unavailable",
                "events": [],
                "sourceStems": ["bass"],
                "algorithm": "none",
                "timeBase": "mix-seconds",
                "timeOffset": 0.0,
                "hopSeconds": BASS_PITCH_CONFIG.hop_seconds,
                "confidence": 0.0,
                "message": "Bass-note transcription failed; the audio stem is still available.",
            }
    else:
        note_tracks["bass"] = {
            "role": "bass",
            "status": "unavailable",
            "events": [],
            "sourceStems": [],
            "algorithm": "none",
            "timeBase": "mix-seconds",
            "timeOffset": 0.0,
            "hopSeconds": BASS_PITCH_CONFIG.hop_seconds,
            "confidence": 0.0,
            "message": "The separated bass channel is unavailable.",
        }

    melody_candidates: list[tuple[float, str, dict[str, Any]]] = []
    for source_stem in ("other", "piano", "guitar"):
        path = stems.get(source_stem)
        if path is None:
            continue
        try:
            candidate = extract_monophonic_note_track(path, MELODY_PITCH_CONFIG, source_stem)
        except Exception as exc:
            LOGGER.warning("Lead-note transcription failed for %s: %s", path, exc, exc_info=True)
            continue
        melody_candidates.append((_melody_candidate_score(candidate, source_stem), source_stem, candidate))
        # A clear 'other' line is already the best semantic match and avoids
        # spending time treating accompaniment channels as lead candidates.
        if source_stem == "other" and candidate["status"] == "ready" and candidate["confidence"] >= 0.58:
            break
    if melody_candidates:
        _score, _source, melody = max(melody_candidates, key=lambda item: item[0])
        note_tracks["melody"] = melody
    else:
        note_tracks["melody"] = {
            "role": "lead",
            "status": "unavailable",
            "events": [],
            "sourceStems": [],
            "algorithm": "none",
            "timeBase": "mix-seconds",
            "timeOffset": 0.0,
            "hopSeconds": MELODY_PITCH_CONFIG.hop_seconds,
            "confidence": 0.0,
            "message": "No instrumental stem is available for lead-melody transcription.",
        }
    return normalize_note_tracks(note_tracks)


class SongStore:
    """Thread-safe, JSON-backed local song store."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).expanduser().resolve()
        self.songs_root = self.root / "songs"
        self.songs_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.recover_interrupted_jobs()

    def _playlists_dir(self) -> Path:
        directory = self.root / "playlists"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def _playlist_name(name: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(name or "")).strip("-.")
        if not cleaned or len(cleaned) > 80:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_playlist", "Playlist name is not usable.")
        return cleaned.lower()

    def list_playlists(self) -> list[dict[str, Any]]:
        playlists: list[dict[str, Any]] = []
        for path in sorted(self._playlists_dir().glob("*.json")):
            try:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError):
                continue
            playlists.append(
                {
                    "name": data.get("name") or path.stem,
                    "slug": path.stem,
                    "songCount": len(data.get("songs") or []),
                    "updatedAt": data.get("updatedAt"),
                }
            )
        return playlists

    def read_playlist(self, name: str) -> dict[str, Any]:
        path = self._playlists_dir() / f"{self._playlist_name(name)}.json"
        if not path.is_file():
            raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Playlist not found.")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def write_playlist(self, name: str, data: Any) -> dict[str, Any]:
        if not isinstance(data, Mapping):
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_playlist", "Playlist must be an object.")
        slug = self._playlist_name(name)
        path = self._playlists_dir() / f"{slug}.json"
        payload = dict(data)
        payload.setdefault("version", 1)
        payload["name"] = payload.get("name") or name
        payload["updatedAt"] = utc_now()
        with self._lock:
            temporary = path.with_suffix(".json.tmp")
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.replace(temporary, path)
        return {"name": payload["name"], "slug": slug, "updatedAt": payload["updatedAt"]}

    def delete_playlist(self, name: str) -> bool:
        path = self._playlists_dir() / f"{self._playlist_name(name)}.json"
        with self._lock:
            if not path.is_file():
                return False
            path.unlink()
            return True

    def list_songs(self) -> list[dict[str, Any]]:
        """Summarise every song this service has on disk."""

        songs: list[dict[str, Any]] = []
        for directory in sorted(self.songs_root.glob("*")):
            record_path = directory / "song.json"
            if not record_path.is_file():
                continue
            try:
                with open(record_path, encoding="utf-8") as handle:
                    record = json.load(handle)
            except (OSError, ValueError):
                continue
            stems = (record.get("assets") or {}).get("stems") or {}
            tracks = record.get("noteTracks") or {}
            songs.append(
                {
                    "songId": record.get("songId") or directory.name,
                    "processing": record.get("processing"),
                    "chordCount": len(record.get("chords") or []),
                    "availableStems": [name for name in STEM_NAMES if name in stems],
                    "noteCounts": {
                        name: len((track or {}).get("events") or [])
                        for name, track in tracks.items()
                    },
                    "beatGrid": {
                        "bpm": (record.get("beatGrid") or {}).get("bpm"),
                        "beatsPerBar": (record.get("beatGrid") or {}).get("beatsPerBar"),
                    },
                    "updatedAt": record.get("updatedAt"),
                    "sourceName": next(
                        (
                            str(item.get("filename") or "")
                            for item in reversed(record.get("uploads") or [])
                            if item.get("filename")
                        ),
                        "",
                    ),
                }
            )
        return songs

    def delete_song(self, song_id: str) -> bool:
        """Retire one song into the trash folder.

        Not a real delete. Separation takes minutes and a capture cannot be
        recorded twice, so an accidental click must stay recoverable: the song
        moves aside, keeping its name and a timestamp, and can be moved back by
        hand. Reclaiming the disk is a separate, deliberate act.
        """

        directory = self._song_dir(song_id)
        with self._lock:
            if not directory.exists():
                return False
            trash = self.root / "trash"
            trash.mkdir(parents=True, exist_ok=True)
            stamp = utc_now().replace(":", "-").replace(".", "-")
            target = trash / f"{song_id}__{stamp}"
            try:
                directory.rename(target)
            except OSError:
                # A locked file must not turn a delete into a half-deleted song.
                shutil.copytree(directory, target, dirs_exist_ok=True)
                shutil.rmtree(directory, ignore_errors=True)
            return not directory.exists()

    def _song_dir(self, song_id: str) -> Path:
        validate_song_id(song_id)
        return self.songs_root / song_id

    def _record_path(self, song_id: str) -> Path:
        return self._song_dir(song_id) / "song.json"

    def _new_record(self, song_id: str) -> dict[str, Any]:
        now = utc_now()
        return {
            "version": 1,
            "songId": song_id,
            "createdAt": now,
            "updatedAt": now,
            "uploads": [],
            "processing": None,
            "jobs": [],
            "assets": {"mix": None, "stems": {}},
            "chords": [],
            "chordRevision": 0,
            "chordsUpdatedAt": None,
            "chordTimeBase": None,
            "chordSourceSha256": None,
            "chordProvenance": None,
            "aiCandidateChords": [],
            "aiCandidateChordCount": 0,
            "aiCandidateJobId": None,
            "aiCandidateGeneratedAt": None,
            "noteTracks": {},
            "noteTrackRevision": 0,
            "noteTracksUpdatedAt": None,
        }

    def _load_unlocked(self, song_id: str, *, required: bool = True) -> dict[str, Any]:
        path = self._record_path(song_id)
        if not path.is_file():
            if required:
                raise APIError(HTTPStatus.NOT_FOUND, "song_not_found", "Song has no uploaded source.")
            return self._new_record(song_id)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Could not read persisted song state for {song_id}: {exc}") from exc
        if not isinstance(value, dict) or value.get("songId") != song_id:
            raise RuntimeError(f"Persisted song state is invalid for {song_id}.")
        return value

    def _write_unlocked(self, song_id: str, record: dict[str, Any]) -> None:
        directory = self._song_dir(song_id)
        directory.mkdir(parents=True, exist_ok=True)
        record["updatedAt"] = utc_now()
        path = directory / "song.json"
        temporary = directory / f".song-{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def read(self, song_id: str) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._load_unlocked(song_id))

    def register_upload(
        self,
        song_id: str,
        filename: str,
        payload: bytes,
        source_metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        validate_song_id(song_id)
        asset_id = f"src_{uuid.uuid4().hex}"
        clean_filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
        if not clean_filename:
            raise APIError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "audio_format_required",
                "Supported audio formats are MP3, WAV, FLAC, M4A and AIFF.",
            )
        suffix, audio_metadata = validate_source_audio(clean_filename, payload)
        source = normalize_source_metadata(source_metadata, audio_metadata)

        song_dir = self._song_dir(song_id)
        upload_dir = song_dir / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        relative_path = PurePosixPath("uploads", f"{asset_id}{suffix}").as_posix()
        destination = song_dir / Path(*PurePosixPath(relative_path).parts)
        temporary = upload_dir / f".{asset_id}.tmp"
        try:
            with temporary.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

        now = utc_now()
        asset = {
            "id": asset_id,
            "kind": "source",
            "filename": clean_filename,
            "contentType": audio_metadata["contentType"],
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "path": relative_path,
            "createdAt": now,
            "audio": audio_metadata,
            "source": source,
        }
        with self._lock:
            record = self._load_unlocked(song_id, required=False)
            if (record.get("processing") or {}).get("state") in ACTIVE_STATES:
                destination.unlink(missing_ok=True)
                raise APIError(HTTPStatus.CONFLICT, "processing_active", "Cannot replace the source while processing is active.")
            previous_mix = (record.get("assets") or {}).get("mix") or {}
            previous_source_sha256 = str(previous_mix.get("sha256") or "").lower()
            source_changed = previous_source_sha256 != asset["sha256"]
            record.setdefault("uploads", []).append(asset)
            record["uploads"] = record["uploads"][-20:]
            record["assets"] = {"mix": asset, "stems": {}}
            record["processing"] = None
            if source_changed:
                had_chord_state = bool(record.get("chords")) or bool(record.get("chordSourceSha256"))
                record["chords"] = []
                if had_chord_state:
                    record["chordRevision"] = int(record.get("chordRevision") or 0) + 1
                    record["chordsUpdatedAt"] = now
                record["chordTimeBase"] = None
                record["chordSourceSha256"] = None
                record["chordProvenance"] = None
                record["aiCandidateChords"] = []
                record["aiCandidateChordCount"] = 0
                record["aiCandidateJobId"] = None
                record["aiCandidateGeneratedAt"] = None
                # Old browser builds could persist a display compensation for
                # a legacy chart. It must never be inherited by a new source.
                record.pop("chordTimingOffsetSeconds", None)
            elif record.get("chords"):
                # Re-uploading byte-identical audio is safe. Attach legacy
                # charts to the verified content hash without changing them.
                record["chordSourceSha256"] = asset["sha256"]
                provenance = record.get("chordProvenance")
                if isinstance(provenance, dict):
                    provenance["sourceAssetId"] = asset["id"]
                    provenance["sourceSha256"] = asset["sha256"]
            record["noteTracks"] = {}
            record["noteTrackRevision"] = 0
            record["noteTracksUpdatedAt"] = None
            self._write_unlocked(song_id, record)
        return copy.deepcopy(asset)

    def start_job(
        self,
        song_id: str,
        source_asset_id: str | None,
        *,
        reference_chords: list[dict[str, Any]] | None = None,
        reference_source_sha256: str | None = None,
        fresh_analysis: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            record = self._load_unlocked(song_id)
            current = record.get("processing") or {}
            if current.get("state") in ACTIVE_STATES:
                raise APIError(
                    HTTPStatus.CONFLICT,
                    "processing_active",
                    "A processing job is already active for this song.",
                    details={"processing": current},
                )

            uploads = record.get("uploads") or []
            if source_asset_id is None:
                source = uploads[-1] if uploads else None
            else:
                if not ASSET_ID_RE.fullmatch(source_asset_id):
                    raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_asset_id", "sourceAssetId is invalid.")
                source = next((item for item in uploads if item.get("id") == source_asset_id), None)
            if source is None:
                raise APIError(HTTPStatus.NOT_FOUND, "source_asset_not_found", "Uploaded source asset was not found.")
            current_mix = (record.get("assets") or {}).get("mix") or {}
            if current_mix.get("id") != source.get("id"):
                raise APIError(
                    HTTPStatus.CONFLICT,
                    "source_asset_stale",
                    "Only the current uploaded source can be processed.",
                )

            source_sha256 = str(source.get("sha256") or "").lower()
            if not SHA256_RE.fullmatch(source_sha256):
                raise ProcessingError("The uploaded source is missing its content hash.")
            if reference_chords is not None:
                supplied_reference_sha256 = str(reference_source_sha256 or "").lower()
                if supplied_reference_sha256 != source_sha256:
                    raise APIError(
                        HTTPStatus.CONFLICT,
                        "reference_source_mismatch",
                        "Reference chords do not belong to the current uploaded source.",
                    )
                selected_reference_chords = copy.deepcopy(reference_chords)
            elif (
                not fresh_analysis
                and record.get("chords")
                and str(record.get("chordSourceSha256") or "").lower() == source_sha256
                and record.get("chordTimeBase") in {None, "mix-seconds"}
                and (record.get("chordProvenance") or {}).get("origin") == "manual-edit"
            ):
                selected_reference_chords = normalize_chords(record["chords"])
            else:
                selected_reference_chords = []

            now = utc_now()
            job_id = f"job_{uuid.uuid4().hex}"
            processing = {
                "state": "queued",
                "stage": "source",
                "message": "Waiting for the local audio worker.",
                "updatedAt": now,
                **build_progress_metadata("queued", "source", 0.0),
            }
            job = {
                "id": job_id,
                "sourceAssetId": source["id"],
                "sourceSha256": source_sha256,
                "chordRevisionAtStart": int(record.get("chordRevision") or 0),
                "referenceChords": selected_reference_chords,
                "freshAnalysis": bool(fresh_analysis),
                "state": "queued",
                "stage": "source",
                "message": processing["message"],
                "createdAt": now,
                "updatedAt": now,
                "finishedAt": None,
                "error": None,
                **build_progress_metadata("queued", "source", 0.0),
            }
            record["processing"] = processing
            record["currentJobId"] = job_id
            record.setdefault("jobs", []).append(job)
            record["jobs"] = record["jobs"][-20:]
            # Retrying the same source is transactional: keep the last usable
            # stems and note tracks online until the new worker result is ready.
            # A genuinely new upload already invalidates stale assets in
            # add_upload(), so preserving them here cannot cross source hashes.
            self._write_unlocked(song_id, record)
            return copy.deepcopy(job)

    def update_job(
        self,
        song_id: str,
        job_id: str,
        state: str,
        stage: str,
        message: str,
        *,
        error: dict[str, str] | None = None,
        percent: float | None = None,
        stage_detail: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self._lock:
            record = self._load_unlocked(song_id)
            if record.get("currentJobId") != job_id:
                raise RuntimeError(f"Job {job_id} is no longer current for {song_id}.")
            job = next((item for item in record.get("jobs", []) if item.get("id") == job_id), None)
            if job is None:
                raise RuntimeError(f"Job {job_id} is missing for {song_id}.")
            previous_percent = (record.get("processing") or {}).get("percent")
            progress_metadata = build_progress_metadata(
                state,
                stage,
                percent,
                current_percent=float(previous_percent) if isinstance(previous_percent, (int, float)) else None,
                stage_detail=stage_detail,
            )
            job.update({
                "state": state,
                "stage": stage,
                "message": message,
                "updatedAt": now,
                "error": error,
                **progress_metadata,
            })
            if state in {"ready", "failed"}:
                job["finishedAt"] = now
            processing = {
                "state": state,
                "stage": stage,
                "message": message,
                "updatedAt": now,
                **progress_metadata,
            }
            if error:
                processing["error"] = error
            record["processing"] = processing
            self._write_unlocked(song_id, record)
            return copy.deepcopy(processing)

    def complete_job(
        self,
        song_id: str,
        job_id: str,
        result: ProcessingResult,
    ) -> dict[str, Any]:
        supplied = set(result.stems)
        unknown = supplied.difference(STEM_NAMES)
        if unknown:
            raise ProcessingError(f"Worker returned unsupported stems: {', '.join(sorted(unknown))}.")
        if not supplied:
            raise ProcessingError("Worker returned no usable stems.")

        self.update_job(song_id, job_id, "analyzing", "persisting", "Publishing lossless stems and analysis results.", percent=96.0)

        stem_dir = self._song_dir(song_id) / "assets" / "stems"
        stem_dir.mkdir(parents=True, exist_ok=True)
        persisted: dict[str, dict[str, Any]] = {}
        for stem in STEM_NAMES:
            source = result.stems.get(stem)
            if source is None:
                continue
            source = Path(source)
            if not source.is_file() or source.stat().st_size <= 0:
                raise ProcessingError(f"Worker output is missing or empty for stem '{stem}'.")
            suffix = source.suffix.lower()
            output_format = SOURCE_FORMATS.get(suffix)
            if suffix not in STEM_OUTPUT_SUFFIXES or output_format is None:
                raise ProcessingError(
                    f"Worker output for stem '{stem}' must be WAV or MP3, not '{suffix or 'no extension'}'."
                )
            filename = f"{job_id}-{stem}{suffix}"
            destination = stem_dir / filename
            temporary = stem_dir / f".{filename}.{uuid.uuid4().hex}.tmp"
            try:
                shutil.copyfile(source, temporary)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            payload_hash = hashlib.sha256()
            with destination.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    payload_hash.update(block)
            persisted[stem] = {
                "id": f"stem_{job_id[4:]}_{stem}",
                "kind": "stem",
                "name": stem,
                "filename": filename,
                "contentType": output_format["contentType"],
                "size": destination.stat().st_size,
                "sha256": payload_hash.hexdigest(),
                "path": PurePosixPath("assets", "stems", filename).as_posix(),
                "createdAt": utc_now(),
            }

        with self._lock:
            record = self._load_unlocked(song_id)
            if record.get("currentJobId") != job_id:
                raise RuntimeError(f"Job {job_id} is no longer current for {song_id}.")
            job = next((item for item in record.get("jobs", []) if item.get("id") == job_id), None)
            if job is None:
                raise RuntimeError(f"Job {job_id} is missing for {song_id}.")
            current_mix = (record.get("assets") or {}).get("mix") or {}
            source_sha256 = str(job.get("sourceSha256") or "").lower()
            if (
                current_mix.get("id") != job.get("sourceAssetId")
                or str(current_mix.get("sha256") or "").lower() != source_sha256
            ):
                raise ProcessingError("The processed source is no longer the current uploaded mix.")
            record.setdefault("assets", {})["stems"] = persisted
            if result.chords is not None:
                started_revision = int(job.get("chordRevisionAtStart") or 0)
                current_revision = int(record.get("chordRevision") or 0)
                normalized_result_chords = normalize_chords(result.chords)
                generated_at = utc_now()
                job["aiCandidateChords"] = copy.deepcopy(normalized_result_chords)
                job["aiCandidateChordCount"] = len(normalized_result_chords)
                record["aiCandidateChords"] = copy.deepcopy(normalized_result_chords)
                record["aiCandidateChordCount"] = len(normalized_result_chords)
                record["aiCandidateJobId"] = job_id
                record["aiCandidateGeneratedAt"] = generated_at
                if not normalized_result_chords:
                    job["chordResult"] = "no-reliable-result"
                elif (
                    current_revision == started_revision
                    or (record.get("chordProvenance") or {}).get("origin") == "browser-analysis"
                ):
                    replaced_browser_fallback = current_revision != started_revision
                    updated_at = generated_at
                    record["chords"] = normalized_result_chords
                    record["chordRevision"] = current_revision + 1
                    record["chordsUpdatedAt"] = updated_at
                    record["chordTimeBase"] = "mix-seconds"
                    record["chordSourceSha256"] = source_sha256
                    record["chordProvenance"] = {
                        "origin": "ai-analysis",
                        "algorithm": "fgr-chord-pipeline-v2-multires-boundary",
                        "jobId": job_id,
                        "sourceAssetId": job.get("sourceAssetId"),
                        "sourceSha256": source_sha256,
                        "generatedAt": updated_at,
                        "referenceRevision": started_revision if job.get("referenceChords") else None,
                    }
                    record["chordProvenance"] = {
                        key: value for key, value in record["chordProvenance"].items() if value is not None
                    }
                    # Worker timestamps are already expressed against the
                    # original mix. Never apply an old UI compensation twice.
                    record.pop("chordTimingOffsetSeconds", None)
                    job["chordResult"] = "replaced-browser-analysis" if replaced_browser_fallback else "applied"
                else:
                    # A PATCH during processing is a human decision made after
                    # this analysis started. Preserve it instead of letting a
                    # late worker silently roll the chart back.
                    job["chordResult"] = "preserved-newer-revision"
                    job["preservedChordRevision"] = current_revision
            if result.note_tracks is not None:
                record["noteTracks"] = normalize_note_tracks(result.note_tracks)
                record["noteTrackRevision"] = int(record.get("noteTrackRevision") or 0) + 1
                record["noteTracksUpdatedAt"] = utc_now()
            if result.beat_grid is not None:
                normalized_grid = normalize_beat_grid(result.beat_grid)
                if normalized_grid is not None:
                    record["beatGrid"] = normalized_grid
                    record["beatGridRevision"] = int(record.get("beatGridRevision") or 0) + 1
                    record["beatGridUpdatedAt"] = utc_now()
            self._write_unlocked(song_id, record)

        return self.update_job(song_id, job_id, "ready", "complete", "AI stems and aligned practice-note tracks are ready.")

    def source_path(self, song_id: str, asset_id: str) -> Path:
        with self._lock:
            record = self._load_unlocked(song_id)
            source = next((item for item in record.get("uploads", []) if item.get("id") == asset_id), None)
            if source is None:
                raise ProcessingError("The source upload no longer exists.")
            return self.resolve_relative(song_id, source["path"])

    def job_workspace(self, song_id: str, job_id: str) -> Path:
        path = self._song_dir(song_id) / "jobs" / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def resolve_relative(self, song_id: str, value: str) -> Path:
        relative = PurePosixPath(value)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("Persisted asset path is unsafe.")
        root = self._song_dir(song_id).resolve()
        candidate = (root / Path(*relative.parts)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise RuntimeError("Persisted asset path escapes its song directory.") from exc
        return candidate

    def asset(self, song_id: str, stem: str | None = None) -> tuple[dict[str, Any], Path]:
        with self._lock:
            record = self._load_unlocked(song_id)
            assets = record.get("assets") or {}
            if stem is None:
                metadata = assets.get("mix")
            else:
                metadata = (assets.get("stems") or {}).get(stem)
            if not metadata:
                raise APIError(HTTPStatus.NOT_FOUND, "asset_not_found", "Requested audio asset is not available.")
            path = self.resolve_relative(song_id, metadata["path"])
            if not path.is_file():
                raise APIError(HTTPStatus.NOT_FOUND, "asset_not_found", "Requested audio asset is missing.")
            return copy.deepcopy(metadata), path

    def save_chords(
        self,
        song_id: str,
        chords: list[dict[str, Any]],
        *,
        expected_revision: int | None = None,
        origin: str = "manual-edit",
    ) -> dict[str, Any]:
        if origin not in {"manual-edit", "browser-analysis"}:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_chord_origin", "Chord origin is invalid.")
        with self._lock:
            record = self._load_unlocked(song_id)
            if origin == "browser-analysis":
                processing = record.get("processing") or {}
                if processing.get("state") in ACTIVE_STATES:
                    raise APIError(
                        HTTPStatus.CONFLICT,
                        "server_analysis_active",
                        "Browser fallback is disabled while the server analysis is active.",
                        details={"processing": processing},
                    )
                if (record.get("chordProvenance") or {}).get("origin") == "ai-analysis":
                    raise APIError(
                        HTTPStatus.CONFLICT,
                        "server_analysis_preferred",
                        "A completed server chord analysis already exists for this source.",
                    )
            current_revision = int(record.get("chordRevision") or 0)
            if expected_revision is not None and expected_revision != current_revision:
                raise APIError(
                    HTTPStatus.CONFLICT,
                    "chord_revision_conflict",
                    "The chord chart changed before this edit was saved.",
                    details={
                        "expectedRevision": expected_revision,
                        "currentRevision": current_revision,
                    },
                )
            current_mix = (record.get("assets") or {}).get("mix") or {}
            source_sha256 = str(current_mix.get("sha256") or "").lower()
            updated_at = utc_now()
            record["chords"] = chords
            record["chordRevision"] = current_revision + 1
            record["chordsUpdatedAt"] = updated_at
            record["chordTimeBase"] = "mix-seconds"
            record["chordSourceSha256"] = source_sha256 if SHA256_RE.fullmatch(source_sha256) else None
            record["chordProvenance"] = {
                "origin": origin,
                "sourceAssetId": current_mix.get("id"),
                "sourceSha256": record["chordSourceSha256"],
                "updatedAt": updated_at,
            }
            record["chordProvenance"] = {
                key: value for key, value in record["chordProvenance"].items() if value is not None
            }
            record.pop("chordTimingOffsetSeconds", None)
            self._write_unlocked(song_id, record)
            return {
                "songId": song_id,
                "chords": copy.deepcopy(chords),
                "revision": record["chordRevision"],
                "updatedAt": record["chordsUpdatedAt"],
                "timeBase": record["chordTimeBase"],
                "sourceSha256": record["chordSourceSha256"],
                "provenance": copy.deepcopy(record["chordProvenance"]),
            }

    def recover_interrupted_jobs(self) -> None:
        with self._lock:
            for path in self.songs_root.glob("*/song.json"):
                song_id = path.parent.name
                if not SONG_ID_RE.fullmatch(song_id):
                    continue
                try:
                    record = self._load_unlocked(song_id)
                    current = record.get("processing") or {}
                    if current.get("state") not in ACTIVE_STATES:
                        continue
                    now = utc_now()
                    error = {"code": "service_restarted", "message": "The local processing service restarted before this job finished."}
                    record["processing"] = {
                        "state": "failed",
                        "stage": current.get("stage") or "worker",
                        "message": error["message"],
                        "updatedAt": now,
                        "error": error,
                    }
                    current_job_id = record.get("currentJobId")
                    for job in record.get("jobs", []):
                        if job.get("id") == current_job_id:
                            job.update({"state": "failed", "message": error["message"], "updatedAt": now, "finishedAt": now, "error": error})
                            break
                    self._write_unlocked(song_id, record)
                except Exception:
                    LOGGER.exception("Could not recover persisted job state from %s", path)


class ExistingStemProcessor:
    """Adapter that safely runs the repository's existing worker script."""

    def __init__(self, script_path: Path | str, *, timeout_seconds: int = 6 * 60 * 60) -> None:
        self.script_path = Path(script_path).resolve()
        self.timeout_seconds = timeout_seconds

    def dependency_status(self) -> dict[str, Any]:
        try:
            demucs_available = importlib.util.find_spec("demucs") is not None
        except (ImportError, ValueError):
            demucs_available = False
        demucs_version = ""
        if demucs_available:
            try:
                demucs_version = importlib.metadata.version("demucs")
            except importlib.metadata.PackageNotFoundError:
                pass
        ffmpeg_path = shutil.which("ffmpeg")
        try:
            basic_pitch_available = importlib.util.find_spec("basic_pitch") is not None
        except (ImportError, ValueError):
            basic_pitch_available = False
        basic_pitch_version = ""
        if basic_pitch_available:
            try:
                basic_pitch_version = importlib.metadata.version("basic-pitch")
            except importlib.metadata.PackageNotFoundError:
                pass
        optional_modules: dict[str, tuple[str, str]] = {
            "librosa": ("librosa", "pYIN/Viterbi primary monophonic transcription."),
            "numpy": ("numpy", "Audio analysis and deterministic pitch fallback."),
        }
        module_status: dict[str, dict[str, Any]] = {}
        for name, (distribution, purpose) in optional_modules.items():
            try:
                available = importlib.util.find_spec(name) is not None
            except (ImportError, ValueError):
                available = False
            version = ""
            if available:
                try:
                    version = importlib.metadata.version(distribution)
                except importlib.metadata.PackageNotFoundError:
                    pass
            module_status[name] = {
                "available": available,
                "version": version or None,
                "required": True,
                "purpose": purpose,
            }
        requirements = self.script_path.parent / "requirements-processing.txt"
        install_command = f'"{sys.executable}" -m pip install -r "{requirements}"'
        dependencies = {
            "demucs": {
                "available": demucs_available,
                "version": demucs_version or None,
                "required": True,
                "invocation": [sys.executable, "-m", "demucs"],
                "installCommand": install_command,
            },
            "ffmpeg": {
                "available": bool(ffmpeg_path),
                "required": True,
                "path": ffmpeg_path,
                "installHint": "Install FFmpeg and make ffmpeg available on PATH.",
            },
            "basicPitch": {
                "available": basic_pitch_available,
                "version": basic_pitch_version or None,
                "required": False,
                "purpose": "Secondary note detector when pYIN does not pass the quality gate.",
                "installCommand": install_command,
            },
            **module_status,
        }
        missing = [name for name, item in dependencies.items() if item.get("required") and not item["available"]]
        optional_missing = [name for name, item in dependencies.items() if not item.get("required") and not item["available"]]
        return {
            "ready": not missing and self.script_path.is_file(),
            "workerScript": str(self.script_path),
            "python": sys.executable,
            "dependencies": dependencies,
            "missing": missing,
            "optionalMissing": optional_missing,
        }

    def require_dependencies(self) -> dict[str, Any]:
        status = self.dependency_status()
        missing = status["missing"]
        if not self.script_path.is_file():
            raise ProcessingDependencyError(f"Stem worker script was not found: {self.script_path}")
        if missing:
            actions = []
            if "demucs" in missing:
                actions.append(status["dependencies"]["demucs"]["installCommand"])
            if "ffmpeg" in missing:
                actions.append(status["dependencies"]["ffmpeg"]["installHint"])
            if "librosa" in missing or "numpy" in missing:
                actions.append(status["dependencies"]["demucs"]["installCommand"])
            raise ProcessingDependencyError(
                "Missing processing dependencies: " + ", ".join(missing) + ". " + " ".join(actions)
            )
        return status

    def process(
        self,
        song_id: str,
        source_path: Path,
        workspace: Path,
        progress: Callable[..., None],
        *,
        reference_chords: list[dict[str, Any]] | None = None,
    ) -> ProcessingResult:
        self.require_dependencies()

        progress("separating", "separation", "Separating the uploaded audio into AI practice stems.")
        (workspace / "playlists").mkdir(parents=True, exist_ok=True)
        playlist = {"id": "local-processing", "name": "Local processing", "songs": []}
        (workspace / "playlists" / "feelgood.json").write_text(
            json.dumps(playlist, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        source_suffix = source_path.suffix.lower()
        if source_suffix not in SOURCE_FORMATS:
            raise ProcessingError(f"Unsupported worker source format: {source_suffix or 'none'}")
        worker_source = workspace / f"{song_id}{source_suffix}"
        shutil.copyfile(source_path, worker_source)
        log_path = workspace / "worker.log"
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        process = subprocess.Popen(
            [sys.executable, str(self.script_path)],
            cwd=workspace,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
        )
        output: queue.Queue[str | None] = queue.Queue()

        def read_worker_output() -> None:
            assert process.stdout is not None
            try:
                for line in process.stdout:
                    output.put(line)
            finally:
                output.put(None)

        reader = threading.Thread(target=read_worker_output, name=f"fgr-log-{song_id}", daemon=True)
        reader.start()
        deadline = time.monotonic() + self.timeout_seconds
        timed_out = False
        with log_path.open("w", encoding="utf-8", newline="\n") as log_handle:
            while True:
                if time.monotonic() >= deadline:
                    timed_out = True
                    self._terminate_process_tree(process)
                    break
                try:
                    line = output.get(timeout=0.25)
                except queue.Empty:
                    if process.poll() is not None and not reader.is_alive():
                        break
                    continue
                if line is None:
                    break
                log_handle.write(line)
                log_handle.flush()
                self._consume_worker_progress(line, progress)
        if timed_out:
            reader.join(timeout=2)
            raise ProcessingError(f"Stem processing exceeded the {self.timeout_seconds}-second limit.")
        try:
            return_code = process.wait(timeout=10)
        except subprocess.TimeoutExpired as exc:
            self._terminate_process_tree(process)
            raise ProcessingError("Stem worker did not exit cleanly after closing its output stream.") from exc
        reader.join(timeout=2)
        if return_code != 0:
            tail = self._log_tail(log_path)
            raise ProcessingError(f"Stem worker exited with code {return_code}. {tail}".strip())

        samples_root = workspace / "samples"
        candidates: list[tuple[Path, dict[str, Path]]] = []
        if samples_root.is_dir():
            for directory in sorted((item for item in samples_root.iterdir() if item.is_dir()), key=lambda item: item.name):
                discovered: dict[str, Path] = {}
                for stem in STEM_NAMES:
                    # Prefer the lossless worker output, while accepting MP3
                    # from older/custom processors and deterministic tests.
                    path = next(
                        (
                            directory / f"{stem}{suffix}"
                            for suffix in STEM_OUTPUT_SUFFIXES
                            if (directory / f"{stem}{suffix}").is_file()
                        ),
                        None,
                    )
                    if path is not None:
                        discovered[stem] = path
                if discovered:
                    candidates.append((directory, discovered))
        if not candidates:
            tail = self._log_tail(log_path)
            raise ProcessingError(f"Stem worker completed without usable output. {tail}".strip())
        _output_dir, stems = max(candidates, key=lambda item: len(item[1]))
        missing_stems = [stem for stem in STEM_NAMES if stem not in stems]
        if missing_stems:
            tail = self._log_tail(log_path)
            raise ProcessingError(
                f"Stem worker did not produce the expected channels: {', '.join(missing_stems)}. {tail}".strip()
            )
        beat_grid: dict[str, Any] | None = None
        try:
            beat_grid = detect_beat_grid(stems, progress)
        except Exception as exc:
            # A missing grid degrades quantisation and bar-aware practice, but
            # the stems and every existing analysis stay valid without it.
            LOGGER.warning("Beat-grid detection failed for %s: %s", song_id, exc, exc_info=True)
        chords: list[dict[str, Any]] | None = None
        try:
            chords = extract_chord_chart(
                stems, progress, reference_chords=reference_chords, beat_grid=beat_grid
            )
        except Exception as exc:
            # Chord extraction is an analysis enhancement, not a reason to
            # discard six otherwise valid separated stems. The browser keeps a
            # slower fallback for this uncommon dependency/data failure.
            LOGGER.warning("Chord analysis failed for %s: %s", song_id, exc, exc_info=True)
        note_tracks = extract_practice_note_tracks(stems, progress)
        return ProcessingResult(stems=stems, chords=chords, note_tracks=note_tracks, beat_grid=beat_grid)

    @staticmethod
    def _consume_worker_progress(line: str, progress: Callable[..., None]) -> None:
        marker = line.find(WORKER_PROGRESS_PREFIX)
        if marker < 0:
            return
        try:
            payload = json.loads(line[marker + len(WORKER_PROGRESS_PREFIX):].strip())
            if not isinstance(payload, Mapping):
                return
            percent = float(payload.get("percent"))
            if not math.isfinite(percent):
                return
            stage_detail = payload.get("stageDetail")
            progress(
                str(payload.get("state") or "separating"),
                str(payload.get("stage") or "separation"),
                str(payload.get("message") or "Separating AI practice stems."),
                percent=max(5.0, min(71.5, percent)),
                stage_detail=stage_detail if isinstance(stage_detail, Mapping) else None,
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            LOGGER.debug("Ignoring malformed worker progress line: %r", line[:500])

    @staticmethod
    def _terminate_process_tree(process: subprocess.Popen[Any]) -> None:
        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                    shell=False,
                )
            else:
                process.terminate()
                process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            try:
                process.kill()
            except OSError:
                pass

    @staticmethod
    def _log_tail(path: Path, limit: int = 4000) -> str:
        try:
            payload = path.read_bytes()[-limit:]
            return payload.decode("utf-8", errors="replace").strip()
        except OSError:
            return ""


class ProcessingApplication:
    def __init__(
        self,
        store: SongStore,
        processor: Any,
        *,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
        worker_count: int = 1,
    ) -> None:
        if max_upload_bytes < 1:
            raise ValueError("max_upload_bytes must be positive")
        if worker_count < 1:
            raise ValueError("worker_count must be positive")
        self.store = store
        self.processor = processor
        self.max_upload_bytes = max_upload_bytes
        self.executor = ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="fgr-worker")
        self._closed = False

    @staticmethod
    def is_allowed_origin(origin: str) -> bool:
        try:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.path not in {"", "/"}:
                return False
            if parsed.query or parsed.fragment or parsed.username or parsed.password:
                return False
            return (parsed.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}
        except ValueError:
            return False

    def health(self) -> dict[str, Any]:
        checker = getattr(self.processor, "dependency_status", None)
        if callable(checker):
            worker = checker()
        else:
            worker = {"ready": True, "dependencies": {}, "missing": []}
        return {
            "service": "fgr-processing",
            "ready": bool(worker.get("ready")),
            "worker": worker,
            "acceptedSourceFormats": ["mp3", "wav", "flac", "m4a", "aif", "aiff"],
            "sourceMaxBytes": self.max_upload_bytes,
        }

    def queue_processing(
        self,
        song_id: str,
        source_asset_id: str | None,
        *,
        reference_chords: list[dict[str, Any]] | None = None,
        reference_source_sha256: str | None = None,
        fresh_analysis: bool = False,
    ) -> dict[str, Any]:
        job = self.store.start_job(
            song_id,
            source_asset_id,
            reference_chords=reference_chords,
            reference_source_sha256=reference_source_sha256,
            fresh_analysis=fresh_analysis,
        )
        try:
            self.executor.submit(
                self._run_job,
                song_id,
                job["id"],
                job["sourceAssetId"],
                copy.deepcopy(job.get("referenceChords") or []),
            )
        except Exception as exc:
            error = {"code": "queue_unavailable", "message": str(exc)}
            self.store.update_job(song_id, job["id"], "failed", "worker", error["message"], error=error)
            raise APIError(HTTPStatus.SERVICE_UNAVAILABLE, "queue_unavailable", "The local processing queue is unavailable.") from exc
        return job

    def _run_job(
        self,
        song_id: str,
        job_id: str,
        source_asset_id: str,
        reference_chords: list[dict[str, Any]],
    ) -> None:
        workspace = self.store.job_workspace(song_id, job_id)

        def progress(
            state: str,
            stage: str,
            message: str,
            *,
            percent: float | None = None,
            stage_detail: Mapping[str, Any] | None = None,
        ) -> None:
            self.store.update_job(
                song_id,
                job_id,
                state,
                stage,
                message,
                percent=percent,
                stage_detail=stage_detail,
            )

        try:
            source_path = self.store.source_path(song_id, source_asset_id)
            progress("separating", "separation", "Starting the local audio worker.")
            result = self.processor.process(
                song_id,
                source_path,
                workspace,
                progress,
                reference_chords=reference_chords or None,
            )
            if isinstance(result, Mapping):
                result = ProcessingResult(stems=result)
            if not isinstance(result, ProcessingResult):
                raise ProcessingError("Audio worker returned an invalid result.")
            self.store.complete_job(song_id, job_id, result)
        except Exception as exc:
            if isinstance(exc, ProcessingDependencyError):
                LOGGER.warning("Processing job %s cannot start: %s", job_id, exc)
            else:
                LOGGER.exception("Processing job %s failed", job_id)
            code = getattr(exc, "code", "processing_failed")
            message = str(exc).strip() or "Audio processing failed."
            message = message[:4000]
            error = {"code": str(code), "message": message}
            try:
                self.store.update_job(song_id, job_id, "failed", "worker", message, error=error)
            except Exception:
                LOGGER.exception("Could not persist failure for job %s", job_id)
        finally:
            self._cleanup_job_workspace(workspace)

    @staticmethod
    def _cleanup_job_workspace(workspace: Path) -> None:
        """Drop copied audio/stems while retaining the small diagnostic log."""
        if not workspace.is_dir():
            return
        for child in workspace.iterdir():
            if child.name == "worker.log":
                continue
            last_error: OSError | None = None
            for attempt in range(6):
                try:
                    if child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child, onerror=ProcessingApplication._make_writable)
                    else:
                        child.unlink(missing_ok=True)
                    last_error = None
                    break
                except OSError as exc:
                    last_error = exc
                    time.sleep(0.1 * (attempt + 1))
            if last_error is not None:
                LOGGER.warning("Could not clean worker path %s: %s", child, last_error)

    @staticmethod
    def _make_writable(_function: Callable[..., Any], path: str, _exc_info: Any) -> None:
        try:
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass

    def close(self, *, wait: bool = True) -> None:
        if not self._closed:
            self._closed = True
            self.executor.shutdown(wait=wait, cancel_futures=False)


def _public_asset(song_id: str, metadata: dict[str, Any], url: str) -> dict[str, Any]:
    fields = ("id", "kind", "name", "filename", "contentType", "size", "sha256", "createdAt", "audio", "source")
    result = {field: metadata[field] for field in fields if field in metadata}
    result["url"] = url
    return result


def public_assets(record: dict[str, Any]) -> dict[str, Any]:
    song_id = record["songId"]
    assets = record.get("assets") or {}
    mix = assets.get("mix")
    stem_map = assets.get("stems") or {}
    stems = {
        name: _public_asset(song_id, metadata, f"/v1/songs/{song_id}/assets/stems/{name}")
        for name, metadata in stem_map.items()
        if name in STEM_NAMES
    }
    return {
        "songId": song_id,
        "mix": _public_asset(song_id, mix, f"/v1/songs/{song_id}/assets/mix") if mix else None,
        "stems": stems,
        "availableStems": [name for name in STEM_NAMES if name in stems],
        "chords": record.get("chords") or [],
        "chordRevision": int(record.get("chordRevision") or 0),
        "chordsUpdatedAt": record.get("chordsUpdatedAt"),
        "chordTimeBase": record.get("chordTimeBase"),
        "chordTimingOffsetSeconds": 0.0,
        "chordSourceSha256": record.get("chordSourceSha256"),
        "chordProvenance": copy.deepcopy(record.get("chordProvenance")),
        "aiCandidateChords": copy.deepcopy(record.get("aiCandidateChords") or []),
        "aiCandidateChordCount": int(record.get("aiCandidateChordCount") or 0),
        "aiCandidateJobId": record.get("aiCandidateJobId"),
        "aiCandidateGeneratedAt": record.get("aiCandidateGeneratedAt"),
        "noteTracks": record.get("noteTracks") or {},
        "noteTrackRevision": int(record.get("noteTrackRevision") or 0),
        "noteTracksUpdatedAt": record.get("noteTracksUpdatedAt"),
        "beatGrid": copy.deepcopy(record.get("beatGrid")) or None,
        "beatGridRevision": int(record.get("beatGridRevision") or 0),
        "beatGridUpdatedAt": record.get("beatGridUpdatedAt"),
        "processing": record.get("processing"),
    }


def parse_multipart_upload(
    content_type: str,
    body: bytes,
    max_upload_bytes: int,
) -> tuple[str, bytes, dict[str, Any] | None]:
    if len(content_type) > 512 or "\r" in content_type or "\n" in content_type:
        raise APIError(HTTPStatus.BAD_REQUEST, "invalid_content_type", "Invalid Content-Type header.")
    try:
        header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
    except UnicodeEncodeError as exc:
        raise APIError(HTTPStatus.BAD_REQUEST, "invalid_content_type", "Invalid Content-Type header.") from exc
    message = BytesParser(policy=policy.default).parsebytes(header + body)
    if not message.is_multipart():
        raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "multipart_required", "Use multipart/form-data with a file field.")

    candidates: list[tuple[str, bytes]] = []
    metadata_values: list[bytes] = []
    for part in message.iter_parts():
        field_name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        if field_name in {"sourceMetadata", "source_metadata"} and not filename:
            raw_metadata = part.get_payload(decode=True)
            if raw_metadata is None:
                raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_metadata", "Could not decode sourceMetadata.")
            metadata_values.append(raw_metadata)
            continue
        if field_name not in {"file", "audio"} or not filename:
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_upload", "Could not decode the uploaded file.")
        candidates.append((filename, payload))
    if len(candidates) != 1:
        raise APIError(HTTPStatus.BAD_REQUEST, "file_required", "Provide exactly one supported audio file in the file field.")
    filename, payload = candidates[0]
    if len(payload) > max_upload_bytes:
        raise APIError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "upload_too_large", "Uploaded audio exceeds the configured size limit.")
    if not payload:
        raise APIError(HTTPStatus.BAD_REQUEST, "empty_upload", "Uploaded audio is empty.")
    clean_filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    validate_source_audio(clean_filename, payload)

    if len(metadata_values) > 1:
        raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_metadata", "Provide sourceMetadata at most once.")
    source_metadata = None
    if metadata_values:
        raw_metadata = metadata_values[0]
        if len(raw_metadata) > MAX_SOURCE_METADATA_BYTES:
            raise APIError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "source_metadata_too_large", "sourceMetadata is too large.")
        try:
            source_metadata = json.loads(raw_metadata.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_metadata", "sourceMetadata is not valid JSON.") from exc
        if not isinstance(source_metadata, dict):
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_metadata", "sourceMetadata must be a JSON object.")
    return clean_filename, payload, source_metadata


def looks_like_mp3(payload: bytes) -> bool:
    if payload.startswith(b"ID3"):
        return True
    sample = payload[:4096]
    return any(sample[index] == 0xFF and sample[index + 1] & 0xE0 == 0xE0 for index in range(max(0, len(sample) - 1)))


class FGRRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FGRProcessing/1.0"

    @property
    def app(self) -> ProcessingApplication:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), format % args)

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            # Browsers and curl may close an HTTP/1.1 keep-alive socket after
            # the response. That is not an application error.
            return

    def do_OPTIONS(self) -> None:
        self._dispatch(self._options)

    def do_POST(self) -> None:
        self._dispatch(self._post)

    def do_GET(self) -> None:
        self._dispatch(self._get)

    def do_HEAD(self) -> None:
        self._dispatch(lambda: self._get(head_only=True))

    def do_PATCH(self) -> None:
        self._dispatch(self._patch)

    def _dispatch(self, action: Callable[[], None]) -> None:
        try:
            origin = self.headers.get("Origin")
            if origin and not self.app.is_allowed_origin(origin):
                raise APIError(HTTPStatus.FORBIDDEN, "origin_not_allowed", "Only localhost browser origins are allowed.")
            action()
        except APIError as exc:
            payload: dict[str, Any] = {"error": {"code": exc.code, "message": exc.message}}
            if exc.details is not None:
                payload["error"]["details"] = exc.details
            self._send_json(exc.status, payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            LOGGER.exception("Unhandled API error")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": {"code": "internal_error", "message": "The local processing service encountered an error."}},
            )

    def _segments(self) -> list[str]:
        parsed = urlsplit(self.path)
        return [unquote(segment) for segment in parsed.path.split("/") if segment]

    def _route_song(self) -> tuple[list[str], str]:
        segments = self._segments()
        if len(segments) < 4 or segments[:2] != ["v1", "songs"]:
            raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")
        return segments, validate_song_id(segments[2])

    def do_DELETE(self) -> None:
        self._dispatch(self._delete)

    def _delete(self) -> None:
        segments = self._segments()
        if len(segments) == 3 and segments[:2] == ["v1", "playlists"]:
            removed = self.app.store.delete_playlist(segments[2])
            self._send_json(HTTPStatus.OK, {"slug": segments[2], "removed": removed})
            return
        if len(segments) != 3 or segments[:2] != ["v1", "songs"]:
            raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")
        song_id = validate_song_id(segments[2])
        removed = self.app.store.delete_song(song_id)
        self._send_json(HTTPStatus.OK, {"songId": song_id, "removed": removed})

    def _options(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Range")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _post_diagnostics(self) -> None:
        payload = self._read_json(allow_empty=True)
        record = {"receivedAt": utc_now(), "report": payload}
        path = self.app.store.root / "diagnostics.log"
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass
        self._send_json(HTTPStatus.OK, {"received": True})

    def do_PUT(self) -> None:
        self._dispatch(self._put)

    def _put(self) -> None:
        segments = self._segments()
        if len(segments) == 3 and segments[:2] == ["v1", "playlists"]:
            payload = self._read_json()
            self._send_json(HTTPStatus.OK, self.app.store.write_playlist(segments[2], payload))
            return
        raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")

    def _post(self) -> None:
        if self._segments() == ["v1", "diagnostics"]:
            self._post_diagnostics()
            return
        segments, song_id = self._route_song()
        if len(segments) != 4:
            raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")
        endpoint = segments[3]
        if endpoint == "uploads":
            content_type = self.headers.get("Content-Type", "")
            if not content_type.lower().startswith("multipart/form-data"):
                raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "multipart_required", "Use multipart/form-data with a file field.")
            body = self._read_body(self.app.max_upload_bytes + MULTIPART_OVERHEAD_BYTES)
            filename, payload, source_metadata = parse_multipart_upload(content_type, body, self.app.max_upload_bytes)
            asset = self.app.store.register_upload(song_id, filename, payload, source_metadata)
            public = _public_asset(song_id, asset, f"/v1/songs/{song_id}/assets/mix")
            self._send_json(
                HTTPStatus.CREATED,
                {"songId": song_id, "sourceAssetId": asset["id"], "asset": public},
                headers={"Location": f"/v1/songs/{song_id}/assets/mix"},
            )
            return
        if endpoint == "process":
            request = self._read_json(allow_empty=True)
            if not isinstance(request, dict):
                raise APIError(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be a JSON object.")
            if "sourceUrl" in request:
                raise APIError(
                    HTTPStatus.BAD_REQUEST,
                    "remote_sources_disabled",
                    "Remote source references are disabled in the local service; upload a supported audio file first.",
                )
            source_asset_id = request.get("sourceAssetId")
            if source_asset_id is not None and not isinstance(source_asset_id, str):
                raise APIError(HTTPStatus.BAD_REQUEST, "invalid_source_asset_id", "sourceAssetId must be a string.")
            reference_chords = None
            if "referenceChords" in request:
                reference_chords = normalize_chords(request.get("referenceChords"))
            reference_source_sha256 = request.get("referenceSourceSha256")
            if reference_source_sha256 is not None:
                if not isinstance(reference_source_sha256, str) or not SHA256_RE.fullmatch(reference_source_sha256.lower()):
                    raise APIError(
                        HTTPStatus.BAD_REQUEST,
                        "invalid_reference_source_sha256",
                        "referenceSourceSha256 must be a SHA-256 hex digest.",
                    )
                reference_source_sha256 = reference_source_sha256.lower()
            if reference_chords is not None and reference_source_sha256 is None:
                raise APIError(
                    HTTPStatus.BAD_REQUEST,
                    "reference_source_sha256_required",
                    "referenceSourceSha256 is required when referenceChords are provided.",
                )
            fresh_analysis = request.get("freshAnalysis", False)
            if not isinstance(fresh_analysis, bool):
                raise APIError(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_fresh_analysis",
                    "freshAnalysis must be a boolean.",
                )
            if fresh_analysis and reference_chords is not None:
                raise APIError(
                    HTTPStatus.BAD_REQUEST,
                    "conflicting_chord_analysis_mode",
                    "freshAnalysis cannot be combined with referenceChords.",
                )
            job = self.app.queue_processing(
                song_id,
                source_asset_id,
                reference_chords=reference_chords,
                reference_source_sha256=reference_source_sha256,
                fresh_analysis=fresh_analysis,
            )
            record = self.app.store.read(song_id)
            self._send_json(
                HTTPStatus.ACCEPTED,
                {"songId": song_id, "jobId": job["id"], "processing": record["processing"]},
                headers={"Location": f"/v1/songs/{song_id}/process"},
            )
            return
        raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")

    def _get(self, *, head_only: bool = False) -> None:
        segments = self._segments()
        if segments == ["v1", "health"]:
            health = self.app.health()
            self._send_json(
                HTTPStatus.OK if health["ready"] else HTTPStatus.SERVICE_UNAVAILABLE,
                health,
                head_only=head_only,
            )
            return
        if segments == ["v1", "songs"]:
            self._send_json(HTTPStatus.OK, {"songs": self.app.store.list_songs()}, head_only=head_only)
            return
        if segments == ["v1", "playlists"]:
            self._send_json(HTTPStatus.OK, {"playlists": self.app.store.list_playlists()}, head_only=head_only)
            return
        if len(segments) == 3 and segments[:2] == ["v1", "playlists"]:
            self._send_json(HTTPStatus.OK, self.app.store.read_playlist(segments[2]), head_only=head_only)
            return
        segments, song_id = self._route_song()
        endpoint = segments[3]
        if endpoint == "process" and len(segments) == 4:
            record = self.app.store.read(song_id)
            current_job_id = record.get("currentJobId")
            job = next((item for item in record.get("jobs", []) if item.get("id") == current_job_id), None)
            payload = {
                "songId": song_id,
                "jobId": current_job_id,
                "processing": record.get("processing"),
                "error": (job or {}).get("error"),
                "analysis": {
                    "chordResult": (job or {}).get("chordResult"),
                    "candidateChordCount": int((job or {}).get("aiCandidateChordCount") or 0),
                    "candidateChords": copy.deepcopy((job or {}).get("aiCandidateChords") or []),
                    "noteTrackRevision": int(record.get("noteTrackRevision") or 0),
                    "availableStems": [name for name in STEM_NAMES if name in ((record.get("assets") or {}).get("stems") or {})],
                },
            }
            self._send_json(HTTPStatus.OK, payload, head_only=head_only)
            return
        if endpoint == "chord-accuracy" and len(segments) == 4:
            record = self.app.store.read(song_id)
            provenance = (record.get("chordProvenance") or {}).get("origin")
            reference = record.get("chords") or []
            candidate = record.get("aiCandidateChords") or []
            if provenance != "manual-edit":
                # Without a correction there is no reference: comparing the
                # machine against itself would report a perfect score.
                payload = {
                    "songId": song_id,
                    "status": "no-reference",
                    "message": "Ispravi bar jedan akord da bi poređenje imalo smisla.",
                    "referenceCount": len(reference),
                    "candidateCount": len(candidate),
                }
            else:
                payload = {"songId": song_id, **chord_accuracy.compare_charts(reference, candidate)}
                payload["summary"] = chord_accuracy.summarise(payload)
            self._send_json(HTTPStatus.OK, payload, head_only=head_only)
            return
        if endpoint == "assets" and len(segments) == 4:
            self._send_json(HTTPStatus.OK, public_assets(self.app.store.read(song_id)), head_only=head_only)
            return
        if endpoint == "assets" and len(segments) == 5 and segments[4] == "mix":
            metadata, path = self.app.store.asset(song_id)
            content_type = metadata.get("contentType") or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self._send_file(path, content_type, head_only=head_only)
            return
        if endpoint == "assets" and len(segments) == 6 and segments[4] == "stems" and segments[5] in STEM_NAMES:
            metadata, path = self.app.store.asset(song_id, segments[5])
            content_type = metadata.get("contentType") or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self._send_file(path, content_type, head_only=head_only)
            return
        raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")

    def _patch(self) -> None:
        segments, song_id = self._route_song()
        if len(segments) != 4 or segments[3] != "chords":
            raise APIError(HTTPStatus.NOT_FOUND, "not_found", "Endpoint not found.")
        request = self._read_json()
        raw_chords = request.get("chords") if isinstance(request, dict) else request
        raw_expected_revision = (
            request.get("expectedRevision", request.get("expected_revision"))
            if isinstance(request, dict)
            else None
        )
        raw_origin = request.get("origin", "manual-edit") if isinstance(request, dict) else "manual-edit"
        if raw_origin not in {"manual-edit", "browser-analysis"}:
            raise APIError(
                HTTPStatus.BAD_REQUEST,
                "invalid_chord_origin",
                "origin must be manual-edit or browser-analysis.",
            )
        if raw_expected_revision is not None and (
            isinstance(raw_expected_revision, bool)
            or not isinstance(raw_expected_revision, int)
            or raw_expected_revision < 0
        ):
            raise APIError(
                HTTPStatus.BAD_REQUEST,
                "invalid_chord_revision",
                "expectedRevision must be a non-negative integer.",
            )
        result = self.app.store.save_chords(
            song_id,
            normalize_chords(raw_chords),
            expected_revision=raw_expected_revision,
            origin=raw_origin,
        )
        self._send_json(HTTPStatus.OK, result)

    def _read_body(self, limit: int) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise APIError(HTTPStatus.LENGTH_REQUIRED, "content_length_required", "Content-Length is required.")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_content_length", "Content-Length is invalid.") from exc
        if length < 0:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_content_length", "Content-Length is invalid.")
        if length > limit:
            self.close_connection = True
            raise APIError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large", "Request exceeds the configured size limit.")
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            raise APIError(HTTPStatus.BAD_REQUEST, "incomplete_request", "Request body ended early.")
        return body

    def _read_json(self, *, allow_empty: bool = False) -> Any:
        body = self._read_body(MAX_JSON_BYTES)
        if not body and allow_empty:
            return {}
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise APIError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "json_required", "Use application/json.")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise APIError(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body is not valid JSON.") from exc

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self.app.is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Location")

    def _send_json(
        self,
        status: int,
        value: Any,
        *,
        headers: Mapping[str, str] | None = None,
        head_only: bool = False,
    ) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        for name, content in (headers or {}).items():
            self.send_header(name, content)
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def _send_file(self, path: Path, content_type: str, *, head_only: bool = False) -> None:
        size = path.stat().st_size
        start, end = 0, max(0, size - 1)
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")
        if range_header:
            start, end = self._parse_range(range_header, size)
            status = HTTPStatus.PARTIAL_CONTENT
        length = max(0, end - start + 1) if size else 0
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head_only or not length:
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    @staticmethod
    def _parse_range(header: str, size: int) -> tuple[int, int]:
        if size <= 0 or not header.startswith("bytes=") or "," in header:
            raise APIError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "invalid_range", "Requested byte range is invalid.")
        value = header[6:].strip()
        if "-" not in value:
            raise APIError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "invalid_range", "Requested byte range is invalid.")
        first, last = value.split("-", 1)
        try:
            if not first:
                suffix = int(last)
                if suffix <= 0:
                    raise ValueError
                start = max(0, size - suffix)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
                if start < 0 or start >= size or end < start:
                    raise ValueError
                end = min(end, size - 1)
        except ValueError as exc:
            raise APIError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "invalid_range", "Requested byte range is invalid.") from exc
        return start, end


class FGRHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], app: ProcessingApplication) -> None:
        self.app = app
        super().__init__(address, FGRRequestHandler)


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    data_root: Path | str | None = None,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    worker_count: int = 1,
    processor: Any | None = None,
) -> FGRHTTPServer:
    project_root = Path(__file__).resolve().parent
    root = Path(data_root) if data_root is not None else project_root / ".fgr-processing"
    store = SongStore(root)
    worker = processor if processor is not None else ExistingStemProcessor(project_root / "process_stems.py")
    app = ProcessingApplication(store, worker, max_upload_bytes=max_upload_bytes, worker_count=worker_count)
    return FGRHTTPServer((host, port), app)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local FGR audio processing service.")
    parser.add_argument("--host", default=os.environ.get("FGR_PROCESSING_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FGR_PROCESSING_PORT", "8765")))
    parser.add_argument("--data-root", default=os.environ.get("FGR_PROCESSING_DATA"))
    parser.add_argument(
        "--max-upload-mib",
        type=int,
        default=int(os.environ.get("FGR_MAX_UPLOAD_MIB", "512")),
        help="Maximum uploaded audio size (default: 512 MiB).",
    )
    parser.add_argument("--workers", type=int, default=int(os.environ.get("FGR_PROCESSING_WORKERS", "1")))
    parser.add_argument(
        "--check-dependencies",
        action="store_true",
        help="Print worker dependency status as JSON and exit without starting the server.",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.check_dependencies:
        processor = ExistingStemProcessor(Path(__file__).resolve().parent / "process_stems.py")
        status = processor.dependency_status()
        print(json.dumps(status, ensure_ascii=False, indent=2))
        return 0 if status["ready"] else 2
    server = create_server(
        args.host,
        args.port,
        data_root=args.data_root,
        max_upload_bytes=args.max_upload_mib * 1024 * 1024,
        worker_count=args.workers,
    )
    LOGGER.info("FGR processing service listening on http://%s:%s", *server.server_address)
    LOGGER.info("Persisting local audio and state in %s", server.app.store.root)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        LOGGER.info("Stopping FGR processing service")
    finally:
        server.shutdown()
        server.server_close()
        server.app.close(wait=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
