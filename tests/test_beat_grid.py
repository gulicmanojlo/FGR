import unittest

import numpy as np

from beat_grid import (
    meter_confidence,
    BeatGridConfig,
    aggregate_by_beat,
    beat_change_cue,
    beat_grid_confidence,
    build_beat_grid,
    estimate_metric_phase,
    fold_half_time,
    summarize_tempo,
)


def steady_beats(bpm, count, start=0.0):
    interval = 60.0 / bpm
    return [start + index * interval for index in range(count)]


def accented_cue(count, beats_per_bar, phase, accent=1.0, floor=0.2):
    cue = np.full(count, floor, dtype=np.float64)
    cue[phase::beats_per_bar] = accent
    return cue


class SummarizeTempoTests(unittest.TestCase):
    def test_steady_grid_reports_its_tempo_and_full_stability(self):
        summary = summarize_tempo(steady_beats(152.0, 64))
        self.assertAlmostEqual(summary["bpm"], 152.0, places=2)
        self.assertEqual(summary["stability"], 1.0)

    def test_jittery_grid_loses_stability(self):
        rng = np.random.default_rng(7)
        beats = np.asarray(steady_beats(120.0, 64)) + rng.normal(0.0, 0.05, 64)
        summary = summarize_tempo(np.sort(beats).tolist())
        self.assertLess(summary["stability"], 0.7)

    def test_a_single_beat_cannot_define_a_tempo(self):
        self.assertEqual(summarize_tempo([1.0])["bpm"], 0.0)

    def test_frame_lattice_jitter_is_not_charged_as_instability(self):
        # Beat times snapped to a 23.2 ms analysis lattice: musically steady,
        # but every interval is off by up to one frame.
        lattice = 512 / 22_050
        beats = [round(index * (60.0 / 120.0) / lattice) * lattice for index in range(64)]
        self.assertLess(summarize_tempo(beats)["stability"], 1.0)
        self.assertEqual(summarize_tempo(beats, lattice)["stability"], 1.0)

    def test_real_tempo_drift_survives_the_lattice_allowance(self):
        drifting = [0.0]
        for index in range(64):
            drifting.append(drifting[-1] + 0.5 + index * 0.004)
        self.assertLess(summarize_tempo(drifting, 512 / 22_050)["stability"], 0.6)


class AggregateByBeatTests(unittest.TestCase):
    def test_each_beat_span_is_reduced_to_its_median(self):
        feature = np.asarray([[1.0, 1.0, 9.0, 9.0, 4.0, 4.0]])
        aggregated = aggregate_by_beat(feature, [0, 2, 4, 6])
        np.testing.assert_allclose(aggregated, [[1.0, 9.0, 4.0]])

    def test_a_zero_width_span_still_produces_one_column(self):
        feature = np.asarray([[3.0, 5.0, 7.0]])
        aggregated = aggregate_by_beat(feature, [1, 1, 3])
        self.assertEqual(aggregated.shape, (1, 2))

    def test_indices_beyond_the_feature_are_clamped(self):
        feature = np.asarray([[2.0, 2.0, 2.0]])
        aggregated = aggregate_by_beat(feature, [0, 2, 99])
        self.assertEqual(aggregated.shape, (1, 2))


class BeatChangeCueTests(unittest.TestCase):
    def test_harmony_changes_raise_the_cue_on_the_beat_they_start(self):
        chroma = np.zeros((12, 8), dtype=np.float64)
        for index in range(8):
            root = 0 if index < 4 else 5
            chroma[[root, (root + 4) % 12, (root + 7) % 12], index] = 1.0
        cue = beat_change_cue(chroma, None)
        self.assertEqual(int(np.argmax(cue)), 4)

    def test_percussive_evidence_alone_is_still_usable(self):
        onset = np.asarray([0.1, 0.1, 0.9, 0.1])
        cue = beat_change_cue(None, onset)
        self.assertEqual(int(np.argmax(cue)), 2)

    def test_no_evidence_returns_an_empty_cue(self):
        self.assertEqual(beat_change_cue(None, None).size, 0)


