import json
import os
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from baseline_query import parse_baseline_text
from recommendation_engine import CATALOG_RELATIVE_PATH, CATALOG_VERSION, RecommendationEngine, RecommendationError
from services.model_service.app import app, recommendation_engine


ROOT = Path(__file__).resolve().parents[1]


def sample_request():
    trip = json.loads((ROOT / "examples/trip-one-day.json").read_text())
    children = trip["family"]["children"]
    return dict(contract_version="1.0", request_id="test-request", trip_id="test-trip", trip_version=1,
                catalog_version=CATALOG_VERSION, purpose="initial", profile=trip["family"],
                policy={"child_interest_weights": [{"child_id": c["child_id"], "weight": 1 / len(children)} for c in children],
                        "activity_balance": {"mode": "equal_count_target", "scope": "trip", "shared_activity_credit": "split_equally"},
                        "adult_interest_weight": 0.1},
                load_limits=trip["load_limits"], days=trip["days"], selections=[],
                current_day_date=None, current_point=None, visited_activity_ids=[], excluded_activity_ids=[],
                request_text=None, spatial_scope=None, limit=50)


def make_engine(catalog=None):
    return RecommendationEngine(catalog or ROOT / CATALOG_RELATIVE_PATH, ROOT / "docs/contracts/openapi.json",
                                ROOT / "models/recommendation_policy.json")


class RecommendationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = make_engine()

    def test_full_contract_preserves_unknowns_and_real_ids(self):
        response = self.engine.recommend(sample_request())
        self.assertEqual(response["status"], "partial")
        self.assertEqual(len(response["candidates"]), 50)
        self.assertEqual(len({c["place"]["place_id"] for c in response["candidates"]}), 50)
        self.assertEqual(len(self.engine.records), 281)
        scores = [c["scores"]["final_relevance"] for c in response["candidates"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        for candidate in response["candidates"]:
            self.assertEqual(candidate["availability"][0]["state"], "unknown")
            self.assertEqual(candidate["availability"][0]["visit_windows"], [])
            self.assertEqual(candidate["activity"]["duration"]["source"], "estimated")
            self.assertTrue(all(e["status"] == "unknown" for e in candidate["eligibility"]))
            self.assertTrue(all(e["value"] is None for e in candidate["scores"]["child_age_fit"]))
            self.assertAlmostEqual(sum(c["value"] for c in candidate["balance_credit"]), 1)

    def test_profile_changes_ranking(self):
        request = sample_request()
        request["profile"]["adult_interest_ids"] = []
        orders = []
        for interest in ("nature", "art"):
            for child in request["profile"]["children"]:
                child["interest_ids"] = [interest]
            response = self.engine.recommend(request)
            orders.append([c["activity"]["activity_id"] for c in response["candidates"][:5]])
        self.assertNotEqual(orders[0], orders[1])

    def test_selection_survives_limit_and_exclusions_are_honored(self):
        request = sample_request()
        first = self.engine.records[0]
        aid, pid = first["activity"]["activity_id"], first["place"]["place_id"]
        request["limit"] = 1
        request["selections"] = [dict(activity_id=aid, place_id=pid, occurrence_id=None, mandatory=True, preferred_date=None)]
        self.assertEqual(self.engine.recommend(request)["candidates"][0]["activity"]["activity_id"], aid)
        request["visited_activity_ids"] = [aid]
        with self.assertRaises(RecommendationError) as conflict:
            self.engine.recommend(request)
        self.assertEqual(conflict.exception.code, "SELECTION_CONFLICT")
        request["selections"] = []
        self.assertNotEqual(self.engine.recommend(request)["candidates"][0]["activity"]["activity_id"], aid)

    def test_empty_pool_and_unknown_selection_are_explicit(self):
        request = sample_request()
        request["excluded_activity_ids"] = list(self.engine.by_id)
        self.assertEqual(self.engine.recommend(request)["status"], "no_candidates")
        request["selections"] = [dict(activity_id="missing", place_id="missing", occurrence_id=None, mandatory=True, preferred_date=None)]
        with self.assertRaises(RecommendationError) as missing:
            self.engine.recommend(request)
        self.assertEqual(missing.exception.code, "UNKNOWN_ACTIVITY")

    def test_invalid_dates_offsets_and_nonfinite_values_are_rejected(self):
        for field, value in (("date", "2030-02-30"), ("available_window", {
            "start_at": "2030-06-15T10:00:00", "end_at": "2030-06-15T17:00:00+03:00"
        }), ("duration_budget_sec", float("nan"))):
            request = sample_request()
            request["days"][0][field] = value
            with self.subTest(field=field), self.assertRaises(RecommendationError):
                self.engine.recommend(request)

    def test_known_age_restriction_cannot_be_compensated_by_interest(self):
        record = deepcopy(self.engine.records[0])
        aid = record["activity"]["activity_id"]
        record["evidence"] = [dict(evidence_id="official-age", source_url="https://example.org/rules", source_kind="official",
                                   checked_at="2026-11-20T12:00:00+03:00", valid_until=None)]
        record["activity"]["facts"] = {"age_min_years": dict(state="known", value=8, evidence_ids=["official-age"])}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.jsonl"
            path.write_text(json.dumps(record))
            engine = make_engine(path)
            response = engine.recommend(sample_request())
            self.assertEqual(response["candidates"], [])
            self.assertEqual(response["rejected"][0]["activity_id"], aid)

    def test_text_uses_explicit_preferences_and_exposes_unsupported_details(self):
        parsed = parse_baseline_text("Хотим животных, без музеев")
        self.assertIn(("category", "museum", "avoid"), [(c.kind, c.value, c.polarity) for c in parsed.claims])
        self.assertIn(("interest", "animals", "prefer"), [(c.kind, c.value, c.polarity) for c in parsed.claims])
        request = sample_request()
        request["request_text"] = "мастер-класс в 12:00"
        self.assertIn("REQUEST_TEXT_PARTIALLY_UNDERSTOOD", [w["code"] for w in self.engine.recommend(request)["warnings"]])
        self.assertFalse(parse_baseline_text("не только музеи").claims)
        self.assertFalse(parse_baseline_text("музеи не хотим").claims)
        request["request_text"] = "без музеев"
        self.assertTrue(all("museum" not in c["place"]["categories"] for c in self.engine.recommend(request)["candidates"]))


class RecommendationAPITests(unittest.TestCase):
    def setUp(self):
        recommendation_engine.cache_clear()
        self.environ = patch.dict(os.environ, {"ML_API_TOKEN": "test-token", "MODEL_CATALOG_VERSION": CATALOG_VERSION})
        self.environ.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.environ.stop()
        recommendation_engine.cache_clear()

    def post(self, request):
        return self.client.post("/internal/v1/recommendations", json=request, headers={"Authorization": "Bearer test-token"})

    def test_authentication_and_catalog_readiness(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.post("/internal/v1/recommendations", json=sample_request()).status_code, 401)
        self.assertEqual(self.post(sample_request()).status_code, 200)
        recommendation_engine.cache_clear()
        with patch.dict(os.environ, {"MODEL_CATALOG_PATH": "/missing/catalog"}):
            self.assertEqual(self.client.get("/health").status_code, 503)

    def test_version_validation_and_unsupported_purposes(self):
        request = sample_request()
        request["catalog_version"] = "stale"
        self.assertEqual(self.post(request).status_code, 409)
        request["catalog_version"] = CATALOG_VERSION
        request["purpose"] = "restaurant"
        self.assertEqual(self.post(request).status_code, 501)
        request["purpose"] = "initial"
        del request["profile"]
        response = self.post(request)
        self.assertEqual(response.status_code, 422)
        make_engine().validators["ApiError"].validate(response.json())
        malformed = self.post(["invalid body"])
        self.assertEqual(malformed.status_code, 422)
        make_engine().validators["ApiError"].validate(malformed.json())


if __name__ == "__main__":
    unittest.main()
