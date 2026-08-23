"""Tempo, beat and downbeat grid detection for separated FGR stems.

The chord layer and the note layer both need one shared musical grid. Without
it every analysis result lives in free time: chord boundaries land wherever the
onset curve happens to peak, transcribed notes cannot be quantised, and the
piano renderer has no bar to phrase against.

This module produces that grid once per song and keeps the decision steps
separated from audio decoding, so the metric reasoning can be covered by
deterministic tests that need no audio files.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


BEAT_GRID_SCHEMA_VERSION = 1

# The percussive channel carries the pulse. When it is missing or effectively
# silent the full mix is used instead, which is noisier but still periodic.
PULSE_STEM_PRIORITY = ("drums",)
HARMONIC_STEM_NAMES = ("piano", "guitar", "other")


@dataclass(frozen=True)
class BeatGridConfig:
    sample_rate: int = 22_050
    hop_length: int = 512
    start_bpm: float = 120.0
    min_bpm: float = 50.0
    max_bpm: float = 210.0
    # 8 and 6 are tested so that a doubled tactus can be recognised: a bar that
    # spans eight detected beats almost always means the beat tracker locked
    # onto eighth notes of a 4/4 bar rather than onto a genuine 8/8 meter.
    meter_candidates: tuple[int, ...] = (4, 3, 8, 6)
    # Razlika u korigovanom z-skoru koju presavijanje mora da nadmaši.
    half_time_margin: float = 0.6
    minimum_beats: int = 12
    minimum_confidence: float = 0.35


def _numpy():
    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - guarded by runtime setup
        raise RuntimeError("NumPy is required for beat-grid detection.") from exc
    return np


def summarize_tempo(beats: Sequence[float], resolution: float = 0.0) -> dict[str, Any]:
    """Describe the pulse of a beat sequence and how steady it is.

    `resolution` is the analysis frame length in seconds. Beat times can only
    land on that lattice, so every grid carries at least one frame of interval
    jitter no matter how metronomic the performance is. Charging that to the
    musician would make a perfectly steady song look unstable.
    """

    np = _numpy()
    times = np.asarray([float(value) for value in beats], dtype=np.float64)
    if times.size < 2:
        return {"bpm": 0.0, "bpmRange": [0.0, 0.0], "stability": 0.0}
    intervals = np.diff(times)
    intervals = intervals[intervals > 1e-6]
    if not intervals.size:
        return {"bpm": 0.0, "bpmRange": [0.0, 0.0], "stability": 0.0}

    median_interval = float(np.median(intervals))
    bpm = 60.0 / median_interval if median_interval > 1e-6 else 0.0
    # A steady grid has a narrow interquartile range around its median. Express
    # that as a 0..1 score instead of raw seconds so it can be mixed into the
    # overall confidence.
    spread = float(np.percentile(intervals, 75) - np.percentile(intervals, 25))
    spread = max(0.0, spread - max(0.0, float(resolution)))
    stability = 1.0 - min(1.0, spread / max(1e-6, median_interval) / 0.12)
    fastest = 60.0 / float(intervals.min()) if intervals.min() > 1e-6 else 0.0
    slowest = 60.0 / float(intervals.max()) if intervals.max() > 1e-6 else 0.0
    return {
        "bpm": round(bpm, 3),
        "bpmRange": [round(min(slowest, fastest), 3), round(max(slowest, fastest), 3)],
        "stability": round(max(0.0, min(1.0, stability)), 4),
    }


def aggregate_by_beat(feature: Any, beat_frames: Sequence[int]) -> Any:
    """Reduce a frame-rate feature to one column per beat interval.

    Beat-synchronous features are the whole point of having a grid: a median
    over the span of a beat removes the frame-level flicker that currently
    drives boundary decisions, without blurring across a real chord change.
    """

    np = _numpy()
    values = np.asarray(feature, dtype=np.float64)
    if values.ndim == 1:
        values = values[None, :]
    frames = [int(index) for index in beat_frames]
    if values.shape[1] == 0 or len(frames) < 2:
        return np.zeros((values.shape[0], 0), dtype=np.float64)

    columns = []
    for index in range(len(frames) - 1):
        start = max(0, min(values.shape[1] - 1, frames[index]))
        end = max(start + 1, min(values.shape[1], frames[index + 1]))
        columns.append(np.median(values[:, start:end], axis=1))
    return np.stack(columns, axis=1)


def _unit_scale(values: Any) -> Any:
    """Scale a non-negative cue around a robust maximum.

    The ceiling is a high percentile rather than the maximum so one crash
    cymbal cannot flatten a whole song, but genuine accents are deliberately
    left above 1.0: clipping them away is exactly what destroys the metric
    contrast this cue exists to measure.
    """

    np = _numpy()
    array = np.asarray(values, dtype=np.float64)
    if not array.size:
        return array
    array = np.maximum(array, 0.0)
    ceiling = float(np.percentile(array, 95))
    if ceiling <= 1e-9:
        ceiling = float(array.max())
    if ceiling <= 1e-9:
        return np.zeros_like(array)
    return np.minimum(array / ceiling, 4.0)


def cue_metric_salience(cue: Any, meter_candidates: Sequence[int] = (4, 3, 8, 6)) -> float:
    """How much periodic metric structure a single cue carries.

    Returns 0.0 for a cue that is flat across every candidate meter, and grows
    with the contrast between its best downbeat phase and the average beat.
    """

    np = _numpy()
    values = np.asarray(cue, dtype=np.float64).ravel()
    if values.size < 4:
        return 0.0
    overall = float(values.mean())
    if overall <= 1e-9:
        return 0.0
    best = 0.0
    for meter in meter_candidates:
        if values.size < meter * 2:
            continue
        for phase in range(meter):
            selected = values[phase::meter]
            if selected.size:
                best = max(best, float(selected.mean()) / overall)
    return max(0.0, best - 1.0)


def combine_beat_cues(cues: Sequence[Any], meter_candidates: Sequence[int] = (4, 3, 8, 6)) -> Any:
    """Blend per-beat cues, weighting each by the metric evidence it holds.

    A fixed weighting is wrong in both directions: on a drum-led track the
    harmonic novelty is nearly flat, while on a piano ballad the percussive
    channel can be. Letting each cue earn its weight from its own periodicity
    keeps one uninformative channel from diluting a strong one.
    """

    np = _numpy()
    prepared = []
    for cue in cues:
        if cue is None:
            continue
        values = np.asarray(cue, dtype=np.float64).ravel()
        if values.size:
            prepared.append(_unit_scale(values))
    if not prepared:
        return np.zeros(0, dtype=np.float64)

    length = min(values.size for values in prepared)
    prepared = [values[:length] for values in prepared]
    if len(prepared) == 1:
        return prepared[0]

    saliences = [cue_metric_salience(values, meter_candidates) for values in prepared]
    total = sum(saliences)
    if total <= 1e-9:
        return sum(prepared) / len(prepared)
    # A small floor keeps a currently quiet channel present rather than
    # switching it off completely part-way through a song.
    weights = [0.12 / len(prepared) + 0.88 * value / total for value in saliences]
    scale = sum(weights)
    return sum(values * weight for values, weight in zip(prepared, weights)) / scale


def harmonic_novelty_cue(beat_chroma: Any, window: int = 2) -> Any:
    """Per-beat harmonic change, measured over a musically plausible window.

    Comparing only adjacent beats mostly measures melody. Comparing the mean
    chroma of the previous `window` beats against the next `window` responds to
    actual chord changes, which is the metric event worth locating.
    """

    np = _numpy()
    chroma = np.asarray(beat_chroma, dtype=np.float64)
    if chroma.ndim != 2 or chroma.shape[0] != 12 or chroma.shape[1] < 2:
        return np.zeros(0, dtype=np.float64)
    count = chroma.shape[1]
    span = max(1, int(window))
    novelty = np.zeros(count, dtype=np.float64)
    for index in range(count):
        before = chroma[:, max(0, index - span):index]
        after = chroma[:, index:min(count, index + span)]
        if not before.shape[1] or not after.shape[1]:
            continue
        left = before.mean(axis=1)
        right = after.mean(axis=1)
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
        if denominator <= 1e-10:
            continue
        novelty[index] = float(np.clip(1.0 - float(left @ right) / denominator, 0.0, 2.0))
    if count > 1 and novelty[0] == 0.0:
        novelty[0] = float(np.median(novelty[1:]))
    return novelty


def beat_change_cue(
    beat_chroma: Any | None,
    beat_onset: Any | None = None,
    beat_bass_onset: Any | None = None,
    meter_candidates: Sequence[int] = (4, 3, 8, 6),
) -> Any:
    """Per-beat evidence that a bar starts on that beat."""

    cues = []
    if beat_chroma is not None:
        novelty = harmonic_novelty_cue(beat_chroma)
        if novelty.size:
            cues.append(novelty)
    for onset in (beat_onset, beat_bass_onset):
        if onset is not None:
            cues.append(onset)
    return combine_beat_cues(cues, meter_candidates)


def estimate_metric_phase(
    cue: Sequence[float],
    config: BeatGridConfig | None = None,
) -> dict[str, Any] | None:
    """Choose the bar length and the beat on which bars start.

    For every candidate meter the beats are split into `beatsPerBar` phases and
    the phase carrying the most accent evidence is taken as the downbeat.

    The raw contrast between that phase and the average beat cannot be compared
    across meters: a longer bar picks its winner from more phases, each holding
    fewer beats, so it scores higher on pure noise. Measured on real songs this
    bias alone made period 12 look like the strongest meter. The comparison is
    therefore made on a selection-corrected z-score — how far the winning phase
    stands out relative to what the best of `m` phases would reach by chance.
    A score near zero means the audio simply does not say where the bar is.
    """

    np = _numpy()
    options = config or BeatGridConfig()
    values = np.asarray([float(item) for item in cue], dtype=np.float64)
    if values.size < 4:
        return None
    overall = float(values.mean())
    deviation = float(values.std())
    if overall <= 1e-9 or deviation <= 1e-12:
        return None

    # A mild prior: 4/4 is by far the most common, and a doubled tactus (8) or
    # a doubled waltz (6) must beat it clearly rather than by rounding noise.
    priors = {4: 0.0, 3: -0.05, 8: -0.12, 6: -0.12}
    results: list[dict[str, Any]] = []
    for meter in options.meter_candidates:
        if values.size < meter * 2:
            continue
        best_phase = 0
        best_mean = -1.0
        for phase in range(meter):
            selected = values[phase::meter]
            if not selected.size:
                continue
            score = float(selected.mean())
            if score > best_mean:
                best_mean = score
                best_phase = phase
        if best_mean < 0.0:
            continue
        # Standard error of one phase mean, then subtract the expected maximum
        # of `meter` such draws under no structure at all.
        standard_error = deviation * math.sqrt(meter / values.size)
        z_score = (best_mean - overall) / max(1e-12, standard_error)
        expected_best = math.sqrt(2.0 * math.log(meter)) if meter > 1 else 0.0
        corrected = z_score - expected_best
        results.append(
            {
                "beatsPerBar": meter,
                "phase": best_phase,
                "ratio": round(best_mean / overall, 4),
                "score": round(corrected, 4),
                "priorScore": corrected + priors.get(meter, -0.15),
            }
        )
    if not results:
        return None

    best = max(results, key=lambda item: item["priorScore"])
    simple = next((item for item in results if item["beatsPerBar"] == best["beatsPerBar"] // 2), None)
    half_time = False
    if best["beatsPerBar"] in (8, 6) and simple is not None:
        # Only fold the tactus when the wide bar is convincingly better; a tie
        # means the tracker was already counting at the level people would.
        if best["score"] >= simple["score"] + options.half_time_margin:
            half_time = True
        else:
            best = simple

    return {
        "beatsPerBar": best["beatsPerBar"],
        "phase": best["phase"],
        "ratio": best["ratio"],
        "score": best["score"],
        "halfTime": half_time,
        "candidates": [
            {key: item[key] for key in ("beatsPerBar", "phase", "ratio", "score")}
            for item in sorted(results, key=lambda item: -item["priorScore"])
        ],
    }


def fold_half_time(beats: Sequence[float], phase: int) -> tuple[list[float], int]:
    """Keep every second pulse, so the grid counts at the level people count."""

    times = [float(value) for value in beats]
    start = int(phase) % 2
    return times[start::2], (int(phase) - start) // 2


def pulse_confidence(tempo_stability: float, beat_count: int) -> float:
    """How trustworthy the beat positions themselves are."""

    stability = max(0.0, min(1.0, float(tempo_stability)))
    coverage = max(0.0, min(1.0, float(beat_count) / 64.0))
    return round(max(0.0, min(1.0, stability * 0.78 + coverage * 0.22)), 4)


def meter_confidence(metric_score: float) -> float:
    """How clearly one phase stands out as the downbeat.

    The input is the selection-corrected z-score from `estimate_metric_phase`.
    Zero means the winning phase is exactly what chance would produce, so the
    bar line is unknown; 2.5 is a firmly established downbeat. This stays
    independent of the pulse: a steady click track with no accents has
    excellent beats and unknown bar lines.
    """

    return round(max(0.0, min(1.0, float(metric_score) / 2.5)), 4)


def beat_grid_confidence(tempo_stability: float, metric_score: float, beat_count: int) -> float:
    """Blend pulse steadiness, metric clarity and how much song was measured."""

    pulse = pulse_confidence(tempo_stability, beat_count)
    return round(max(0.0, min(1.0, pulse * 0.55 + meter_confidence(metric_score) * 0.45)), 4)


def syncopation_ratio(onset_envelope: Any, beat_frames: Sequence[int]) -> float:
    """Koliko udaraca pada između doba umesto na njih.

    0.5 znači da je energija podjednako na dobi i van nje; iznad toga vodi
    off-beat, što je potpis latino/rumba osećaja. Ispod 0.4 je ravna pratnja.
    """

    np = _numpy()
    envelope = np.asarray(onset_envelope, dtype=np.float64).ravel()
    frames = [int(value) for value in beat_frames]
    if envelope.size < 4 or len(frames) < 4:
        return 0.0

    def sample(position: float) -> float:
        index = int(round(position))
        if index < 0 or index >= envelope.size:
            return 0.0
        low = max(0, index - 1)
        high = min(envelope.size, index + 2)
        return float(envelope[low:high].max())

    on_beat = []
    off_beat = []
    for index in range(len(frames) - 1):
        on_beat.append(sample(frames[index]))
        off_beat.append(sample((frames[index] + frames[index + 1]) / 2.0))
    on_total = float(np.mean(on_beat)) if on_beat else 0.0
    off_total = float(np.mean(off_beat)) if off_beat else 0.0
    if on_total + off_total <= 1e-9:
        return 0.0
    return off_total / (on_total + off_total)


def choose_rhythmic_feel(bpm: float, beats_per_bar: int, syncopation: float) -> str:
    """Izaberi obrazac pratnje iz izmerenih osobina pesme.

    Ovo postoji da korisnik ne bi morao da zna šta je rumba. Nazivi odgovaraju
    obrascima u `js/voicing.js`.
    """

    tempo = float(bpm) if float(bpm) > 0 else 100.0
    if int(beats_per_bar) == 3:
        return "waltz"
    if float(syncopation) >= 0.52:
        return "rumba"
    if tempo < 82.0:
        return "ballad"
    if tempo > 132.0:
        return "backbeat"
    return "downbeats"


def build_beat_grid(
    beats: Sequence[float],
    cue: Sequence[float],
    *,
    source_stems: Sequence[str],
    algorithm: str,
    config: BeatGridConfig | None = None,
    syncopation: float = 0.0,
) -> dict[str, Any]:
    """Assemble the persisted grid from an already detected pulse and cue."""

    options = config or BeatGridConfig()
    times = sorted(float(value) for value in beats if float(value) >= 0.0)
    if len(times) < options.minimum_beats:
        return {
            "schemaVersion": BEAT_GRID_SCHEMA_VERSION,
            "status": "unavailable",
            "algorithm": algorithm,
            "sourceStems": list(source_stems),
            "beats": [],
            "downbeats": [],
            "beatsPerBar": 4,
            "downbeatIndex": 0,
            "bpm": 0.0,
            "confidence": 0.0,
            "message": "Nije pronađen dovoljno dug ravnomeran puls u ovoj pesmi.",
        }

    metric = estimate_metric_phase(cue, options)
    metric_is_weak = not metric or meter_confidence(float(metric["score"])) < options.minimum_confidence
    if metric_is_weak:
        # Merenje nije naslo takt. Nasumicno 3/4 nije posteniji odgovor od
        # 4/4 -- samo je redji: gotovo sav ovaj repertoar je u cetiri. Uzmi
        # najverovatniju meru i najbolju fazu za nju, umesto da odbijes rad.
        fallback = next(
            (item for item in (metric or {}).get("candidates", []) if item["beatsPerBar"] == 4),
            None,
        )
        beats_per_bar = 4
        phase = int(fallback["phase"]) if fallback else 0
    else:
        beats_per_bar = int(metric["beatsPerBar"])
        phase = int(metric["phase"])
    phase_ratio = float(metric["ratio"]) if metric else 1.0
    metric_score = float(metric["score"]) if metric else 0.0
    half_time = bool(metric and metric.get("halfTime")) and not metric_is_weak

    resolution = options.hop_length / max(1, options.sample_rate)
    raw_tempo = summarize_tempo(times, resolution)
    if half_time:
        times, phase = fold_half_time(times, phase)
        beats_per_bar //= 2
    beats_per_bar = max(2, beats_per_bar)
    phase = phase % beats_per_bar

    tempo = summarize_tempo(times, resolution)
    pulse = pulse_confidence(tempo["stability"], len(times))
    meter = meter_confidence(metric_score)
    confidence = beat_grid_confidence(tempo["stability"], metric_score, len(times))

    # Beats and bars fail independently. A steady pulse with no metric accent
    # still quantises notes correctly; only bar-aware features (comping
    # patterns, bar loops) have to wait for a confirmed downbeat.
    status = "ready"
    message = ""
    if len(times) < options.minimum_beats:
        status = "unavailable"
        message = "Nije pronađen dovoljno dug ravnomeran puls u ovoj pesmi."
    elif pulse < options.minimum_confidence:
        status = "low-confidence"
        message = "Puls je nestabilan — proveri tempo pre kvantizacije."
    meter_status = "ready" if meter >= options.minimum_confidence else "uncertain"
    if status == "ready" and meter_status == "uncertain":
        message = "Bitovi su pouzdani, ali prva doba nije jasna — proveri taktovu crtu."

    downbeats = times[phase::beats_per_bar]
    return {
        "schemaVersion": BEAT_GRID_SCHEMA_VERSION,
        "status": status,
        "algorithm": algorithm,
        "sourceStems": list(source_stems),
        "timeBase": "mix-seconds",
        "bpm": tempo["bpm"],
        "bpmRange": tempo["bpmRange"],
        "beatsPerBar": beats_per_bar,
        "downbeatIndex": phase,
        "beats": [round(value, 4) for value in times],
        "downbeats": [round(value, 4) for value in downbeats],
        "confidence": confidence,
        "meterStatus": meter_status,
        "feel": choose_rhythmic_feel(tempo["bpm"], beats_per_bar, syncopation),
        "syncopation": round(max(0.0, min(1.0, float(syncopation))), 4),
        "halfTimeApplied": half_time,
        "rawBpm": raw_tempo["bpm"] if half_time else tempo["bpm"],
        "qa": {
            "beatCount": len(times),
            "barCount": len(downbeats),
            "tempoStability": tempo["stability"],
            "pulseConfidence": pulse,
            "meterConfidence": meter,
            "phaseRatio": round(phase_ratio, 4),
            "metricScore": round(metric_score, 4),
            "meterCandidates": (metric or {}).get("candidates", []),
        },
        "message": message,
    }


def _load_pulse_audio(stems: Mapping[str, Path], config: BeatGridConfig) -> tuple[Any, list[str]]:
    """Load the percussive channel, falling back to the summed mix."""

    np = _numpy()
    import librosa

    used: list[str] = []
    for name in PULSE_STEM_PRIORITY:
        path = stems.get(name)
        if path is None:
            continue
        signal, _rate = librosa.load(Path(path), sr=config.sample_rate, mono=True)
        if signal.size and float(np.sqrt(np.mean(np.square(signal)))) > 1e-4:
            return signal.astype(np.float32, copy=False), [name]

    summed = None
    for name, path in stems.items():
        signal, _rate = librosa.load(Path(path), sr=config.sample_rate, mono=True)
        if not signal.size:
            continue
        used.append(name)
        if summed is None:
            summed = signal.astype(np.float64, copy=True)
        else:
            length = min(summed.size, signal.size)
            summed = summed[:length] + signal[:length]
    if summed is None:
        return np.zeros(0, dtype=np.float32), []
    return summed.astype(np.float32, copy=False), sorted(used)


def _load_harmonic_audio(stems: Mapping[str, Path], config: BeatGridConfig, length: int) -> Any | None:
    np = _numpy()
    import librosa

    summed = None
    for name in HARMONIC_STEM_NAMES:
        path = stems.get(name)
        if path is None:
            continue
        signal, _rate = librosa.load(Path(path), sr=config.sample_rate, mono=True)
        if not signal.size:
            continue
        if summed is None:
            summed = signal.astype(np.float64, copy=True)
        else:
            shared = min(summed.size, signal.size)
            summed = summed[:shared] + signal[:shared]
    if summed is None:
        return None
    if summed.size < length:
        summed = np.pad(summed, (0, length - summed.size))
    return summed[:length].astype(np.float32, copy=False)


def detect_beat_grid_onset(
    stems: Mapping[str, Path],
    progress: Callable[[str, str, str], None] | None = None,
    config: BeatGridConfig | None = None,
) -> dict[str, Any] | None:
    """Legacy onset-tracking grid, kept only as a fallback.

    Measured against synthetic audio with a known tempo this path scores
    0.764 beat F where the trained model scores 0.996, and on real mixes it
    reports ``confidence 1.0`` for grids that are simply wrong. It runs only
    when the model cannot be loaded at all, because a wrong grid still
    quantises better than no grid.
    """

    options = config or BeatGridConfig()
    if not stems:
        return None
    try:
        import librosa
    except ImportError:
        return None
    np = _numpy()

    if progress:
        progress("analyzing", "beat-grid", "Detecting tempo, beats and bar lines.")

    pulse_audio, pulse_stems = _load_pulse_audio(stems, options)
    if pulse_audio.size < options.sample_rate:
        return None

    onset_envelope = librosa.onset.onset_strength(
        y=pulse_audio,
        sr=options.sample_rate,
        hop_length=options.hop_length,
        aggregate=np.median,
    )
    _tempo, beat_times = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=options.sample_rate,
        hop_length=options.hop_length,
        start_bpm=options.start_bpm,
        units="time",
        trim=False,
    )
    beat_times = [float(value) for value in np.atleast_1d(beat_times)]
    algorithm = "librosa-beat-track-v1+metric-phase-v1"
    if len(beat_times) < options.minimum_beats:
        return build_beat_grid([], [], source_stems=pulse_stems, algorithm=algorithm, config=options)

    beat_frames = librosa.time_to_frames(
        np.asarray(beat_times, dtype=np.float64),
        sr=options.sample_rate,
        hop_length=options.hop_length,
    )
    beat_frames = [int(value) for value in np.atleast_1d(beat_frames)]

    beat_onset = aggregate_by_beat(onset_envelope, beat_frames)
    beat_onset = beat_onset[0] if beat_onset.shape[1] else np.zeros(0)

    # Bass attacks mark the harmonic rhythm, which is often a cleaner bar cue
    # than the drum kit on tracks with a busy backbeat.
    beat_bass_onset = None
    bass_path = stems.get("bass")
    if bass_path is not None:
        try:
            bass_audio, _rate = librosa.load(Path(bass_path), sr=options.sample_rate, mono=True)
        except Exception:
            bass_audio = np.zeros(0, dtype=np.float32)
        if bass_audio.size:
            bass_envelope = librosa.onset.onset_strength(
                y=bass_audio,
                sr=options.sample_rate,
                hop_length=options.hop_length,
                aggregate=np.median,
            )
            aggregated_bass = aggregate_by_beat(bass_envelope, beat_frames)
            if aggregated_bass.shape[1]:
                beat_bass_onset = aggregated_bass[0]

    beat_chroma = None
    harmonic_audio = _load_harmonic_audio(stems, options, pulse_audio.size)
    if harmonic_audio is not None and harmonic_audio.size:
        try:
            tuning = float(librosa.estimate_tuning(y=harmonic_audio, sr=options.sample_rate))
        except Exception:
            tuning = 0.0
        chroma = librosa.feature.chroma_cqt(
            y=harmonic_audio,
            sr=options.sample_rate,
            hop_length=options.hop_length,
            fmin=librosa.note_to_hz("C2"),
            n_octaves=6,
            bins_per_octave=36,
            tuning=tuning,
            norm=None,
        )
        aggregated = aggregate_by_beat(chroma, beat_frames)
        if aggregated.shape[1]:
            beat_chroma = aggregated

    cue = beat_change_cue(beat_chroma, beat_onset, beat_bass_onset, options.meter_candidates)
    syncopation = syncopation_ratio(onset_envelope, beat_frames)
    return build_beat_grid(
        beat_times,
        cue,
        source_stems=sorted(set(pulse_stems) | {name for name in HARMONIC_STEM_NAMES if name in stems}),
        algorithm=algorithm,
        config=options,
        syncopation=syncopation,
    )


# ---------------------------------------------------------------------------
# Model-based grid — the primary path
# ---------------------------------------------------------------------------
#
# The onset-tracking path above decides the tempo octave from `start_bpm`
# rather than from the audio (the same song reads 57, 92 or 152 BPM depending
# on where the search starts), and its phase is metastable: trimming 10 ms off
# the front moves the whole grid by a third of a beat. Neither failure shows in
# its own confidence, which reports 1.0 either way.
#
# `beat_this` (ISMIR 2024, MIT licence, code and weights) is a trained model
# that reads beats and bar lines directly. Measured on this machine: beat
# F 0.996 against 0.764, downbeat F 0.986 against 0.692, unchanged output under
# a 500 ms trim, and 4-11 s per song on CPU — no slower than what it replaces.

MODEL_CHECKPOINT = "final0"
MODEL_SAMPLE_RATE = 22_050

# One frame of the old onset path. Musically irrelevant, but it is exactly the
# perturbation that exposed the legacy metastable phase, so it makes an honest
# self-check: a grid that survives it is anchored in the audio.
PERTURBATION_SECONDS = 0.023
BEAT_MATCH_TOLERANCE = 0.07

_MODEL_CACHE: dict[str, Any] = {}


def _audio_to_beats(device: str = "cpu"):
    """Return the cached predictor, downloading the checkpoint on first use."""

    predictor = _MODEL_CACHE.get("audio2beats")
    if predictor is None:
        from beat_this.inference import Audio2Beats

        predictor = Audio2Beats(checkpoint_path=MODEL_CHECKPOINT, device=device, dbn=False)
        _MODEL_CACHE["audio2beats"] = predictor
    return predictor


def _load_mix_audio(stems: Mapping[str, Path], config: BeatGridConfig) -> tuple[Any, list[str]]:
    """Sum the stems back into the mix the model was trained on.

    Feeding it the drum channel alone measures worse: beat spacing scatters ten
    times wider, because the model reads harmony and bass as metric evidence
    too and an isolated kit denies it both.
    """

    np = _numpy()
    import librosa

    summed = None
    used: list[str] = []
    for name, path in sorted(stems.items()):
        try:
            signal, _rate = librosa.load(Path(path), sr=MODEL_SAMPLE_RATE, mono=True)
        except Exception:
            continue
        if not signal.size:
            continue
        used.append(name)
        if summed is None:
            summed = signal.astype(np.float64, copy=True)
        else:
            shared = min(summed.size, signal.size)
            summed = summed[:shared] + signal[:shared]
    if summed is None:
        return np.zeros(0, dtype=np.float32), []
    peak = float(np.max(np.abs(summed))) if summed.size else 0.0
    if peak > 1.0:
        summed = summed / peak
    return summed.astype(np.float32, copy=False), sorted(used)


def beat_match_f_measure(
    reference: Sequence[float],
    estimate: Sequence[float],
    tolerance: float = BEAT_MATCH_TOLERANCE,
) -> float:
    """F-measure between two beat sequences, at most one match per beat.

    Used to compare a grid against a slightly perturbed rerun of itself, which
    is the only correctness signal available without human annotation.
    """

    reference = [float(value) for value in reference]
    estimate = [float(value) for value in estimate]
    if not reference or not estimate:
        return 0.0
    matched = 0
    used: set[int] = set()
    for time in reference:
        best_index = -1
        best_distance = tolerance
        for index, candidate in enumerate(estimate):
            if index in used:
                continue
            distance = abs(candidate - time)
            if distance <= best_distance:
                best_distance = distance
                best_index = index
            elif candidate - time > tolerance:
                break
        if best_index >= 0:
            used.add(best_index)
            matched += 1
    if not matched:
        return 0.0
    precision = matched / len(estimate)
    recall = matched / len(reference)
    return round(2.0 * precision * recall / (precision + recall), 4)


def derive_meter(beats: Sequence[float], downbeats: Sequence[float]) -> dict[str, Any]:
    """Read beats-per-bar and the bar phase from the bar lines the model gives.

    The old path inferred the bar from accent statistics and returned a
    different answer for every encoding of the same song. Here the bar lines
    arrive with the beats, so the only work left is counting the beats between
    them.
    """

    beats = [float(value) for value in beats]
    downbeats = [float(value) for value in downbeats]
    if len(beats) < 2 or len(downbeats) < 2:
        return {"beatsPerBar": 4, "phase": 0, "consistency": 0.0, "barCount": len(downbeats)}

    indices: list[int] = []
    for time in downbeats:
        best_index = min(range(len(beats)), key=lambda i: abs(beats[i] - time))
        if abs(beats[best_index] - time) <= BEAT_MATCH_TOLERANCE:
            indices.append(best_index)
    if len(indices) < 2:
        return {"beatsPerBar": 4, "phase": 0, "consistency": 0.0, "barCount": len(downbeats)}

    spacings = [indices[i + 1] - indices[i] for i in range(len(indices) - 1)]
    spacings = [value for value in spacings if 2 <= value <= 16]
    if not spacings:
        return {"beatsPerBar": 4, "phase": indices[0] % 4, "consistency": 0.0, "barCount": len(indices)}

    counts: dict[int, int] = {}
    for value in spacings:
        counts[value] = counts.get(value, 0) + 1
    beats_per_bar = max(counts, key=lambda key: (counts[key], -key))
    consistency = counts[beats_per_bar] / len(spacings)
    return {
        "beatsPerBar": int(beats_per_bar),
        "phase": int(indices[0] % beats_per_bar),
        "consistency": round(float(consistency), 4),
        "barCount": len(indices),
    }


def build_model_beat_grid(
    beats: Sequence[float],
    downbeats: Sequence[float],
    *,
    source_stems: Sequence[str],
    algorithm: str,
    agreement: float,
    config: BeatGridConfig | None = None,
    syncopation: float = 0.0,
) -> dict[str, Any]:
    """Assemble the persisted grid from model beats and bar lines."""

    options = config or BeatGridConfig()
    times = sorted(float(value) for value in beats if float(value) >= 0.0)
    if len(times) < options.minimum_beats:
        return {
            "schemaVersion": BEAT_GRID_SCHEMA_VERSION,
            "status": "unavailable",
            "algorithm": algorithm,
            "sourceStems": list(source_stems),
            "beats": [],
            "downbeats": [],
            "beatsPerBar": 4,
            "downbeatIndex": 0,
            "bpm": 0.0,
            "confidence": 0.0,
            "message": "Nije pronađen dovoljno dug ravnomeran puls u ovoj pesmi.",
        }

    meter = derive_meter(times, downbeats)
    beats_per_bar = max(2, int(meter["beatsPerBar"]))
    phase = int(meter["phase"]) % beats_per_bar
    consistency = float(meter["consistency"])

    tempo = summarize_tempo(times, 0.0)

    # Both numbers are measured, not asserted. The pulse is trusted as far as a
    # perturbed rerun reproduces it; the bar is trusted as far as the model
    # spaces its own bar lines evenly.
    pulse = round(max(0.0, min(1.0, agreement)), 4)
    meter_conf = round(max(0.0, min(1.0, consistency)), 4)
    confidence = round(min(pulse, max(meter_conf, 0.5 * pulse)), 4)

    status = "ready"
    message = ""
    if pulse < options.minimum_confidence:
        status = "low-confidence"
        message = "Puls nije stabilan na ovoj snimci — kvantizacija može da promaši."
    meter_status = "ready" if meter_conf >= 0.9 else "uncertain"
    if status == "ready" and meter_status == "uncertain":
        message = "Bitovi su pouzdani, ali taktovi nisu ravnomerni."

    resolved_downbeats = [time for index, time in enumerate(times) if index % beats_per_bar == phase]
    return {
        "schemaVersion": BEAT_GRID_SCHEMA_VERSION,
        "status": status,
        "algorithm": algorithm,
        "sourceStems": list(source_stems),
        "timeBase": "mix-seconds",
        "bpm": tempo["bpm"],
        "bpmRange": tempo["bpmRange"],
        "beatsPerBar": beats_per_bar,
        "downbeatIndex": phase,
        "beats": [round(value, 4) for value in times],
        "downbeats": [round(value, 4) for value in resolved_downbeats],
        "confidence": confidence,
        "meterStatus": meter_status,
        "feel": choose_rhythmic_feel(tempo["bpm"], beats_per_bar, syncopation),
        "syncopation": round(max(0.0, min(1.0, float(syncopation))), 4),
        # The model reports the musical beat directly, so there is no doubled
        # tactus to fold. The field stays for the stored schema and old songs.
        "halfTimeApplied": False,
        "rawBpm": tempo["bpm"],
        "qa": {
            "beatCount": len(times),
            "barCount": len(resolved_downbeats),
            "tempoStability": tempo["stability"],
            "pulseConfidence": pulse,
            "meterConfidence": meter_conf,
            "barSpacingConsistency": consistency,
            "perturbationAgreement": round(float(agreement), 4),
            "modelDownbeatCount": len(list(downbeats)),
        },
        "message": message,
    }


def detect_beat_grid(
    stems: Mapping[str, Path],
    progress: Callable[[str, str, str], None] | None = None,
    config: BeatGridConfig | None = None,
) -> dict[str, Any] | None:
    """Detect the tempo, beat and downbeat grid of one separated song."""

    options = config or BeatGridConfig()
    if not stems:
        return None

    if progress:
        progress("analyzing", "beat-grid", "Detecting tempo, beats and bar lines.")

    try:
        predictor = _audio_to_beats()
    except Exception:
        # No weights and no network. A measurably worse grid still beats none.
        return detect_beat_grid_onset(stems, None, options)

    np = _numpy()
    signal, used_stems = _load_mix_audio(stems, options)
    if signal.size < MODEL_SAMPLE_RATE:
        return None

    beats, downbeats = predictor(signal, MODEL_SAMPLE_RATE)
    beats = [float(value) for value in np.atleast_1d(beats)]
    downbeats = [float(value) for value in np.atleast_1d(downbeats)]
    if len(beats) < options.minimum_beats:
        return build_model_beat_grid(
            [], [], source_stems=used_stems, algorithm="beat-this-v1", agreement=0.0, config=options
        )

    # Self-check: rerun on the same audio shifted by one old-pipeline frame and
    # measure how much of the grid survives. This is the confidence the stored
    # grid reports, and it costs one extra inference pass.
    agreement = 0.0
    try:
        offset = int(round(PERTURBATION_SECONDS * MODEL_SAMPLE_RATE))
        shifted_beats, _shifted_downbeats = predictor(signal[offset:], MODEL_SAMPLE_RATE)
        shifted = [float(value) + PERTURBATION_SECONDS for value in np.atleast_1d(shifted_beats)]
        agreement = beat_match_f_measure(beats, shifted)
    except Exception:
        # The grid stays usable; only its self-reported confidence is lost.
        agreement = 0.0

    return build_model_beat_grid(
        beats,
        downbeats,
        source_stems=used_stems,
        algorithm="beat-this-v1+perturbation-check",
        agreement=agreement,
        config=options,
    )
