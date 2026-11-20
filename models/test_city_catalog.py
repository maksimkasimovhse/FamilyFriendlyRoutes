import csv
import tempfile
import unittest
from pathlib import Path

from scripts.prepare_city_catalog import REQUIRED, audit_import, build_city_catalog
from source_matching import source_match_candidates


class CityCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, cls.report, cls.mapping = build_city_catalog()

    def test_expansion_preserves_source_identity_and_holds(self):
        self.assertEqual(self.report["source_records"], 259)
        self.assertEqual(len(self.records), 165)
        ids = {r["place"]["source_id"] for r in self.records}
        self.assertEqual(len(ids), 165)
        self.assertTrue({"51", "122", "67", "242"} <= ids)
        self.assertFalse({"225", "108", "239", "251", "252", "254", "258", "259", "264"} & ids)
        self.assertEqual(len([m for m in self.mapping if m["status"] == "map_only"]), 85)
        alias = next(m for m in self.mapping if m["source_dataset"] == "main" and m["source_id"] == "225")
        self.assertEqual(alias["canonical_place_id"], "place:main:67")

    def test_source_conflicts_and_unknown_facts_remain_visible(self):
        park = next(r for r in self.records if r["place"]["source_id"] == "67")
        self.assertTrue(park["data_quality_warnings"])
        library = next(r for r in self.records if r["place"]["source_id"] == "242")
        self.assertIn("Короленко", library["place"]["title"])
        self.assertIn(library["place"]["title"], library["features"]["embedding_text"])
        for row in self.records:
            self.assertIsNone(row["activity"]["duration_minutes"])
            self.assertEqual(row["activity"]["opening_hours"], [])
            self.assertTrue(all(value is None for value in row["activity"]["age_fit"].values()))

    def test_csv_import_handles_quoted_multiline_fields_and_conflicts(self):
        base = dict(id="57", title="Памятник", address="Нижний Новгород", coordinate="POINT (44.0 56.3)",
                    description='Первая строка\nВторая строка с "кавычками", запятой', category="Памятники")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "import.csv"
            with path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=REQUIRED)
                writer.writeheader()
                writer.writerows([base, {**base, "id": "58", "title": "Новое имя"}, {**base, "id": "59"}])
            report = audit_import(path, {"main": [base, {**base, "id": "58"}]})
            self.assertEqual(report["rows"], 3)
            self.assertEqual(report["identical_existing_records"], 1)
            self.assertEqual(len(report["id_conflicts"]), 1)
            self.assertEqual(len(report["new_record_candidates"]), 1)
            self.assertEqual(report["invalid_rows"], [])


class SourceMatchingTests(unittest.TestCase):
    def test_same_coordinate_does_not_link_a_park_to_a_toilet(self):
        seed = dict(id="67", title="Парк Швейцария", category="Парки и места отдыха",
                    address="Нижний Новгород", coordinate="POINT (44.0 56.3)")
        def osm(pid, name, category, lon=44.0):
            return {"place": {"place_id": pid, "name": name, "categories": [category],
                              "location": {"longitude": lon, "latitude": 56.3}}}
        toilet = osm("toilet", "Парк Швейцария", "toilet")
        nearby_other = osm("other-park", "Другой парк", "park")
        remote = osm("remote", "Парк Швейцария", "park", lon=44.2)
        result = source_match_candidates([toilet, nearby_other, remote], [seed])
        self.assertIsNone(result[0]["matched_place_id"])
        exact = osm("park", "Парк «Швейцария»", "park")
        result = source_match_candidates([toilet, exact], [seed])
        self.assertEqual(result[0]["matched_place_id"], "park")
        self.assertEqual(result[0]["match_method"], "exact_name_nearby_candidate")
        self.assertEqual(source_match_candidates([exact, osm("second", "Парк Швейцария", "park")], [seed])[0]["match_method"], "ambiguous")


if __name__ == "__main__":
    unittest.main()