class MetricPhaseTests(unittest.TestCase):
    def test_four_four_phase_is_recovered(self):
        result = estimate_metric_phase(accented_cue(64, 4, 2))
        self.assertEqual(result["beatsPerBar"], 4)
        self.assertEqual(result["phase"], 2)
        self.assertGreater(result["ratio"], 1.5)

    def test_waltz_is_not_forced_into_four_four(self):
        result = estimate_metric_phase(accented_cue(63, 3, 0))
        self.assertEqual(result["beatsPerBar"], 3)
        self.assertEqual(result["phase"], 0)

    def test_a_doubled_tactus_is_reported_as_half_time(self):
        result = estimate_metric_phase(accented_cue(64, 8, 3))
        self.assertTrue(result["halfTime"])
        self.assertEqual(result["beatsPerBar"], 8)

    def test_a_perfectly_flat_cue_is_rejected(self):
        self.assertIsNone(estimate_metric_phase(np.full(64, 0.5)))

    def test_structureless_noise_scores_near_zero(self):
        # Ovo je test koji je nedostajao. Bez korekcije pristrasnosti izbora
        # obican sum je davao "odnos" od 1.5 i vise, sto je na stvarnoj pesmi
        # proizvelo lazno samopouzdanje od 100%.
        rng = np.random.default_rng(3)
        scores = []
        for _ in range(12):
            result = estimate_metric_phase(np.abs(rng.normal(1.0, 0.4, 512)))
            if result is not None:
                scores.append(result["score"])
        self.assertTrue(scores)
        self.assertLess(max(scores), 1.5, f"sum ne sme da izgleda kao takt: {max(scores):.2f}")

    def test_longer_meters_are_not_favoured_by_chance(self):
        # Duzi takt bira pobednika iz vise faza sa manje uzoraka, pa na sirovom
        # odnosu uvek dobija. Korigovani skor to mora da ponisti.
        rng = np.random.default_rng(11)
        noise = np.abs(rng.normal(1.0, 0.4, 600))
        config = BeatGridConfig(meter_candidates=(4, 12))
        result = estimate_metric_phase(noise, config)
        by_meter = {item["beatsPerBar"]: item for item in result["candidates"]}
        self.assertGreater(by_meter[12]["ratio"], by_meter[4]["ratio"], "sirov odnos favorizuje 12")
        self.assertLess(
            abs(by_meter[12]["score"] - by_meter[4]["score"]),
            abs(by_meter[12]["ratio"] - by_meter[4]["ratio"]) * 10,
            "korigovani skorovi su medjusobno uporedivi",
        )

    def test_a_real_accent_pattern_still_scores_well(self):
        result = estimate_metric_phase(accented_cue(256, 4, 1))
        self.assertEqual(result["beatsPerBar"], 4)
        self.assertEqual(result["phase"], 1)
        self.assertGreater(result["score"], 3.0, "jasan akcenat mora jasno da se izdvoji")

    def test_a_silent_cue_is_rejected(self):
        self.assertIsNone(estimate_metric_phase(np.zeros(64)))

    def test_too_few_beats_are_rejected(self):
        self.assertIsNone(estimate_metric_phase([1.0, 0.2]))


class FoldHalfTimeTests(unittest.TestCase):
    def test_folding_keeps_every_second_pulse_from_the_phase(self):
        beats, phase = fold_half_time([0.0, 0.5, 1.0, 1.5, 2.0, 2.5], 3)
        self.assertEqual(beats, [0.5, 1.5, 2.5])
        self.assertEqual(phase, 1)

    def test_an_even_phase_keeps_the_first_pulse(self):
        beats, phase = fold_half_time([0.0, 0.5, 1.0, 1.5], 2)
        self.assertEqual(beats, [0.0, 1.0])
        self.assertEqual(phase, 1)


