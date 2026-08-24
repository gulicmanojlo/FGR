import unittest

from chord_accuracy import chord_root, compare_charts, summarise


class ChordRootTests(unittest.TestCase):
    def test_plain_roots(self):
        self.assertEqual(chord_root("C"), "C")
        self.assertEqual(chord_root("Dm7"), "D")
        self.assertEqual(chord_root("Gsus4"), "G")

    def test_serbian_sharps_are_part_of_the_root(self):
        self.assertEqual(chord_root("Cis"), "Cis")
        self.assertEqual(chord_root("Dism"), "Dis")

    def test_ascii_accidentals(self):
        self.assertEqual(chord_root("C#m"), "C#")
        self.assertEqual(chord_root("Bb"), "Bb")

    def test_empty_name_has_no_root(self):
        self.assertEqual(chord_root(""), "")


class CompareChartsTests(unittest.TestCase):
    def test_identical_charts_score_perfectly(self):
        chart = [{"t": 1.0, "n": "Dm"}, {"t": 3.0, "n": "Gm"}]
        report = compare_charts(chart, chart)
        self.assertEqual(report["matched"], 2)
        self.assertEqual(report["medianOffsetMs"], 0.0)
        self.assertEqual(report["within50Ms"], 1.0)
        self.assertEqual(report["missingCount"], 0)
        self.assertEqual(report["extraCount"], 0)

    def test_a_uniform_lag_is_reported_with_its_sign(self):
        truth = [{"t": 1.0, "n": "Dm"}, {"t": 3.0, "n": "Gm"}]
        late = [{"t": 1.15, "n": "Dm"}, {"t": 3.15, "n": "Gm"}]
        report = compare_charts(truth, late)
        self.assertAlmostEqual(report["medianOffsetMs"], 150.0, places=1)
        self.assertEqual(report["lateShare"], 1.0)
        # The lag is the whole error, and duration-weighted scores would hide it.
        self.assertEqual(report["within50Ms"], 0.0)

    def test_being_early_is_a_negative_offset(self):
        truth = [{"t": 2.0, "n": "Dm"}]
        early = [{"t": 1.88, "n": "Dm"}]
        report = compare_charts(truth, early)
        self.assertAlmostEqual(report["medianOffsetMs"], -120.0, places=1)
        self.assertEqual(report["lateShare"], 0.0)

    def test_a_chord_the_machine_never_found_counts_as_missing(self):
        truth = [{"t": 1.0, "n": "Dm"}, {"t": 2.0, "n": "F"}, {"t": 3.0, "n": "Gm"}]
        guess = [{"t": 1.0, "n": "Dm"}, {"t": 3.0, "n": "Gm"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["missingCount"], 1)
        self.assertEqual(report["missing"][0]["n"], "F")

    def test_an_invented_chord_counts_as_extra(self):
        truth = [{"t": 1.0, "n": "Dm"}]
        guess = [{"t": 1.0, "n": "Dm"}, {"t": 5.0, "n": "A7"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["extraCount"], 1)
        self.assertEqual(report["extra"][0]["n"], "A7")

    def test_one_candidate_cannot_answer_for_two_changes(self):
        truth = [{"t": 1.0, "n": "Dm"}, {"t": 1.3, "n": "F"}]
        guess = [{"t": 1.05, "n": "Dm"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["matched"], 1)
        self.assertEqual(report["missingCount"], 1)

    def test_wrong_quality_is_not_counted_as_a_wrong_root(self):
        truth = [{"t": 1.0, "n": "Dm7"}]
        guess = [{"t": 1.0, "n": "Dm"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["wrongNameCount"], 1)
        self.assertEqual(report["wrongRootCount"], 0)

    def test_a_wrong_root_is_counted_as_both(self):
        truth = [{"t": 1.0, "n": "Dm"}]
        guess = [{"t": 1.0, "n": "Gm"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["wrongNameCount"], 1)
        self.assertEqual(report["wrongRootCount"], 1)

    def test_far_away_chords_do_not_match_each_other(self):
        truth = [{"t": 1.0, "n": "Dm"}]
        guess = [{"t": 4.0, "n": "Dm"}]
        report = compare_charts(truth, guess)
        self.assertEqual(report["matched"], 0)
        self.assertEqual(report["missingCount"], 1)
        self.assertEqual(report["extraCount"], 1)

    def test_without_a_reference_there_is_nothing_to_score(self):
        report = compare_charts([], [{"t": 1.0, "n": "Dm"}])
        self.assertEqual(report["status"], "no-reference")

    def test_the_summary_says_late_or_early_in_plain_words(self):
        truth = [{"t": 1.0, "n": "Dm"}]
        report = compare_charts(truth, [{"t": 1.2, "n": "Dm"}])
        self.assertIn("kasni", summarise(report))
        report = compare_charts(truth, [{"t": 0.8, "n": "Dm"}])
        self.assertIn("žuri", summarise(report))


if __name__ == "__main__":
    unittest.main()
