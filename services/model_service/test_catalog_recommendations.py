from __future__ import annotations

import os
import unittest
from pathlib import Path

from services.model_service.catalog_recommendations import load_catalog, recommend


class CatalogRecommendationsTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["CATALOG_PATH"] = str(Path(__file__).parents[2] / "data/demo/catalog.jsonl")
        load_catalog.cache_clear()
        self.request = {
            "contract_version": "1.0", "request_id": "request-1", "trip_id": "trip-1",
            "trip_version": 1, "catalog_version": "demo-catalog-v1", "limit": 50,
            "profile": {"children": [{"child_id": "child-1", "age_years": 7, "height_cm": None, "interest_ids": ["history"]}], "adult_count": 1, "adult_interest_ids": ["history"]},
            "days": [{"date": "2026-11-22"}], "selections": [], "excluded_activity_ids": [], "visited_activity_ids": [],
        }

    def test_response_is_planner_contract_shaped(self) -> None:
        response = recommend(self.request)
        self.assertEqual(response["request_id"], "request-1")
        self.assertEqual(response["catalog_version"], "demo-catalog-v1")
        self.assertEqual(response["status"], "complete")
        self.assertLessEqual(len(response["candidates"]), 50)
        first = response["candidates"][0]
        self.assertEqual(first["availability"][0]["state"], "unknown")
        self.assertEqual(first["availability"][0]["date"], "2026-11-22")
        self.assertEqual(first["scores"]["child_age_fit"][0]["child_id"], "child-1")


if __name__ == "__main__":
    unittest.main()
