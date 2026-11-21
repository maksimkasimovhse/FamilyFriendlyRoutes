import json
import unittest
from copy import deepcopy
from pathlib import Path

from scripts.expand_osm_catalog import expand_catalog
from scripts.prepare_city_catalog import build_city_catalog
from test_recommendation_engine import make_engine, sample_request


ROOT = Path(__file__).resolve().parents[1]


class OSMExpansionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed, _, _ = build_city_catalog()
        cls.records, cls.report, cls.decisions = expand_catalog(cls.seed)

    def test_expansion_adds_unique_places_and_retains_seed(self):
        self.assertEqual(len(self.seed), 165)
        self.assertEqual(len(self.records), 116)
        ids = [r["place"]["place_id"] for r in self.seed + self.records]
        self.assertEqual(len(set(ids)), 281)
        before = deepcopy(self.seed)
        again, _, _ = expand_catalog(self.seed)
        self.assertEqual(self.seed, before)
        self.assertEqual(self.records, again)

    def test_no_private_playgrounds_or_micro_exhibits_become_visits(self):
        for record in self.records:
            place, tags = record["place"], record["provenance"]["raw_tags"]
            self.assertNotIn(tags.get("access"), {"private", "no", "customers"})
            self.assertNotIn(tags.get("memorial"), {"plaque", "stone", "cross", "stele", "aircraft"})
            if place["category"] == "playground" and not tags.get("name"):
                self.assertEqual(tags.get("access"), "yes")
                self.assertEqual(place["title"], "Детская площадка")
            self.assertNotIn(place["category"], {"toilet", "bench", "shelter", "restaurant"})

    def test_overlap_is_held_without_a_claim_of_identity(self):
        overlaps = [d for d in self.decisions if d["decision_code"] == "OVERLAP_REVIEW"]
        self.assertTrue(overlaps)
        self.assertTrue(all(not d["canonical_place_id"] and d["possible_overlap_ids"] for d in overlaps))
        added = {r["place"]["source_id"] for r in self.records}
        self.assertFalse({"node/6284593787", "node/6412596831", "node/4492225524", "node/6499514699", "node/1808680326"} & added)

    def test_dates_and_unknown_visit_conditions_are_not_fabricated(self):
        for record in self.records:
            self.assertIsNone(record["activity"]["duration_minutes"])
            self.assertEqual(record["activity"]["opening_hours"], [])
            self.assertTrue(all(v is None for v in record["activity"]["age_fit"].values()))
            self.assertTrue(record["evidence"])
            self.assertIsNone(record["provenance"]["facts_checked_at"])
            self.assertIn("OSM_SOURCE_UNVERIFIED", [w["code"] for w in record["data_quality_warnings"]])

    def test_osm_place_evidence_reaches_full_backend_response(self):
        engine = make_engine()
        record = next(r for r in self.records if r["place"]["title"] == "КидБург")
        request = sample_request()
        request["limit"] = 1
        request["selections"] = [dict(activity_id=record["activity"]["activity_id"], place_id=record["place"]["place_id"],
                                      occurrence_id=None, mandatory=True, preferred_date=None)]
        response = engine.recommend(request)
        candidate = response["candidates"][0]
        self.assertTrue(candidate["place"]["indoor"]["value"])
        evidence_ids = {e["evidence_id"] for e in response["evidence"]}
        self.assertTrue(set(candidate["place"]["indoor"]["evidence_ids"]) <= evidence_ids)
        self.assertTrue(set(candidate["activity"]["evidence_ids"]) <= evidence_ids)
        self.assertEqual(candidate["availability"][0]["state"], "unknown")
        self.assertEqual(response["evidence"][0]["checked_at"], record["evidence"][0]["checked_at"])


if __name__ == "__main__":
    unittest.main()
