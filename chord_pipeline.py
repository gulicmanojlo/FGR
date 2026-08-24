"""Time-aligned major/minor chord extraction for separated FGR stems.

The browser analyser remains a useful fallback, but the processing worker has
the better source material: aligned harmonic stems and an isolated bass stem.
This module keeps the frame labelling and the boundary estimator independent
so their timing behaviour can be covered by small deterministic tests.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


NOTE_NAMES = ("C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "B", "H")


@dataclass(frozen=True)
class ChordAnalysisConfig:
    sample_rate: int = 22_050
    hop_length: int = 256
    minimum_segment_seconds: float = 0.90
    hard_minimum_segment_seconds: float = 0.28
    boundary_search_seconds: float = 0.65
    boundary_evidence_seconds: float = 0.34
    switch_penalty: float = 1.00
    # Kazna prelaza pri dekodiranju po dobama; manja je od frejmske jer je
    # jedna doba već dug korak.
    beat_switch_penalty: float = 0.42
    # Mereno: 100 ms je optimum, 150 ms je vec losije od nesnapovanog.
    grid_snap_seconds: float = 0.1


@dataclass(frozen=True)
class ChordTemplate:
    name: str
    root: int
    tones: tuple[int, ...]
    prior: float = 0.0


# Kvalitet akorda, njegovi intervali i koliko je čest. Prior je mala kazna u
# istim jedinicama kao rezultat šablona: sprečava da se retki akord izabere
# kada obični objašnjava zvuk jednako dobro. Nazivi moraju da se poklapaju sa
# `parseChordName` u js/ui-tools.js, inače klavir ne bi znao šta da svira.
#
# Vrednosti priora su kalibrisane na stvarnim razdvojenim kanalima iz
# repertoara, ne procenjene. Sa upola manjim priorima septakordi su izlazili
# na 46-52% svih akorada, a maj7 na 10-19% — to nije muzika nego prolazni
# tonovi melodije koji ostaju u harmonijskim kanalima. Na ovim vrednostima
# septakordi padaju na 8-14%, a maj7 na 0%, što odgovara ovom žanru.
CHORD_QUALITIES = (
    ("", (0, 4, 7), 0.0),
    ("m", (0, 3, 7), 0.0),
    ("7", (0, 4, 7, 10), -0.032),
    ("m7", (0, 3, 7, 10), -0.036),
    ("maj7", (0, 4, 7, 11), -0.068),
    ("sus4", (0, 5, 7), -0.099),
    ("6", (0, 4, 7, 9), -0.108),
    ("sus2", (0, 2, 7), -0.135),
    ("m6", (0, 3, 7, 9), -0.144),
    ("dim", (0, 3, 6), -0.153),
    ("m7b5", (0, 3, 6, 10), -0.180),
    ("dim7", (0, 3, 6, 9), -0.198),
    ("aug", (0, 4, 8), -0.225),
)

CHORD_TEMPLATES = tuple(
    ChordTemplate(
        name=f"{NOTE_NAMES[root]}{suffix}",
        root=root,
        tones=tuple((root + interval) % 12 for interval in intervals),
        prior=prior,
    )
    for suffix, intervals, prior in CHORD_QUALITIES
    for root in range(12)
)

# Težina po poziciji u akordu: osnovni ton nosi najviše, alteracije najmanje.
TONE_WEIGHTS = (1.30, 1.12, 0.94, 0.86, 0.80)


def chord_template_index(name: str) -> int | None:
    source = str(name or "").strip().split("/")[0]
    aliases = (
        ("Cis", 1), ("Dis", 3), ("Fis", 6), ("Gis", 8),
        ("C#", 1), ("D#", 3), ("F#", 6), ("G#", 8), ("A#", 10),
        ("Db", 1), ("Eb", 3), ("Gb", 6), ("Ab", 8), ("Bb", 10),
        ("C", 0), ("D", 2), ("E", 4), ("F", 5), ("G", 7),
        ("A", 9), ("B", 10), ("H", 11),
    )
    lowered = source.lower()
    matched = next(((alias, root) for alias, root in aliases if lowered.startswith(alias.lower())), None)
    if matched is None:
        return None
    alias, root = matched
    quality = lowered[len(alias):]
    minor = (quality.startswith("m") or quality.startswith("mol")) and not quality.startswith("maj")
    return root + (12 if minor else 0)


def _numpy():
    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - guarded by runtime setup
        raise RuntimeError("NumPy is required for chord analysis.") from exc
    return np


def normalize_chroma(chroma: Any) -> Any:
    """Noise-floor, compress and L1-normalize a 12 x frames chromagram."""

    np = _numpy()
    values = np.asarray(chroma, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] != 12:
        raise ValueError("chroma must have shape (12, frames)")
    values = np.maximum(values, 0.0)
    if not values.shape[1]:
        return values
    floor = np.partition(values, 2, axis=0)[2]
    compressed = np.sqrt(np.maximum(values - floor[None, :] * 0.68, 0.0))
    return compressed / np.maximum(compressed.sum(axis=0, keepdims=True), 1e-10)


def chord_score_matrix(harmonic_chroma: Any, bass_chroma: Any | None = None) -> Any:
    """Return template evidence for every major/minor chord and frame."""

    np = _numpy()
    harmonic = normalize_chroma(harmonic_chroma)
    bass = normalize_chroma(bass_chroma) if bass_chroma is not None else np.zeros_like(harmonic)
    if bass.shape[1] != harmonic.shape[1]:
        raise ValueError("harmonic and bass chroma must have the same frame count")

    scores = np.empty((len(CHORD_TEMPLATES), harmonic.shape[1]), dtype=np.float64)
    all_pitch_classes = set(range(12))
    for index, template in enumerate(CHORD_TEMPLATES):
        tones = template.tones
        weights = TONE_WEIGHTS[:len(tones)]
        outside = sorted(all_pitch_classes.difference(tones))
        # Deljenje ukupnom težinom je ono što drži četvorozvuke poštenim:
        # šablon sa septimom koja se ne čuje deli isti zbir na više tonova i
        # zato gubi od trozvuka, umesto da pobedi samo zato što pokriva više.
        coverage = sum(harmonic[tone] * weight for tone, weight in zip(tones, weights, strict=True))
        coverage = coverage / sum(weights)
        leakage = harmonic[outside].sum(axis=0) if outside else np.zeros(harmonic.shape[1])
        # Bass is deliberately strong enough to disambiguate inversions and
        # shared-tone pairs, but it cannot win without harmonic support.
        scores[index] = (
            coverage * 1.82
            + harmonic[template.root] * 0.30
            + bass[template.root] * 0.43
            - leakage * 0.48
            + template.prior
        )
    return scores


# Krumhansl-Schmuckler profili: koliko se koja tonska klasa čuje u duru/molu.
MAJOR_KEY_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_KEY_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
# Prirodni, harmonski i melodijski mol zajedno: u praksi se u molu čuju i
# povišeni šesti i sedmi stupanj, pa ih dijatonski prior ne sme kažnjavati.
MINOR_SCALE = (0, 2, 3, 5, 7, 8, 9, 10, 11)


def estimate_key(chroma: Any) -> dict[str, Any]:
    """Proceni tonalitet iz prosečne hromagrame cele pesme.

    Rezultat se koristi samo kao blaga sklonost ka dijatonskim akordima —
    dovoljno da razdvoji ravnopravne kandidate, premalo da nametne akord koji
    se ne čuje.
    """

    np = _numpy()
    values = np.asarray(chroma, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] != 12 or not values.shape[1]:
        return {"tonic": 0, "minor": False, "confidence": 0.0}
    average = values.mean(axis=1)
    if float(average.sum()) <= 1e-9:
        return {"tonic": 0, "minor": False, "confidence": 0.0}
    average = average - average.mean()

    best = (None, -2.0)
    ranked = []
    for minor in (False, True):
        profile = np.asarray(MINOR_KEY_PROFILE if minor else MAJOR_KEY_PROFILE, dtype=np.float64)
        profile = profile - profile.mean()
        for tonic in range(12):
            rotated = np.roll(profile, tonic)
            denominator = float(np.linalg.norm(average) * np.linalg.norm(rotated))
            score = float(average @ rotated) / denominator if denominator > 1e-12 else 0.0
            ranked.append(score)
            if score > best[1]:
                best = ((tonic, minor), score)
    if best[0] is None:
        return {"tonic": 0, "minor": False, "confidence": 0.0}

    ranked.sort(reverse=True)
    margin = ranked[0] - ranked[1] if len(ranked) > 1 else 0.0
    tonic, minor = best[0]
    return {
        "tonic": int(tonic),
        "minor": bool(minor),
        "confidence": round(max(0.0, min(1.0, margin / 0.18)), 4),
        "name": f"{NOTE_NAMES[tonic]}{'mol' if minor else 'dur'}",
    }


def key_prior_vector(key: Mapping[str, Any] | None, strength: float = 0.05) -> Any:
    """Mala prednost akordima koji pripadaju procenjenom tonalitetu."""

    np = _numpy()
    bonus = np.zeros(len(CHORD_TEMPLATES), dtype=np.float64)
    if not key:
        return bonus
    weight = float(strength) * float(key.get("confidence") or 0.0)
    if weight <= 1e-9:
        return bonus
    tonic = int(key.get("tonic") or 0)
    scale = MINOR_SCALE if key.get("minor") else MAJOR_SCALE
    members = {(tonic + degree) % 12 for degree in scale}
    for index, template in enumerate(CHORD_TEMPLATES):
        outside = sum(1 for tone in template.tones if tone not in members)
        # Akord potpuno u tonalitetu dobija punu prednost; svaki strani ton je
        # skida, a akord van tonaliteta ostaje bez nje (ne biva kažnjen).
        bonus[index] = weight * (1.0 - min(1.0, outside / 2.0))
    return bonus


def decode_beat_chords(
    scores: Any,
    beat_positions: Sequence[int],
    beats_per_bar: int,
    switch_penalty: float = 0.42,
) -> Any:
    """Viterbi po dobama, sa kaznom prelaza koja zavisi od mesta u taktu.

    Harmonija se menja na jakim dobama daleko češće nego između njih. Kada se
    dekodira po frejmu od 11 ms ta činjenica se ne može iskoristiti i granica
    padne gde onset kriva slučajno ima vrh. Po dobama može: promena na prvu
    dobu je jeftina, na sredinu takta srednja, van dobe skupa.
    """

    np = _numpy()
    emission = np.asarray(scores, dtype=np.float64)
    if emission.ndim != 2 or emission.shape[0] != len(CHORD_TEMPLATES):
        raise ValueError(f"scores must have shape ({len(CHORD_TEMPLATES)}, beats)")
    count = emission.shape[1]
    if not count:
        return np.empty(0, dtype=np.int16)

    bar = max(1, int(beats_per_bar))
    positions = [int(value) % bar for value in beat_positions[:count]]
    positions += [0] * (count - len(positions))

    def penalty_at(index: int) -> float:
        position = positions[index]
        if position == 0:
            return switch_penalty * 0.55
        if bar % 2 == 0 and position == bar // 2:
            return switch_penalty * 0.85
        return switch_penalty * 1.7

    backtrack = np.empty((count, emission.shape[0]), dtype=np.int16)
    previous = emission[:, 0].copy()
    backtrack[0] = np.arange(emission.shape[0], dtype=np.int16)
    for beat in range(1, count):
        best_index = int(np.argmax(previous))
        switch_value = previous[best_index] - max(0.0, penalty_at(beat))
        stay = previous
        use_switch = switch_value > stay
        backtrack[beat] = np.where(use_switch, best_index, np.arange(emission.shape[0]))
        previous = emission[:, beat] + np.where(use_switch, switch_value, stay)

    labels = np.empty(count, dtype=np.int16)
    labels[-1] = int(np.argmax(previous))
    for beat in range(count - 1, 0, -1):
        labels[beat - 1] = backtrack[beat, labels[beat]]
    return labels


def decode_chord_frames(scores: Any, switch_penalty: float = 1.00) -> Any:
    """Viterbi-decode stable labels without introducing a one-frame lag."""

    np = _numpy()
    emission = np.asarray(scores, dtype=np.float64)
    if emission.ndim != 2 or emission.shape[0] != len(CHORD_TEMPLATES):
        raise ValueError(f"scores must have shape ({len(CHORD_TEMPLATES)}, frames)")
    frame_count = emission.shape[1]
    if not frame_count:
        return np.empty(0, dtype=np.int16)

    # A short symmetric filter removes isolated spectral spikes. It has zero
    # phase, so unlike causal smoothing it cannot delay every chord change.
    try:
        from scipy.ndimage import median_filter

        emission = median_filter(emission, size=(1, 5), mode="nearest")
    except ImportError:  # pragma: no cover - scipy is a librosa dependency
        pass

    backtrack = np.empty((frame_count, emission.shape[0]), dtype=np.int16)
    previous = emission[:, 0].copy()
    backtrack[0] = np.arange(emission.shape[0], dtype=np.int16)
    for frame in range(1, frame_count):
        best_previous_index = int(np.argmax(previous))
        best_switch_value = previous[best_previous_index] - max(0.0, float(switch_penalty))
        stay = previous
        use_switch = best_switch_value > stay
        backtrack[frame] = np.where(use_switch, best_previous_index, np.arange(emission.shape[0]))
        previous = emission[:, frame] + np.where(use_switch, best_switch_value, stay)

    labels = np.empty(frame_count, dtype=np.int16)
    labels[-1] = int(np.argmax(previous))
    for frame in range(frame_count - 1, 0, -1):
        labels[frame - 1] = backtrack[frame, labels[frame]]
    return labels


def _runs(labels: Any) -> list[dict[str, int]]:
    np = _numpy()
    values = np.asarray(labels, dtype=np.int16)
    if not values.size:
        return []
    runs: list[dict[str, int]] = []
    start = 0
    for index in range(1, values.size + 1):
        if index < values.size and values[index] == values[start]:
            continue
        runs.append({"label": int(values[start]), "start": start, "end": index})
        start = index
    return runs


def _merge_short_runs(labels: Any, scores: Any, minimum_frames: int) -> Any:
    np = _numpy()
    merged = np.asarray(labels, dtype=np.int16).copy()
    if merged.size < 2:
        return merged

    for _pass in range(8):
        changed = False
        runs = _runs(merged)
        for run_index, run in enumerate(runs):
            duration = run["end"] - run["start"]
            if run["label"] < 0 or duration >= minimum_frames:
                continue
            previous = runs[run_index - 1] if run_index else None
            following = runs[run_index + 1] if run_index + 1 < len(runs) else None
            candidates = {
                candidate["label"]
                for candidate in (previous, following)
                if candidate is not None and candidate["label"] >= 0
            }
            if not candidates:
                continue
            ranked = sorted(
                (
                    float(scores[candidate, run["start"]:run["end"]].mean()),
                    candidate,
                )
                for candidate in candidates
            )
            _replacement_score, replacement = ranked[-1]
            merged[run["start"]:run["end"]] = replacement
            changed = True
        if not changed:
            break
    return merged


def _normalized_onset_strength(onset_strength: Any, frame_count: int) -> Any:
    np = _numpy()
    onset = np.asarray(onset_strength, dtype=np.float64).reshape(-1)
    if onset.size < frame_count:
        onset = np.pad(onset, (0, frame_count - onset.size))
    onset = np.maximum(onset[:frame_count], 0.0)
    positive = onset[onset > 0]
    scale = float(np.quantile(positive, 0.92)) if positive.size else 0.0
    if scale <= 1e-10:
        return np.zeros(frame_count, dtype=np.float64)
    return np.clip(onset / scale, 0.0, 1.5)


def _nearby_chord_run(
    runs: Sequence[dict[str, int]],
    run_index: int,
    direction: int,
    maximum_gap_frames: int,
) -> dict[str, int] | None:
    """Find the adjacent chord, crossing only one short inactive gap."""

    neighbour_index = run_index + direction
    if neighbour_index < 0 or neighbour_index >= len(runs):
        return None
    neighbour = runs[neighbour_index]
    if neighbour["label"] >= 0:
        return neighbour
    if neighbour["end"] - neighbour["start"] > maximum_gap_frames:
        return None
    neighbour_index += direction
    if neighbour_index < 0 or neighbour_index >= len(runs):
        return None
    neighbour = runs[neighbour_index]
    return neighbour if neighbour["label"] >= 0 else None


def _short_run_has_independent_evidence(
    run: Mapping[str, int],
    scores: Any,
    normalized_bass: Any,
    normalized_onset: Any,
    boundary_window_frames: int,
) -> bool:
    """Require chord, bass-root and two-boundary evidence for a short chord."""

    np = _numpy()
    label = int(run["label"])
    start = int(run["start"])
    end = int(run["end"])
    if label < 0 or end <= start:
        return False

    segment_scores = np.asarray(scores, dtype=np.float64)[:, start:end].mean(axis=1)
    alternatives = np.delete(segment_scores, label)
    chord_margin = float(segment_scores[label] - alternatives.max()) if alternatives.size else 0.0

    root = label % 12
    segment_bass = normalized_bass[:, start:end].mean(axis=1)
    other_bass = np.delete(segment_bass, root)
    bass_margin = float(segment_bass[root] - other_bass.max()) if other_bass.size else 0.0

    radius = max(1, int(boundary_window_frames))

    def boundary_peak(index: int) -> float:
        lower = max(0, index - radius)
        upper = min(normalized_onset.size, index + radius + 1)
        return float(normalized_onset[lower:upper].max()) if upper > lower else 0.0

    # These thresholds are deliberately conjunctive. A melodic chroma spike,
    # an isolated bass note or a drum hit is insufficient on its own. A short
    # label survives only when all three independent views agree.
    return (
        chord_margin >= 0.083
        and bass_margin >= 0.012
        and boundary_peak(start) >= 0.50
        and boundary_peak(end) >= 0.50
    )


def _merge_short_runs_with_evidence(
    labels: Any,
    scores: Any,
    minimum_frames: int,
    hard_minimum_frames: int,
    bass_chroma: Any | None,
    onset_strength: Any | None,
    boundary_window_frames: int,
) -> Any:
    """Two-tier merge: reject glitches, retain independently supported chords.

    The evidence-aware path is intentionally opt-in. Older callers that do
    not provide both an isolated bass chromagram and onset evidence retain the
    established fixed-minimum behaviour instead of receiving guessed results.
    """

    np = _numpy()
    merged = np.asarray(labels, dtype=np.int16).copy()
    evidence = np.asarray(scores, dtype=np.float64)
    if merged.size < 2:
        return merged
    if bass_chroma is None or onset_strength is None:
        return _merge_short_runs(merged, evidence, minimum_frames)

    bass = np.asarray(bass_chroma, dtype=np.float64)
    if (
        bass.ndim != 2
        or bass.shape[0] != 12
        or bass.shape[1] < merged.size
        or evidence.ndim != 2
        or evidence.shape[1] < merged.size
    ):
        return _merge_short_runs(merged, evidence, minimum_frames)
    normalized_bass = normalize_chroma(bass[:, :merged.size])
    normalized_onset = _normalized_onset_strength(onset_strength, merged.size)
    hard_floor = max(2, min(int(minimum_frames), int(hard_minimum_frames)))
    maximum_gap = max(1, hard_floor)

    for _pass in range(8):
        changed = False
        runs = _runs(merged)
        for run_index, run in enumerate(runs):
            duration = run["end"] - run["start"]
            if run["label"] < 0 or duration >= minimum_frames:
                continue
            previous = _nearby_chord_run(runs, run_index, -1, maximum_gap)
            following = _nearby_chord_run(runs, run_index, 1, maximum_gap)
            candidates = {
                candidate["label"]
                for candidate in (previous, following)
                if candidate is not None
                and candidate["label"] >= 0
                and candidate["label"] != run["label"]
            }
            if not candidates:
                continue
            if (
                duration >= hard_floor
                and _short_run_has_independent_evidence(
                    run,
                    evidence,
                    normalized_bass,
                    normalized_onset,
                    boundary_window_frames,
                )
            ):
                continue
            ranked = sorted(
                (
                    float(evidence[candidate, run["start"]:run["end"]].mean()),
                    candidate,
                )
                for candidate in candidates
            )
            _replacement_score, replacement = ranked[-1]
            merged[run["start"]:run["end"]] = replacement
            changed = True
        if not changed:
            break
    return merged


def _weighted_side_mean(values: Any, indices: Any, boundary_index: int, radius: int) -> float:
    np = _numpy()
    distances = np.abs(indices - boundary_index)
    weights = np.maximum(0.22, 1.0 - distances / max(1, radius))
    return float(np.average(values[indices], weights=weights))


def _boundary_evidence(
    preference: Any,
    boundary_index: int,
    radius: int,
    onset_strength: Any,
) -> tuple[float, float, float] | None:
    np = _numpy()
    left = np.arange(max(0, boundary_index - radius), boundary_index)
    right = np.arange(boundary_index, min(preference.size, boundary_index + radius))
    if left.size < 2 or right.size < 2:
        return None
    left_contrast = _weighted_side_mean(preference, left, boundary_index, radius)
    right_contrast = -_weighted_side_mean(preference, right, boundary_index, radius)
    contrast = (left_contrast + right_contrast) / 2.0 + min(left_contrast, right_contrast) * 0.22

    local_radius = max(2, min(radius, 4))
    local_left = preference[max(0, boundary_index - local_radius):boundary_index]
    local_right = preference[boundary_index:min(preference.size, boundary_index + local_radius)]
    local_change = max(0.0, float(local_left.mean() - local_right.mean())) if local_left.size and local_right.size else 0.0
    onset = float(onset_strength[boundary_index]) if boundary_index < onset_strength.size else 0.0
    return contrast, local_change, onset


def refine_boundary_index(
    scores: Any,
    previous_label: int,
    next_label: int,
    initial_index: int,
    onset_strength: Any | None = None,
    *,
    search_frames: int = 20,
    evidence_frames: int = 24,
    minimum_index: int | None = None,
    maximum_index: int | None = None,
    boundary_scores: Any | None = None,
) -> int:
    """Refine one boundary; no song-wide timing offset is ever applied."""

    np = _numpy()
    evidence = np.asarray(boundary_scores if boundary_scores is not None else scores, dtype=np.float64)
    frame_count = evidence.shape[1]
    if frame_count < 5 or previous_label == next_label:
        return max(1, min(frame_count - 1, int(initial_index)))
    initial = max(1, min(frame_count - 1, int(initial_index)))
    onset = np.asarray(onset_strength, dtype=np.float64) if onset_strength is not None else np.zeros(frame_count)
    if onset.size < frame_count:
        onset = np.pad(onset, (0, frame_count - onset.size))
    onset = onset[:frame_count]
    positive = onset[onset > 0]
    scale = float(np.quantile(positive, 0.92)) if positive.size else 0.0
    if scale > 1e-10:
        onset = np.clip(onset / scale, 0.0, 1.5)

    preference = evidence[previous_label] - evidence[next_label]
    lower = max(2, initial - max(1, int(search_frames)))
    upper = min(frame_count - 2, initial + max(1, int(search_frames)))
    if minimum_index is not None:
        lower = max(lower, int(minimum_index))
    if maximum_index is not None:
        upper = min(upper, int(maximum_index))
    if upper < lower:
        return initial
    candidates: list[tuple[float, float, int]] = []
    for candidate in range(lower, upper + 1):
        result = _boundary_evidence(preference, candidate, max(3, int(evidence_frames)), onset)
        if result is None:
            continue
        contrast, local_change, attack = result
        # Harmonic evidence owns the decision. Local score slope and an onset
        # only resolve the broad plateau to an audible attack point.
        effective = (
            contrast
            + min(0.20, local_change * 0.22)
            + min(0.055, attack * 0.036)
            - abs(candidate - initial) / max(1, search_frames) * 0.018
        )
        candidates.append((effective, contrast, candidate))
    if not candidates:
        return initial
    candidates.sort(reverse=True)
    best_effective, best_contrast, best_index = candidates[0]
    initial_result = _boundary_evidence(preference, initial, max(3, int(evidence_frames)), onset)
    initial_contrast = initial_result[0] if initial_result is not None else float("-inf")
    if best_contrast < 0.035:
        return initial
    if abs(best_index - initial) > 2 and best_effective < initial_contrast + 0.012:
        return initial

    # Snap to the strongest very-near attack only when pairwise harmonic
    # evidence remains essentially as good. This is what makes a displayed
    # boundary follow the heard bass/strum instead of the centre of a smear.
    near = range(max(2, best_index - 3), min(frame_count - 2, best_index + 3) + 1)
    onset_index = max(near, key=lambda index: float(onset[index]))
    onset_result = _boundary_evidence(preference, onset_index, max(3, int(evidence_frames)), onset)
    if (
        onset[onset_index] >= 0.55
        and onset_result is not None
        and onset_result[0] >= best_contrast - 0.025
    ):
        best_index = onset_index
    return int(best_index)


def build_chord_chart_from_features(
    frame_times: Sequence[float],
    harmonic_chroma: Any,
    bass_chroma: Any | None = None,
    onset_strength: Any | None = None,
    active_mask: Any | None = None,
    config: ChordAnalysisConfig | None = None,
    *,
    boundary_harmonic_chroma: Any | None = None,
    boundary_bass_chroma: Any | None = None,
) -> list[dict[str, Any]]:
    """Build a stable chart and preserve millisecond boundary precision."""

    np = _numpy()
    options = config or ChordAnalysisConfig()
    times = np.asarray(frame_times, dtype=np.float64)
    scores = chord_score_matrix(harmonic_chroma, bass_chroma)
    boundary_scores = (
        chord_score_matrix(boundary_harmonic_chroma, boundary_bass_chroma)
        if boundary_harmonic_chroma is not None
        else scores
    )
    frame_count = min(times.size, scores.shape[1])
    frame_count = min(frame_count, boundary_scores.shape[1])
    if frame_count < 4:
        return []
    times = times[:frame_count]
    scores = scores[:, :frame_count]
    boundary_scores = boundary_scores[:, :frame_count]
    onset = np.asarray(onset_strength, dtype=np.float64)[:frame_count] if onset_strength is not None else np.zeros(frame_count)
    if onset.size < frame_count:
        onset = np.pad(onset, (0, frame_count - onset.size))

    labels = decode_chord_frames(scores, options.switch_penalty)
    if active_mask is not None:
        active = np.asarray(active_mask, dtype=bool)[:frame_count]
        if active.size < frame_count:
            active = np.pad(active, (0, frame_count - active.size))
        labels[~active] = -1

    hop_seconds = float(np.median(np.diff(times))) if times.size > 1 else options.hop_length / options.sample_rate
    minimum_frames = max(2, int(round(options.minimum_segment_seconds / max(hop_seconds, 1e-4))))
    hard_minimum_frames = max(
        2,
        int(round(options.hard_minimum_segment_seconds / max(hop_seconds, 1e-4))),
    )
    boundary_window_frames = max(1, int(round(0.10 / max(hop_seconds, 1e-4))))
    labels = _merge_short_runs_with_evidence(
        labels,
        scores,
        minimum_frames,
        hard_minimum_frames,
        bass_chroma,
        onset_strength,
        boundary_window_frames,
    )
    runs = [run for run in _runs(labels) if run["label"] >= 0]
    if not runs:
        return []

    search_frames = max(2, int(round(options.boundary_search_seconds / max(hop_seconds, 1e-4))))
    evidence_frames = max(3, int(round(options.boundary_evidence_seconds / max(hop_seconds, 1e-4))))
    chart: list[dict[str, Any]] = []
    previous_run: dict[str, int] | None = None
    previous_boundary_index = -1
    for run in runs:
        if previous_run is None or previous_run["end"] < run["start"]:
            boundary_index = run["start"]
        else:
            previous_length = previous_run["end"] - previous_run["start"]
            current_length = run["end"] - run["start"]
            left_guard = max(1, min(minimum_frames // 2, previous_length // 2))
            right_guard = max(1, min(minimum_frames // 2, current_length // 2))
            boundary_index = refine_boundary_index(
                scores,
                previous_run["label"],
                run["label"],
                run["start"],
                onset,
                search_frames=search_frames,
                evidence_frames=evidence_frames,
                minimum_index=max(previous_boundary_index + 1, previous_run["start"] + left_guard),
                maximum_index=run["end"] - right_guard,
                boundary_scores=boundary_scores,
            )
        boundary_index = max(previous_boundary_index + 1, boundary_index)
        if boundary_index <= 0:
            boundary = max(0.0, float(times[0] - hop_seconds / 2.0))
        else:
            # At this fine hop the selected frame is the acoustic crossover or
            # snapped onset itself. Keeping its centre avoids putting the chart
            # another half-hop before a clearly measured attack.
            boundary = float(times[boundary_index])
        segment_scores = scores[:, run["start"]:run["end"]].mean(axis=1)
        ordered = np.sort(segment_scores)
        confidence = float(np.clip((ordered[-1] - ordered[-2]) * 2.8 + 0.45, 0.0, 1.0))
        chart.append({
            "t": round(max(0.0, boundary), 3),
            "n": CHORD_TEMPLATES[run["label"]].name,
            "confidence": round(confidence, 3),
        })
        previous_run = run
        previous_boundary_index = boundary_index

    # A silence gap can split two identical chords. It is useful for playback,
    # but not as a duplicate chart label.
    deduplicated = [
        entry for index, entry in enumerate(chart)
        if index == 0 or entry["n"] != chart[index - 1]["n"]
    ]
    return enforce_hard_minimum_chart_segments(
        deduplicated,
        options.hard_minimum_segment_seconds,
        duration_seconds=float(times[-1] + hop_seconds / 2.0),
    )


def enforce_hard_minimum_chart_segments(
    chart: Sequence[Mapping[str, Any]],
    minimum_seconds: float,
    *,
    duration_seconds: float | None = None,
) -> list[dict[str, Any]]:
    """Remove sub-floor labels introduced while snapping acoustic boundaries.

    Frame-run filtering happens before boundary refinement. Two independently
    refined neighbouring boundaries can still squeeze an otherwise valid run
    below the configured hard floor. Such 100–200 ms labels are almost always
    a spectral crossover, not an audible chord, and must not reach the chart.
    """

    result = [dict(entry) for entry in chart]
    floor = max(0.0, float(minimum_seconds))
    chart_end = float(duration_seconds) if duration_seconds is not None else None

    def collapse_duplicate_neighbours() -> None:
        index = 1
        while index < len(result):
            if result[index].get("n") == result[index - 1].get("n"):
                # The earlier boundary is the audible start of this harmony.
                result.pop(index)
            else:
                index += 1

    collapse_duplicate_neighbours()
    while len(result) > 1:
        short_segments: list[tuple[int, float, int]] = []
        for index, entry in enumerate(result):
            if index + 1 < len(result):
                segment_end = float(result[index + 1].get("t") or 0.0)
            elif chart_end is not None:
                segment_end = chart_end
            else:
                continue
            duration = segment_end - float(entry.get("t") or 0.0)
            if duration + 1e-9 >= floor:
                continue
            # Prefer removing an interior blip before sacrificing a genuine
            # opening boundary. This also collapses A-short-B-short-A into the
            # original A instead of repeatedly moving the chart start forward.
            edge_penalty = 1 if index in {0, len(result) - 1} else 0
            short_segments.append((edge_penalty, duration, index))
        if not short_segments:
            break
        _edge_penalty, _duration, remove_index = min(short_segments)
        result.pop(remove_index)
        collapse_duplicate_neighbours()
    return result


def refine_reference_chord_chart_from_features(
    frame_times: Sequence[float],
    harmonic_chroma: Any,
    bass_chroma: Any | None,
    onset_strength: Any | None,
    reference_chords: Sequence[Mapping[str, Any]],
    config: ChordAnalysisConfig | None = None,
    *,
    boundary_harmonic_chroma: Any | None = None,
    boundary_bass_chroma: Any | None = None,
) -> list[dict[str, Any]]:
    """Keep curated labels/order and tighten every boundary independently."""

    np = _numpy()
    options = config or ChordAnalysisConfig()
    times = np.asarray(frame_times, dtype=np.float64)
    scores = chord_score_matrix(harmonic_chroma, bass_chroma)
    boundary_scores = (
        chord_score_matrix(boundary_harmonic_chroma, boundary_bass_chroma)
        if boundary_harmonic_chroma is not None
        else scores
    )
    frame_count = min(times.size, scores.shape[1])
    frame_count = min(frame_count, boundary_scores.shape[1])
    if frame_count < 4:
        return [{"t": round(max(0.0, float(chord["t"])), 3), "n": str(chord["n"])} for chord in reference_chords]
    times = times[:frame_count]
    scores = scores[:, :frame_count]
    boundary_scores = boundary_scores[:, :frame_count]
    onset = np.asarray(onset_strength, dtype=np.float64)[:frame_count] if onset_strength is not None else np.zeros(frame_count)
    if onset.size < frame_count:
        onset = np.pad(onset, (0, frame_count - onset.size))
    hop_seconds = float(np.median(np.diff(times))) if times.size > 1 else options.hop_length / options.sample_rate
    search_frames = max(2, int(round(options.boundary_search_seconds / max(hop_seconds, 1e-4))))
    evidence_frames = max(3, int(round(options.boundary_evidence_seconds / max(hop_seconds, 1e-4))))

    references = [
        {"t": max(0.0, float(chord.get("t") or 0.0)), "n": str(chord.get("n") or "").strip()}
        for chord in reference_chords
        if str(chord.get("n") or "").strip()
    ]
    if len(references) < 2:
        return [{**chord, "t": round(chord["t"], 3)} for chord in references]

    result = [{**chord, "t": round(chord["t"], 3)} for chord in references]
    previous_index = int(np.searchsorted(times, references[0]["t"], side="left"))
    for index in range(1, len(references)):
        previous_label = chord_template_index(references[index - 1]["n"])
        next_label = chord_template_index(references[index]["n"])
        if previous_label is None or next_label is None or previous_label == next_label:
            continue
        initial = int(np.searchsorted(times, references[index]["t"], side="left"))
        following_time = references[index + 1]["t"] if index + 1 < len(references) else float(times[-1])
        minimum_index = max(previous_index + 1, int(np.searchsorted(times, references[index - 1]["t"] + 0.08)))
        maximum_index = min(frame_count - 2, int(np.searchsorted(times, following_time - 0.08)))
        refined = refine_boundary_index(
            scores,
            previous_label,
            next_label,
            initial,
            onset,
            search_frames=search_frames,
            evidence_frames=evidence_frames,
            minimum_index=minimum_index,
            maximum_index=maximum_index,
            boundary_scores=boundary_scores,
        )
        # Reference-aware mode is intentionally conservative. A weak detector
        # can leave the human boundary alone; it may never invent/delete labels.
        if abs(refined - initial) <= search_frames:
            result[index]["t"] = round(max(0.0, float(times[refined])), 3)
            previous_index = refined
        else:
            previous_index = initial
    return result


def chord_chart_is_plausible(
    chart: Sequence[Mapping[str, Any]],
    duration_seconds: float,
    maximum_changes_per_second: float = 0.62,
) -> bool:
    if not chart:
        return False
    duration = max(0.0, float(duration_seconds))
    if duration < 30.0:
        return True
    return len(chart) <= max(16, int(duration * max(0.05, maximum_changes_per_second)))


def _pad_audio(signals: Sequence[Any]) -> list[Any]:
    np = _numpy()
    if not signals:
        return []
    length = max(int(signal.size) for signal in signals)
    return [np.pad(signal, (0, length - signal.size)) if signal.size < length else signal for signal in signals]


def _robust_unit_curve(values: Any, frame_count: int) -> Any:
    """Scale one non-negative timing cue without one extreme hit owning it."""

    np = _numpy()
    curve = np.maximum(0.0, np.asarray(values, dtype=np.float64).reshape(-1))
    if curve.size < frame_count:
        curve = np.pad(curve, (0, frame_count - curve.size))
    curve = curve[:frame_count]
    positive = curve[curve > 0]
    scale = float(np.quantile(positive, 0.92)) if positive.size else 0.0
    if scale <= 1e-10:
        return np.zeros(frame_count, dtype=np.float64)
    return np.clip(curve / scale, 0.0, 1.5)


def _fused_boundary_cue(
    harmonic_onset: Any,
    bass_onset: Any | None,
    harmonic_chroma: Any,
    bass_chroma: Any | None,
    frame_count: int,
) -> Any:
    """Combine audible attacks and non-percussive harmonic crossings.

    The cue is never used to choose a chord label. It only resolves where the
    independently detected old/new harmony crosses, so beat or attack errors
    cannot invent a different chord.
    """

    np = _numpy()
    harmonic_attack = _robust_unit_curve(harmonic_onset, frame_count)
    bass_attack = (
        _robust_unit_curve(bass_onset, frame_count)
        if bass_onset is not None
        else np.zeros(frame_count, dtype=np.float64)
    )
    harmonic = normalize_chroma(harmonic_chroma)[:, :frame_count]
    harmonic_flux = np.zeros(frame_count, dtype=np.float64)
    if harmonic.shape[1] > 1:
        harmonic_flux[1:] = np.abs(np.diff(harmonic, axis=1)).sum(axis=0)
    harmonic_change = _robust_unit_curve(harmonic_flux, frame_count)

    bass_change = np.zeros(frame_count, dtype=np.float64)
    if bass_chroma is not None:
        bass = normalize_chroma(bass_chroma)[:, :frame_count]
        if bass.shape[1] > 1:
            bass_flux = np.zeros(frame_count, dtype=np.float64)
            bass_flux[1:] = np.abs(np.diff(bass, axis=1)).sum(axis=0)
            bass_change = _robust_unit_curve(bass_flux, frame_count)

    # Max keeps the true bass/pluck attack sharp; the weighted blend still
    # exposes legato/pad changes which have no strong transient.
    return np.maximum.reduce((
        harmonic_attack,
        bass_attack * 0.92,
        harmonic_change * 0.78,
        bass_change * 0.68,
    ))


def chroma_by_beat(chroma: Any, frame_times: Any, beat_times: Sequence[float]) -> Any:
    """Svedi hromagramu na jednu kolonu po dobi (medijana preko trajanja dobe).

    Ovo je jedina izmena koja sama po sebi najviše smanjuje šum: umesto 86
    odluka u sekundi donosi se jedna po dobi, nad medijanom koja preživljava
    pojedinačne perkusivne udare i prelazne tonove melodije.
    """

    np = _numpy()
    values = np.asarray(chroma, dtype=np.float64)
    times = np.asarray(frame_times, dtype=np.float64)
    beats = [float(value) for value in beat_times]
    if values.ndim != 2 or values.shape[1] == 0 or len(beats) < 2:
        return np.zeros((values.shape[0] if values.ndim == 2 else 12, 0), dtype=np.float64)

    edges = np.searchsorted(times, np.asarray(beats, dtype=np.float64))
    columns = []
    for index in range(len(beats) - 1):
        start = int(min(max(0, edges[index]), values.shape[1] - 1))
        end = int(min(max(start + 1, edges[index + 1]), values.shape[1]))
        columns.append(np.median(values[:, start:end], axis=1))
    return np.stack(columns, axis=1) if columns else np.zeros((values.shape[0], 0), dtype=np.float64)


def snap_chart_to_grid(
    chart: Sequence[Mapping[str, Any]],
    beats: Sequence[float],
    tolerance: float = 0.1,
) -> list[dict[str, Any]]:
    """Pull each boundary onto a beat, but only when a beat is already close.

    A boundary that is within one tolerance of a beat is almost certainly meant
    to be on it, and moving it there removes detector jitter. A boundary that is
    further away is either an anticipated change (the band pushes ahead of the
    beat, which is normal playing) or a beat that the grid placed wrong, and in
    both cases the audio is the better authority than the grid.

    Measured on real stems, per boundary distance from the audible harmonic
    change: no snapping 75.5 ms, this snap at 100 ms tolerance 72.5 ms, at
    150 ms 101.7 ms, snapping unconditionally 150.8 ms.
    """

    items = [dict(item) for item in chart]
    times = [float(value) for value in beats]
    if not items or len(times) < 2 or tolerance <= 0.0:
        return items

    import bisect

    for item in items:
        moment = float(item.get("t", 0.0))
        position = bisect.bisect_left(times, moment)
        best = None
        best_distance = tolerance
        for index in (position - 1, position, position + 1):
            if 0 <= index < len(times):
                distance = abs(times[index] - moment)
                if distance <= best_distance:
                    best_distance = distance
                    best = times[index]
        if best is not None:
            item["t"] = round(best, 3)

    # Two boundaries can land on the same beat once they are moved. Keeping the
    # first preserves the earlier harmonic evidence, which is what was heard.
    merged: list[dict[str, Any]] = []
    for item in items:
        if merged and abs(float(item["t"]) - float(merged[-1]["t"])) < 1e-6:
            continue
        if merged and merged[-1].get("n") == item.get("n"):
            continue
        merged.append(item)

    beat_seconds = _median_beat_seconds(times)
    # 0.25 dobe, ne vise: mereno, akordi od ~0.6 dobe sede TACNO na cujnim
    # harmonskim udarima (uklanjanje im je pogorsalo medijanu sa 105 na 139 ms),
    # dakle to su stvarni prolazni akordi na osmini, a ne treperenje dekodera.
    return drop_flicker_chords(merged, 0.25 * beat_seconds if beat_seconds else 0.15)


def _median_beat_seconds(beats: Sequence[float]) -> float:
    intervals = sorted(beats[index + 1] - beats[index] for index in range(len(beats) - 1))
    if not intervals:
        return 0.0
    return float(intervals[len(intervals) // 2])


def drop_flicker_chords(
    chart: Sequence[Mapping[str, Any]],
    minimum_seconds: float,
) -> list[dict[str, Any]]:
    """Drop a chord that does not last long enough to be one.

    A segment shorter than roughly half a beat is a decoder flicker, not a
    harmonic change: the previous chord simply keeps sounding through it. Three
    of these in a song is a small number and a very audible one, because the
    player reads a change that nobody played.
    """

    items = [dict(item) for item in chart]
    if len(items) < 2 or minimum_seconds <= 0.0:
        return items

    kept: list[dict[str, Any]] = [items[0]]
    for index in range(1, len(items)):
        duration = (
            float(items[index + 1]["t"]) - float(items[index]["t"])
            if index + 1 < len(items)
            else minimum_seconds
        )
        if duration < minimum_seconds:
            continue
        if kept and kept[-1].get("n") == items[index].get("n"):
            continue
        kept.append(items[index])
    return kept


def build_beat_synchronous_chart(
    beat_times: Sequence[float],
    beat_harmonic_chroma: Any,
    beat_bass_chroma: Any | None,
    *,
    beats_per_bar: int,
    downbeat_index: int,
    key: Mapping[str, Any] | None = None,
    config: ChordAnalysisConfig | None = None,
) -> list[dict[str, Any]]:
    """Harta akorda čije granice po konstrukciji leže na dobama."""

    np = _numpy()
    options = config or ChordAnalysisConfig()
    beats = [float(value) for value in beat_times]
    harmonic = np.asarray(beat_harmonic_chroma, dtype=np.float64)
    if harmonic.ndim != 2 or harmonic.shape[1] < 2:
        return []
    count = min(harmonic.shape[1], len(beats) - 1)
    if count < 2:
        return []
    harmonic = harmonic[:, :count]
    bass = None
    if beat_bass_chroma is not None:
        bass = np.asarray(beat_bass_chroma, dtype=np.float64)[:, :count]

    scores = chord_score_matrix(harmonic, bass)
    scores = scores + key_prior_vector(key)[:, None]

    bar = max(1, int(beats_per_bar))
    phase = int(downbeat_index) % bar
    positions = [(index - phase) % bar for index in range(count)]
    labels = decode_beat_chords(scores, positions, bar, options.beat_switch_penalty)

    chart: list[dict[str, Any]] = []
    start = 0
    for index in range(1, count + 1):
        if index < count and labels[index] == labels[start]:
            continue
        template = CHORD_TEMPLATES[int(labels[start])]
        chart.append({"t": round(beats[start], 3), "n": template.name})
        start = index

    # Susedni identični akordi nastaju kad se ime ponovi preko granice takta.
    merged: list[dict[str, Any]] = []
    for item in chart:
        if merged and merged[-1]["n"] == item["n"]:
            continue
        merged.append(item)
    return merged


def extract_chord_chart(
    stems: Mapping[str, Path],
    progress: Callable[[str, str, str], None] | None = None,
    config: ChordAnalysisConfig | None = None,
    reference_chords: Sequence[Mapping[str, Any]] | None = None,
    beat_grid: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Analyze aligned Demucs stems and return mix-time chord boundaries."""

    np = _numpy()
    try:
        import librosa
        from scipy.ndimage import binary_closing, binary_opening
    except ImportError as exc:  # pragma: no cover - explicit runtime dependency
        raise RuntimeError("librosa and scipy are required for chord analysis.") from exc

    options = config or ChordAnalysisConfig()
    harmonic_paths = [(name, Path(stems[name])) for name in ("piano", "guitar", "other") if stems.get(name)]
    if not harmonic_paths:
        return []
    if progress:
        progress("analyzing", "chord-analysis", "Detecting stable chords and audible change boundaries.")

    harmonic_signals = []
    weights = []
    for name, path in harmonic_paths:
        signal, _sample_rate = librosa.load(path, sr=options.sample_rate, mono=True)
        if signal.size:
            harmonic_signals.append(signal.astype(np.float32, copy=False))
            weights.append(0.42 if name == "other" and len(harmonic_paths) > 1 else 1.0)
    if not harmonic_signals:
        return []
    padded = _pad_audio(harmonic_signals)
    harmonic_audio = sum(signal * weight for signal, weight in zip(padded, weights, strict=True))
    harmonic_audio /= max(1.0, sum(weights))

    bass_audio = None
    bass_path = stems.get("bass")
    if bass_path:
        bass_audio, _sample_rate = librosa.load(Path(bass_path), sr=options.sample_rate, mono=True)
        bass_audio = bass_audio.astype(np.float32, copy=False)
        if bass_audio.size < harmonic_audio.size:
            bass_audio = np.pad(bass_audio, (0, harmonic_audio.size - bass_audio.size))
        else:
            bass_audio = bass_audio[:harmonic_audio.size]

    # Use one tuning estimate for every stem. Letting each separated channel
    # choose a slightly different tuning rotates their chroma bins against one
    # another and weakens the exact crossover used for boundaries.
    try:
        tuning = float(librosa.estimate_tuning(y=harmonic_audio, sr=options.sample_rate))
    except Exception:
        tuning = 0.0

    harmonic_chroma = librosa.feature.chroma_cqt(
        y=harmonic_audio,
        sr=options.sample_rate,
        hop_length=options.hop_length,
        fmin=librosa.note_to_hz("C2"),
        n_octaves=6,
        bins_per_octave=36,
        tuning=tuning,
        norm=None,
    )
    bass_chroma = None
    if bass_audio is not None and bass_audio.size:
        bass_chroma = librosa.feature.chroma_cqt(
            y=bass_audio,
            sr=options.sample_rate,
            hop_length=options.hop_length,
            fmin=librosa.note_to_hz("C1"),
            n_octaves=4,
            bins_per_octave=36,
            tuning=tuning,
            norm=None,
        )

    # CQT gives robust labels, especially in the bass, but its long low-note
    # windows smear the time at which a change happens. A centred short-window
    # chromagram is used only for boundary localisation.
    boundary_harmonic_chroma = librosa.feature.chroma_stft(
        y=harmonic_audio,
        sr=options.sample_rate,
        hop_length=options.hop_length,
        n_fft=2048,
        tuning=tuning,
        norm=None,
    )
    boundary_bass_chroma = None
    if bass_audio is not None and bass_audio.size:
        boundary_bass_chroma = librosa.feature.chroma_stft(
            y=bass_audio,
            sr=options.sample_rate,
            hop_length=options.hop_length,
            n_fft=4096,
            tuning=tuning,
            norm=None,
        )

    frame_count = harmonic_chroma.shape[1]
    if bass_chroma is not None:
        frame_count = min(frame_count, bass_chroma.shape[1])
    frame_count = min(frame_count, boundary_harmonic_chroma.shape[1])
    if boundary_bass_chroma is not None:
        frame_count = min(frame_count, boundary_bass_chroma.shape[1])
    harmonic_chroma = harmonic_chroma[:, :frame_count]
    if bass_chroma is not None:
        bass_chroma = bass_chroma[:, :frame_count]
    boundary_harmonic_chroma = boundary_harmonic_chroma[:, :frame_count]
    if boundary_bass_chroma is not None:
        boundary_bass_chroma = boundary_bass_chroma[:, :frame_count]
    frame_times = librosa.frames_to_time(
        np.arange(frame_count),
        sr=options.sample_rate,
        hop_length=options.hop_length,
    )

    boundary_audio = harmonic_audio if bass_audio is None else harmonic_audio + bass_audio * 0.45
    harmonic_onset = librosa.onset.onset_strength(
        y=harmonic_audio,
        sr=options.sample_rate,
        hop_length=options.hop_length,
        center=True,
    )[:frame_count]
    bass_onset = None
    if bass_audio is not None and bass_audio.size:
        bass_onset = librosa.onset.onset_strength(
            y=bass_audio,
            sr=options.sample_rate,
            hop_length=options.hop_length,
            center=True,
        )[:frame_count]
    onset = _fused_boundary_cue(
        harmonic_onset,
        bass_onset,
        boundary_harmonic_chroma,
        boundary_bass_chroma,
        frame_count,
    )
    rms = librosa.feature.rms(y=boundary_audio, hop_length=options.hop_length, center=True)[0][:frame_count]
    if rms.size < frame_count:
        rms = np.pad(rms, (0, frame_count - rms.size))
    nonzero = rms[rms > 1e-8]
    if nonzero.size:
        threshold = max(float(np.quantile(nonzero, 0.12)) * 1.25, float(rms.max()) * 0.012)
        active = rms >= threshold
        closing_frames = max(1, int(round(0.24 * options.sample_rate / options.hop_length)))
        opening_frames = max(1, int(round(0.16 * options.sample_rate / options.hop_length)))
        active = binary_closing(active, structure=np.ones(closing_frames, dtype=bool))
        active = binary_opening(active, structure=np.ones(opening_frames, dtype=bool))
    else:
        active = np.zeros(frame_count, dtype=bool)

    # Granice se traže u slobodnom vremenu, pa se tek onda privlače na mrežu.
    # Mereno prema trenutku kad se harmonija čuje (napad basa): slobodno vreme
    # promašuje za 75 ms, isto to zalepljeno za najbližu dobu za 151 ms, a
    # odlučivanje po dobi za 218 ms. Razlog je muzički, ne tehnički — harmonske
    # promene u ovom repertoaru leže oko 85 ms pored dobe, a samo 5-9% njih pada
    # na prvu dobu takta, pa mreža kao obavezna rešetka premešta granicu dalje
    # od onoga što se čuje.
    grid_beats = [float(value) for value in ((beat_grid or {}).get("beats") or [])]

    # How long a chord has to last before it is believed. The limit was written
    # in seconds, and 0.90 s was chosen while this song was thought to run at
    # 152 BPM, where it means a little over two beats. At its real 115 BPM the
    # same number silently became 1.7 beats, so a chord held for a beat and a
    # half was deleted for being too short — including one a musician heard and
    # had to put back by hand. A chord shorter than a beat is worth doubting; a
    # chord of a beat and a half is ordinary music, whatever the tempo.
    # A beat and a half, measured against a musician's corrections on real
    # material: at 1.73 beats (the old fixed 0.90 s) five chords he could hear
    # were deleted; at 1.5 beats three of them return and eight new ones appear
    # for him to judge; below that the count climbs without recovering more.
    beat_seconds = _median_beat_seconds(grid_beats)
    if beat_seconds > 0.0:
        minimum_seconds = max(0.40, round(1.5 * beat_seconds, 3))
        options = replace(
            options,
            minimum_segment_seconds=minimum_seconds,
            hard_minimum_segment_seconds=max(0.18, round(0.5 * minimum_seconds, 3)),
        )

    if reference_chords:
        return refine_reference_chord_chart_from_features(
            frame_times,
            harmonic_chroma,
            bass_chroma,
            onset,
            reference_chords,
            options,
            boundary_harmonic_chroma=boundary_harmonic_chroma,
            boundary_bass_chroma=boundary_bass_chroma,
        )
    chart = build_chord_chart_from_features(
        frame_times,
        harmonic_chroma,
        bass_chroma,
        onset,
        active,
        options,
        boundary_harmonic_chroma=boundary_harmonic_chroma,
        boundary_bass_chroma=boundary_bass_chroma,
    )
    duration = float(frame_times[-1]) if len(frame_times) else 0.0
    # A major/minor practice chart denser than roughly one change per 1.6 s is
    # almost always following melodic notes rather than harmony. Do not let a
    # pathological result replace a user's chart; the client can keep/fallback.
    if not chord_chart_is_plausible(chart, duration):
        return []
    return snap_chart_to_grid(chart, grid_beats, options.grid_snap_seconds)