class ConfidenceTests(unittest.TestCase):
    def test_a_steady_clear_grid_scores_high(self):
        # Drugi argument je korigovani z-skor: 2.5 je cvrsto utvrdjena prva doba.
        self.assertGreater(beat_grid_confidence(1.0, 2.5, 200), 0.9)

    def test_an_ambiguous_meter_scores_low_even_on_a_steady_pulse(self):
        # Skor nula znaci "tacno ono sto bi slucajnost dala" -> takt nije poznat.
        self.assertLess(beat_grid_confidence(1.0, 0.0, 200), 0.6)

    def test_meter_confidence_ignores_the_pulse(self):
        self.assertEqual(meter_confidence(0.0), 0.0)
        self.assertEqual(meter_confidence(2.5), 1.0)
        self.assertEqual(meter_confidence(-3.0), 0.0)


class BuildBeatGridTests(unittest.TestCase):
    def test_a_clean_four_four_song_produces_aligned_bar_lines(self):
        beats = steady_beats(120.0, 64, start=0.75)
        grid = build_beat_grid(
            beats,
            accented_cue(64, 4, 1),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertEqual(grid["status"], "ready")
        self.assertEqual(grid["beatsPerBar"], 4)
        self.assertEqual(grid["downbeatIndex"], 1)
        self.assertAlmostEqual(grid["bpm"], 120.0, places=2)
        self.assertAlmostEqual(grid["downbeats"][0], beats[1], places=3)
        self.assertEqual(len(grid["downbeats"]), 16)
        self.assertEqual(len(grid["beats"]), 64)

    def test_half_time_folding_halves_the_reported_tempo(self):
        grid = build_beat_grid(
            steady_beats(160.0, 64),
            accented_cue(64, 8, 0),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertTrue(grid["halfTimeApplied"])
        self.assertEqual(grid["beatsPerBar"], 4)
        self.assertAlmostEqual(grid["bpm"], 80.0, places=2)
        self.assertAlmostEqual(grid["rawBpm"], 160.0, places=2)
        self.assertEqual(len(grid["beats"]), 32)

    def test_an_unclear_meter_keeps_usable_beats_but_flags_the_bar_line(self):
        grid = build_beat_grid(
            steady_beats(100.0, 40),
            np.full(40, 0.5),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertEqual(grid["status"], "ready")
        self.assertEqual(grid["meterStatus"], "uncertain")
        self.assertTrue(grid["message"])

    def test_an_unsteady_pulse_is_reported_as_low_confidence(self):
        rng = np.random.default_rng(11)
        beats = np.sort(np.asarray(steady_beats(100.0, 40)) + rng.normal(0.0, 0.14, 40))
        grid = build_beat_grid(
            beats.tolist(),
            accented_cue(40, 4, 0),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertEqual(grid["status"], "low-confidence")
        self.assertTrue(grid["message"])

    def test_a_clear_grid_reports_both_layers_as_ready(self):
        grid = build_beat_grid(
            steady_beats(120.0, 64),
            accented_cue(64, 4, 0),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertEqual(grid["status"], "ready")
        self.assertEqual(grid["meterStatus"], "ready")
        self.assertEqual(grid["message"], "")

    def test_a_song_without_a_usable_pulse_is_unavailable(self):
        grid = build_beat_grid([1.0, 2.0], [1.0, 1.0], source_stems=[], algorithm="test")
        self.assertEqual(grid["status"], "unavailable")
        self.assertEqual(grid["beats"], [])
        self.assertEqual(grid["downbeats"], [])

    def test_the_minimum_beat_count_is_configurable(self):
        config = BeatGridConfig(minimum_beats=4)
        grid = build_beat_grid(
            steady_beats(120.0, 8),
            accented_cue(8, 4, 0),
            source_stems=["drums"],
            algorithm="test",
            config=config,
        )
        self.assertNotEqual(grid["status"], "unavailable")

    def test_every_downbeat_is_also_a_beat(self):
        grid = build_beat_grid(
            steady_beats(138.0, 48, start=1.234),
            accented_cue(48, 4, 3),
            source_stems=["drums"],
            algorithm="test",
        )
        self.assertTrue(set(grid["downbeats"]).issubset(set(grid["beats"])))


if __name__ == "__main__":
    unittest.main()
