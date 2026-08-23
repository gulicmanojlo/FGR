import unittest

import numpy as np

from chord_pipeline import (
    CHORD_QUALITIES,
    CHORD_TEMPLATES,
    build_beat_synchronous_chart,
    estimate_key,
    key_prior_vector,
    ChordAnalysisConfig,
    build_chord_chart_from_features,
    chord_score_matrix,
    chord_chart_is_plausible,
    decode_chord_frames,
    enforce_hard_minimum_chart_segments,
    refine_boundary_index,
    refine_reference_chord_chart_from_features,
)


def template_index(name):
    return next(index for index, template in enumerate(CHORD_TEMPLATES) if template.name == name)


def synthetic_chroma(times, sections):
    harmonic = np.full((12, len(times)), 0.004, dtype=np.float64)
    bass = np.full_like(harmonic, 0.001)
    tone_map = {
        "C": (0, (0, 4, 7)),
        "F": (5, (5, 9, 0)),
        "G": (7, (7, 11, 2)),
        "Am": (9, (9, 0, 4)),
    }
    for index, time in enumerate(times):
        name = next(name for start, end, name in sections if start <= time < end)
        root, tones = tone_map[name]
        harmonic[list(tones), index] = (1.0, 0.88, 0.78)
        bass[root, index] = 1.0
    return harmonic, bass


def chroma_from_tones(sequence, strength=1.0, noise=0.004):
    """Hromagrama u kojoj svaka kolona sadrzi zadate tonske klase."""
    columns = []
    for tones in sequence:
        column = np.full(12, noise)
        for order, tone in enumerate(tones):
            column[tone % 12] = strength * (1.0 - 0.06 * order)
        columns.append(column)
    return np.stack(columns, axis=1)


class ChordVocabularyTests(unittest.TestCase):
    def test_every_quality_exists_on_every_root(self):
        self.assertEqual(len(CHORD_TEMPLATES), 12 * len(CHORD_QUALITIES))
        names = {template.name for template in CHORD_TEMPLATES}
        for expected in ("C", "Cm", "G7", "Dm7", "Fmaj7", "Hdim", "Asus4", "C6", "Dism7b5"):
            self.assertIn(expected, names, f"nedostaje {expected}")

    def test_a_seventh_is_recognised_when_the_seventh_sounds(self):
        # G7 = G H D F. Bez septime mora ostati obican G dur.
        with_seventh = chroma_from_tones([(7, 11, 2, 5)])
        without = chroma_from_tones([(7, 11, 2)])
        best = lambda chroma: CHORD_TEMPLATES[int(np.argmax(chord_score_matrix(chroma)[:, 0]))].name
        self.assertEqual(best(with_seventh), "G7")
        self.assertEqual(best(without), "G")

    def test_a_missing_seventh_does_not_win_by_covering_more(self):
        # Kljucna zamka prosirenog recnika: cetvorozvuk ne sme da pobedi samo
        # zato sto ima vise tonova na koje moze da "pokupi" energiju.
        triad = chroma_from_tones([(0, 4, 7)])
        scores = chord_score_matrix(triad)[:, 0]
        by_name = {template.name: scores[index] for index, template in enumerate(CHORD_TEMPLATES)}
        self.assertGreater(by_name["C"], by_name["C7"])
        self.assertGreater(by_name["C"], by_name["Cmaj7"])
        self.assertGreater(by_name["C"], by_name["C6"])

    def test_suspended_and_diminished_are_reachable(self):
        best = lambda tones: CHORD_TEMPLATES[
            int(np.argmax(chord_score_matrix(chroma_from_tones([tones]))[:, 0]))
        ].name
        self.assertEqual(best((0, 5, 7)), "Csus4")
        self.assertEqual(best((0, 3, 6)), "Cdim")


