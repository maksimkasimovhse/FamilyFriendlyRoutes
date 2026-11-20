import unittest

from scripts.prepare_demo_catalog import build_record, coverage, read_rows, select_rows


class DemoCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = [build_record(row) for row in select_rows(read_rows())]

    def test_balanced_slice_has_stable_unique_ids(self):
        self.assertEqual(len(self.records), 40)
        place_ids = [record["place"]["place_id"] for record in self.records]
        activity_ids = [record["activity"]["activity_id"] for record in self.records]
        self.assertEqual(len(set(place_ids)), 40)
        self.assertEqual(len(set(activity_ids)), 40)
        self.assertTrue(all(value.startswith("place:main:") for value in place_ids))

    def test_unknown_facts_are_not_invented(self):
        for record in self.records:
            activity = record["activity"]
            self.assertLessEqual(len(activity["description_text"]), 1200)
            self.assertIsNone(activity["duration_minutes"])
            self.assertEqual(activity["opening_hours"], [])
            self.assertTrue(all(value is None for value in activity["age_fit"].values()))

    def test_report_exposes_enrichment_gap(self):
        report = coverage(self.records)
        self.assertEqual(report["field_coverage"]["coordinates"]["percent"], 100.0)
        self.assertEqual(report["field_coverage"]["description"]["percent"], 100.0)
        self.assertEqual(report["field_coverage"]["age_fit"]["percent"], 0.0)
        self.assertEqual(report["field_coverage"]["opening_hours"]["percent"], 0.0)


if __name__ == "__main__":
    unittest.main()
