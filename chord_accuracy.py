"""How far the machine's chord chart sits from a musician's corrected one.

The published metrics for chord recognition (MIREX weighted chord symbol
recall, and the segmentation scores in ``mir_eval.chord``) are duration
weighted: they ask how much of the song carries the right label. A chart whose
every boundary is 150 ms late scores almost as well as a perfect one, because
only the sliver between the true change and the late one is counted wrong.

That is exactly the error a player hears first, so this module measures the
thing those scores hide: the signed distance from each corrected boundary to
the machine's nearest attempt, in milliseconds, with the sign kept. Early and
late are different mistakes — a band pushing a chord ahead of the beat is
normal playing, while a chord arriving after the beat is never right — and a
metric that takes the absolute value cannot tell them apart.

Nothing here needs annotation work. The reference is whatever the user already
corrected by ear in the app, which the service stores next to the machine's
own attempt.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence


# Roughly a beat at a medium tempo. A candidate further away than this is not a
# late version of the same chord change, it is a different event.
DEFAULT_MATCH_WINDOW_SECONDS = 0.6


def _clean(chart: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for item in chart or []:
        if not isinstance(item, Mapping):
            continue
        try:
            time = float(item.get("t"))
        except (TypeError, ValueError):
            continue
        name = str(item.get("n") or "").strip()
        if not name or time < 0.0:
            continue
        cleaned.append({"t": time, "n": name})
    cleaned.sort(key=lambda entry: entry["t"])
    return cleaned


def chord_root(name: str) -> str:
    """The root of a chord name, ignoring quality.

    Wrong root and wrong quality are different failures: a wrong root is a
    wrong chord, while ``Dm`` where the song plays ``Dm7`` is the same harmony
    described more simply.
    """

    text = str(name or "").strip()
    if not text:
        return ""
    root = text[0].upper()
    rest = text[1:]
    lowered = rest.lower()
    if lowered.startswith("is"):
        # Serbian sharps: Cis, Dis, Fis, Gis, Ais.
        return root + "is"
    if rest[:1] in ("#", "b"):
        return root + rest[0]
    if lowered.startswith("s") and not lowered.startswith("sus"):
        # Serbian flats: Es, As. "sus" is a quality, not an accidental — the
        # difference between As and Asus4 is a different chord, not a spelling.
        return root + "s"
    return root


def compare_charts(
    reference: Sequence[Mapping[str, Any]],
    candidate: Sequence[Mapping[str, Any]],
    *,
    window_seconds: float = DEFAULT_MATCH_WINDOW_SECONDS,
) -> dict[str, Any]:
    """Score a machine chart against a chart a musician corrected.

    Every reference boundary is matched to the nearest unused candidate inside
    the window, nearest first, so one candidate cannot answer for two changes.
    """

    truth = _clean(reference)
    guess = _clean(candidate)
    if not truth:
        return {
            "status": "no-reference",
            "message": "Nema ispravljene tabele akorada za poređenje.",
            "referenceCount": 0,
            "candidateCount": len(guess),
        }

    pairs: list[tuple[float, int, int]] = []
    for truth_index, truth_item in enumerate(truth):
        for guess_index, guess_item in enumerate(guess):
            distance = abs(guess_item["t"] - truth_item["t"])
            if distance <= window_seconds:
                pairs.append((distance, truth_index, guess_index))
    pairs.sort()

    matched_truth: dict[int, int] = {}
    used_guess: set[int] = set()
    for _distance, truth_index, guess_index in pairs:
        if truth_index in matched_truth or guess_index in used_guess:
            continue
        matched_truth[truth_index] = guess_index
        used_guess.add(guess_index)

    offsets: list[float] = []
    wrong_name: list[dict[str, Any]] = []
    wrong_root: list[dict[str, Any]] = []
    worst: list[dict[str, Any]] = []
    for truth_index, guess_index in sorted(matched_truth.items()):
        truth_item, guess_item = truth[truth_index], guess[guess_index]
        offset = guess_item["t"] - truth_item["t"]
        offsets.append(offset)
        worst.append(
            {
                "t": round(truth_item["t"], 3),
                "reference": truth_item["n"],
                "candidate": guess_item["n"],
                "offsetMs": round(offset * 1000.0, 1),
            }
        )
        if guess_item["n"] != truth_item["n"]:
            entry = {
                "t": round(truth_item["t"], 3),
                "reference": truth_item["n"],
                "candidate": guess_item["n"],
            }
            wrong_name.append(entry)
            if chord_root(guess_item["n"]) != chord_root(truth_item["n"]):
                wrong_root.append(entry)

    missing = [
        {"t": round(truth[index]["t"], 3), "n": truth[index]["n"]}
        for index in range(len(truth))
        if index not in matched_truth
    ]
    extra = [
        {"t": round(guess[index]["t"], 3), "n": guess[index]["n"]}
        for index in range(len(guess))
        if index not in used_guess
    ]

    worst.sort(key=lambda entry: abs(entry["offsetMs"]), reverse=True)

    def median(values: Sequence[float]) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        middle = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[middle]
        return 0.5 * (ordered[middle - 1] + ordered[middle])

    absolute = [abs(value) for value in offsets]
    return {
        "status": "ok",
        "referenceCount": len(truth),
        "candidateCount": len(guess),
        "matched": len(offsets),
        # Signed: positive means the machine put the change after the musician
        # did, which is the direction that sounds wrong.
        "medianOffsetMs": round(median(offsets) * 1000.0, 1),
        "medianAbsoluteOffsetMs": round(median(absolute) * 1000.0, 1),
        "within50Ms": round(sum(1 for value in absolute if value <= 0.050) / len(absolute), 4) if absolute else 0.0,
        "within100Ms": round(sum(1 for value in absolute if value <= 0.100) / len(absolute), 4) if absolute else 0.0,
        "lateShare": round(sum(1 for value in offsets if value > 0.020) / len(offsets), 4) if offsets else 0.0,
        "missingCount": len(missing),
        "extraCount": len(extra),
        "wrongNameCount": len(wrong_name),
        "wrongRootCount": len(wrong_root),
        "missing": missing[:40],
        "extra": extra[:40],
        "wrongNames": wrong_name[:40],
        "worstOffsets": worst[:20],
    }


def summarise(report: Mapping[str, Any]) -> str:
    """One line a person can read without knowing any of the above."""

    if report.get("status") != "ok":
        return str(report.get("message") or "Nema poređenja.")
    late = "kasni" if float(report.get("medianOffsetMs") or 0) > 0 else "žuri"
    return (
        f"Prema tvojim ispravkama: {late} {abs(float(report['medianOffsetMs'])):.0f} ms u proseku, "
        f"{report['within50Ms'] * 100:.0f}% granica unutar 50 ms, "
        f"fali {report['missingCount']}, višak {report['extraCount']}, "
        f"pogrešno imenovano {report['wrongNameCount']}."
    )