class KeyEstimationTests(unittest.TestCase):
    def test_c_major_material_is_read_as_c_major(self):
        progression = [(0, 4, 7), (5, 9, 0), (7, 11, 2), (0, 4, 7)] * 8
        key = estimate_key(chroma_from_tones(progression))
        self.assertEqual(key["tonic"], 0)
        self.assertFalse(key["minor"])

    def test_a_minor_material_is_read_as_minor(self):
        progression = [(9, 0, 4), (2, 5, 9), (4, 8, 11), (9, 0, 4)] * 8
        key = estimate_key(chroma_from_tones(progression))
        self.assertTrue(key["minor"])
        self.assertEqual(key["tonic"], 9)

    def test_empty_material_has_no_key(self):
        self.assertEqual(estimate_key(np.zeros((12, 0)))["confidence"], 0.0)
        self.assertEqual(estimate_key(np.zeros((12, 8)))["confidence"], 0.0)

    def test_the_prior_favours_diatonic_chords_without_banning_others(self):
        key = {"tonic": 0, "minor": False, "confidence": 1.0}
        bonus = key_prior_vector(key)
        by_name = {t.name: bonus[i] for i, t in enumerate(CHORD_TEMPLATES)}
        self.assertGreater(by_name["G"], by_name["Gis"], "dijatonski akord ima prednost")
        self.assertGreaterEqual(by_name["Gis"], 0.0, "vandijatonski akord nije kaznjen")

    def test_an_unknown_key_changes_nothing(self):
        self.assertTrue(np.all(key_prior_vector(None) == 0.0))
        self.assertTrue(np.all(key_prior_vector({"tonic": 0, "minor": False, "confidence": 0.0}) == 0.0))


class BeatSynchronousChordTests(unittest.TestCase):
    def beats(self, count, step=0.5, start=0.0):
        return [start + index * step for index in range(count)]

    def test_boundaries_land_exactly_on_beats(self):
        beats = self.beats(33)
        tones = [(0, 4, 7)] * 16 + [(5, 9, 0)] * 16
        chart = build_beat_synchronous_chart(
            beats, chroma_from_tones(tones), None, beats_per_bar=4, downbeat_index=0
        )
        self.assertEqual([item["n"] for item in chart], ["C", "F"])
        for item in chart:
            self.assertIn(item["t"], [round(value, 3) for value in beats])

    def test_a_change_prefers_the_downbeat_over_a_late_beat(self):
        # Dokaz da kazna zavisna od mesta u taktu radi: dvosmislen prelaz
        # izmedju dobe 15 i 16 mora da padne na taktovu crtu (doba 16).
        beats = self.beats(33)
        tones = [(0, 4, 7)] * 15 + [(0, 4, 7, 5)] + [(5, 9, 0)] * 17
        chart = build_beat_synchronous_chart(
            beats, chroma_from_tones(tones), None, beats_per_bar=4, downbeat_index=0
        )
        changes = [item["t"] for item in chart[1:]]
        self.assertTrue(changes, "mora postojati promena akorda")
        self.assertAlmostEqual(changes[0], 8.0, places=3, msg="promena pada na taktovu crtu")

    def test_the_bass_channel_decides_the_root(self):
        beats = self.beats(17)
        harmonic = chroma_from_tones([(0, 4, 7, 9)] * 16)
        bass = chroma_from_tones([(9,)] * 16)
        chart = build_beat_synchronous_chart(
            beats, harmonic, bass, beats_per_bar=4, downbeat_index=0
        )
        self.assertTrue(chart[0]["n"].startswith("A"), f"bas bira osnovu, dobijeno {chart[0]['n']}")

    def test_too_little_material_yields_no_chart(self):
        self.assertEqual(build_beat_synchronous_chart([0.0], np.zeros((12, 0)), None,
                                                      beats_per_bar=4, downbeat_index=0), [])

    def test_repeated_labels_are_merged(self):
        beats = self.beats(25)
        chart = build_beat_synchronous_chart(
            beats, chroma_from_tones([(0, 4, 7)] * 24), None, beats_per_bar=4, downbeat_index=0
        )
        self.assertEqual(len(chart), 1, "isti akord kroz celu pesmu je jedan segment")


class ChordPipelineTests(unittest.TestCase):
    def test_boundary_snapping_cannot_leave_a_subfloor_chord(self):
        chart = [
            {"t": 4.0, "n": "Dm", "confidence": 0.7},
            {"t": 5.0, "n": "D", "confidence": 0.52},
            {"t": 5.198, "n": "Gm", "confidence": 0.76},
            {"t": 6.4, "n": "A", "confidence": 0.65},
        ]

        cleaned = enforce_hard_minimum_chart_segments(chart, 0.28)

        self.assertEqual([entry["n"] for entry in cleaned], ["Dm", "Gm", "A"])

    def test_hard_minimum_collapses_short_a_b_a_without_moving_opening(self):
        chart = [
            {"t": 0.0, "n": "Am"},
            {"t": 0.12, "n": "H"},
            {"t": 0.22, "n": "Am"},
            {"t": 1.6, "n": "Dm"},
        ]

        cleaned = enforce_hard_minimum_chart_segments(chart, 0.28, duration_seconds=3.0)

        self.assertEqual(cleaned, [
            {"t": 0.0, "n": "Am"},
            {"t": 1.6, "n": "Dm"},
        ])

    def test_hard_minimum_checks_final_chord_against_song_duration(self):
        chart = [
            {"t": 0.0, "n": "C"},
            {"t": 2.0, "n": "G"},
            {"t": 3.86, "n": "Fis"},
        ]

        cleaned = enforce_hard_minimum_chart_segments(chart, 0.28, duration_seconds=4.0)

        self.assertEqual([entry["n"] for entry in cleaned], ["C", "G"])

    def test_density_gate_rejects_melodic_note_chasing(self):
        dense = [{"t": index * 0.5, "n": "C" if index % 2 else "G"} for index in range(120)]
        stable = [{"t": index * 2.0, "n": "C" if index % 2 else "G"} for index in range(30)]
        self.assertFalse(chord_chart_is_plausible(dense, 60.0))
        self.assertTrue(chord_chart_is_plausible(stable, 60.0))

    def test_viterbi_rejects_one_frame_wrong_chord(self):
        frames = 100
        scores = np.full((len(CHORD_TEMPLATES), frames), -0.2)
        c_index = template_index("C")
        g_index = template_index("G")
        scores[c_index] = 0.8
        scores[g_index, 40] = 1.02
        scores[c_index, 40] = 0.79

        labels = decode_chord_frames(scores, switch_penalty=0.13)

        self.assertTrue(np.all(labels == c_index))

    def test_individual_boundary_is_recovered_without_global_offset(self):
        hop = 0.02
        times = np.arange(0.0, 3.0, hop) + hop / 2
        harmonic, bass = synthetic_chroma(times, [(0.0, 1.2, "C"), (1.2, 3.0, "G")])
        scores = chord_score_matrix(harmonic, bass)
        onset = np.zeros(times.size)
        true_index = int(np.searchsorted(times, 1.2))
        onset[true_index] = 1.0

        refined = refine_boundary_index(
            scores,
            template_index("C"),
            template_index("G"),
            initial_index=int(np.searchsorted(times, 1.56)),
            onset_strength=onset,
            search_frames=24,
            evidence_frames=22,
        )

        self.assertLessEqual(abs(times[refined] - 1.2), hop)

    def test_short_window_boundary_evidence_corrects_smeared_label_change(self):
        hop = 0.02
        times = np.arange(0.0, 3.2, hop) + hop / 2
        # The robust label feature changes late, as a long low-frequency CQT
        # window can on real audio. The independent timing chroma crosses on
        # the audible attack and must own the displayed boundary.
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.38, "C"), (1.38, 3.2, "G")],
        )
        boundary_harmonic, boundary_bass = synthetic_chroma(
            times,
            [(0.0, 1.20, "C"), (1.20, 3.2, "G")],
        )
        onset = np.zeros(times.size)
        onset[int(np.searchsorted(times, 1.20))] = 1.0

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            np.ones(times.size, dtype=bool),
            boundary_harmonic_chroma=boundary_harmonic,
            boundary_bass_chroma=boundary_bass,
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "G"])
        self.assertLessEqual(abs(chart[1]["t"] - 1.20), hop)

    def test_chart_has_audible_boundaries_and_keeps_real_passing_chord(self):
        hop = 0.02
        times = np.arange(0.0, 3.0, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 1.42, "F"), (1.42, 3.0, "G")],
        )
        onset = np.zeros(times.size)
        onset[int(np.searchsorted(times, 1.0))] = 1.0
        onset[int(np.searchsorted(times, 1.42))] = 0.9

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            np.ones(times.size, dtype=bool),
            ChordAnalysisConfig(
                minimum_segment_seconds=0.36,
                boundary_search_seconds=0.44,
                boundary_evidence_seconds=0.42,
            ),
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "F", "G"])
        self.assertLessEqual(abs(chart[1]["t"] - 1.0), hop)
        self.assertLessEqual(abs(chart[2]["t"] - 1.42), hop)

    def test_default_two_tier_merge_keeps_supported_420ms_passing_chord(self):
        hop = 0.02
        times = np.arange(0.0, 3.0, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 1.42, "F"), (1.42, 3.0, "G")],
        )
        onset = np.zeros(times.size)
        onset[int(np.searchsorted(times, 1.0))] = 1.0
        onset[int(np.searchsorted(times, 1.42))] = 0.9

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            np.ones(times.size, dtype=bool),
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "F", "G"])

    def test_hard_floor_rejects_even_strong_220ms_chord(self):
        hop = 0.02
        times = np.arange(0.0, 2.6, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 1.22, "Am"), (1.22, 2.6, "G")],
        )
        onset = np.zeros(times.size)
        onset[int(np.searchsorted(times, 1.0))] = 1.0
        onset[int(np.searchsorted(times, 1.22))] = 1.0

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            np.ones(times.size, dtype=bool),
        )

        self.assertNotIn("Am", [entry["n"] for entry in chart])

    def test_missing_onset_evidence_keeps_legacy_fixed_minimum_behavior(self):
        hop = 0.02
        times = np.arange(0.0, 3.0, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 1.42, "F"), (1.42, 3.0, "G")],
        )

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            None,
            np.ones(times.size, dtype=bool),
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "G"])

    def test_deterministic_two_tier_golden_fixture(self):
        """A strong passing chord survives while two sub-floor spikes do not."""

        hop = 0.02
        times = np.arange(0.0, 5.0, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [
                (0.0, 1.4, "C"),
                (1.4, 1.82, "F"),
                (1.82, 3.0, "G"),
                (3.0, 3.22, "Am"),
                (3.22, 5.0, "G"),
            ],
        )
        onset = np.zeros(times.size)
        for boundary in (1.4, 1.82, 3.0, 3.22):
            onset[int(np.searchsorted(times, boundary))] = 1.0

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            np.ones(times.size, dtype=bool),
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "F", "G"])
        self.assertLessEqual(abs(chart[1]["t"] - 1.4), hop)
        self.assertLessEqual(abs(chart[2]["t"] - 1.82), hop)

    def test_weak_short_label_is_absorbed(self):
        hop = 0.02
        times = np.arange(0.0, 2.4, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 1.12, "F"), (1.12, 2.4, "G")],
        )
        # Make the 120 ms F evidence weak, as happens during a spectral smear.
        transient = (times >= 1.0) & (times < 1.12)
        harmonic[:, transient] = harmonic[:, transient] * 0.52 + 0.04

        chart = build_chord_chart_from_features(
            times,
            harmonic,
            bass,
            np.zeros(times.size),
            np.ones(times.size, dtype=bool),
            ChordAnalysisConfig(minimum_segment_seconds=0.36),
        )

        self.assertEqual([entry["n"] for entry in chart], ["C", "G"])

    def test_curated_chart_keeps_labels_and_refines_each_boundary(self):
        hop = 0.02
        times = np.arange(0.0, 3.2, hop) + hop / 2
        harmonic, bass = synthetic_chroma(
            times,
            [(0.0, 1.0, "C"), (1.0, 2.05, "F"), (2.05, 3.2, "G")],
        )
        onset = np.zeros(times.size)
        onset[int(np.searchsorted(times, 1.0))] = 1.0
        onset[int(np.searchsorted(times, 2.05))] = 0.9

        refined = refine_reference_chord_chart_from_features(
            times,
            harmonic,
            bass,
            onset,
            [{"t": 0.0, "n": "C"}, {"t": 1.31, "n": "F"}, {"t": 1.79, "n": "G"}],
            ChordAnalysisConfig(boundary_search_seconds=0.42, boundary_evidence_seconds=0.42),
        )

        self.assertEqual([entry["n"] for entry in refined], ["C", "F", "G"])
        self.assertLessEqual(abs(refined[1]["t"] - 1.0), hop)
        self.assertLessEqual(abs(refined[2]["t"] - 2.05), hop)


if __name__ == "__main__":
    unittest.main()
