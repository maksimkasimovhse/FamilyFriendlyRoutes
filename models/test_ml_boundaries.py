import copy
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from assistant_context import normalize_context
from assistant_schema import parse_assistant, strict_intent_schema
from model_contracts import recommendation_schemas
from services.parser_service.app import app as parser_app
from services.model_service.app import app as model_app, recommendation_engine
from test_assistant import CONTEXT, FakeClient, intent


class MLBoundariesTests(unittest.TestCase):
    def test_context_rejects_duplicate_ids_and_naive_time(self):
        cases = []
        duplicate = copy.deepcopy(CONTEXT)
        duplicate["days"][0]["stops"].append(duplicate["days"][0]["stops"][0])
        cases.append(duplicate)
        wrong_day = copy.deepcopy(CONTEXT)
        wrong_day["selected_date"] = "2030-06-16"
        cases.append(wrong_day)
        naive = copy.deepcopy(CONTEXT)
        naive["observed_at"] = "2030-06-15T10:00:00"
        cases.append(naive)
        oversized = copy.deepcopy(CONTEXT)
        oversized["choices"] = [{"place_id": str(i)} for i in range(4)]
        cases.append(oversized)
        for context in cases:
            with self.subTest(context=context), self.assertRaises(ValueError):
                normalize_context(context)

    def test_invalid_context_does_not_call_the_llm(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": ""}), TestClient(parser_app) as client, patch("services.parser_service.app.online_client") as factory:
            response = client.post("/internal/v1/assistant-intents", json={
                "contract_version": "1.0", "request_id": "bad-context", "message": "Привет",
                "context": {"days": "invalid"},
            })
            self.assertEqual(response.status_code, 422)
            factory.assert_not_called()

    def test_only_bounded_documented_context_is_forwarded(self):
        context = copy.deepcopy(CONTEXT)
        context["unrelated_backend_field"] = "omit-me"
        context["family"]["private_internal_field"] = "omit-me-too"
        context["history"] = None
        normalized = normalize_context(context)
        self.assertNotIn("omit-me", json.dumps(normalized))
        self.assertEqual(normalized["history"], [])

    def test_unsupported_backend_action_becomes_clarification(self):
        context = copy.deepcopy(CONTEXT)
        context["available_actions"] = ["remove_stop", "replan_day"]
        schema = strict_intent_schema(context)
        self.assertNotIn("shorten_day", schema["properties"]["action"]["enum"])
        parsed, _ = parse_assistant("Ребёнок устал", context, FakeClient(intent()))
        self.assertEqual(parsed.action, "clarify")
        self.assertEqual(parsed.needs[0].kind, "rest")
        self.assertTrue(parsed.question)

    def test_mandatory_stop_is_not_proposed_for_removal(self):
        context = copy.deepcopy(CONTEXT)
        context["days"][0]["stops"][0]["mandatory"] = True
        data = intent("remove_stop")
        data["stop_id"] = "stop-1"
        parsed, _ = parse_assistant("Ребёнок устал", context, FakeClient(data))
        self.assertEqual(parsed.action, "clarify")
        self.assertIsNone(parsed.stop_id)

    def test_return_without_a_saved_endpoint_requests_clarification(self):
        context = copy.deepcopy(CONTEXT)
        del context["days"][0]["end_point"]
        parsed, _ = parse_assistant("Ребёнок устал", context, FakeClient(intent("return_to_hotel")))
        self.assertEqual(parsed.action, "clarify")
        self.assertTrue(parsed.question)

    def test_stop_cannot_be_moved_from_a_different_day(self):
        context = copy.deepcopy(CONTEXT)
        context["days"].append(dict(date="2030-06-16", stops=[]))
        data = intent("remove_stop")
        data.update(date="2030-06-16", stop_id="stop-1")
        with self.assertRaises(ValueError):
            parse_assistant("Ребёнок устал", context, FakeClient(data))

    def test_ml_extensions_do_not_mutate_backend_contract(self):
        path = Path(__file__).resolve().parents[1] / "docs/contracts/openapi.json"
        original = path.read_bytes()
        spec = json.loads(original)
        extended = recommendation_schemas(spec)
        self.assertEqual(spec, json.loads(original))
        self.assertIn("parsed_request", extended["RecommendationRequest"]["properties"])
        self.assertEqual(path.read_bytes(), original)

    def test_health_rankings_and_docs_survive_missing_recommendation_catalog(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": "token", "ML_REQUIRE_LEGACY_AUTH": "false", "MODEL_CATALOG_PATH": "/missing/catalog"}), TestClient(model_app) as client:
            recommendation_engine.cache_clear()
            self.assertEqual(client.get("/health").json(), {"status": "ok", "service": "model-service"})
            self.assertEqual(client.get("/ready").status_code, 503)
            self.assertEqual(client.get("/openapi.json").status_code, 200)
            self.assertEqual(client.get("/unknown-endpoint").status_code, 404)
            result = client.post("/internal/v1/rankings", json={"contract_version": "1.0", "request_id": "old", "parsed_request": None, "candidates": [], "limit": 10})
            self.assertEqual(result.status_code, 200)
            recommendation_engine.cache_clear()

    def test_intent_response_is_explicitly_non_mutating(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": ""}), TestClient(parser_app) as client, patch("services.parser_service.app.online_client", return_value=FakeClient(intent())):
            response = client.post("/internal/v1/assistant-intents", json={"contract_version": "1.0", "request_id": "intent", "message": "Ребёнок устал", "context": CONTEXT})
            self.assertEqual(response.status_code, 200)
            self.assertIs(response.json()["route_changed"], False)
            self.assertIs(response.json()["requires_backend_validation"], True)

    def test_missing_llm_configuration_is_unavailable_not_a_broken_legacy_api(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": "", "ASSISTANT_RULES_FALLBACK": "false"}), TestClient(parser_app) as client, patch("services.parser_service.app.online_client", side_effect=ValueError("missing credentials")):
            self.assertEqual(client.get("/health").status_code, 200)
            response = client.post("/internal/v1/assistant-intents", json={"contract_version": "1.0", "request_id": "intent", "message": "Ребёнок устал", "context": CONTEXT})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("credentials", response.text)

    def test_invalid_recommendation_never_waits_for_remote_llm(self):
        from test_recommendation_engine import sample_request
        request = sample_request()
        request["request_text"] = "Хотим музей"
        del request["profile"]
        with patch.dict("os.environ", {"ML_API_TOKEN": "", "REQUEST_PARSER_URL": "http://parser/internal/v1/request-parses"}), TestClient(model_app) as client, patch("services.model_service.app.httpx.Client") as remote:
            response = client.post("/internal/v1/recommendations", json=request)
            self.assertEqual(response.status_code, 422)
            remote.assert_not_called()

    def test_llm_timeout_returns_unavailable_and_health_remains_accessible(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": "", "ASSISTANT_RULES_FALLBACK": "false"}), TestClient(parser_app) as client, patch("services.parser_service.app.online_client", return_value=object()), patch("services.parser_service.app.asyncio.to_thread", new=AsyncMock(side_effect=TimeoutError)):
            for path, body in [
                ("/internal/v1/request-parses", dict(contract_version="1.0", request_id="timeout", text="Хотим музей")),
                ("/internal/v1/assistant-intents", dict(contract_version="1.0", request_id="timeout", message="Ребёнок устал", context=CONTEXT)),
            ]:
                self.assertEqual(client.post(path, json=body).status_code, 503)
            self.assertEqual(client.get("/health").status_code, 200)

    def test_explicit_walking_limit_retains_its_own_need(self):
        data = intent()
        data.update(max_walk_distance_m=500, walk_evidence="не больше 500 метров")
        parsed, _ = parse_assistant("Ребёнок устал, пройдём не больше 500 метров", CONTEXT, FakeClient(data))
        self.assertEqual({n.kind for n in parsed.needs}, {"rest", "less_walking"})

    def test_next_stop_is_resolved_from_route_order_or_pending_reference(self):
        context = copy.deepcopy(CONTEXT)
        context["days"][0]["stops"].append(dict(stop_id="stop-2", progress="planned"))
        data = intent("remove_stop")
        data.update(stop_id="stop-2", needs=[])
        parsed, _ = parse_assistant("Убери следующую точку", context, FakeClient(data))
        self.assertEqual(parsed.stop_id, "stop-1")
        context["pending_stop_id"] = "stop-2"
        parsed, _ = parse_assistant("Убери следующую точку", context, FakeClient(data))
        self.assertEqual(parsed.stop_id, "stop-2")

    def test_parser_preferences_flow_to_actual_catalog_recommendations(self):
        from test_recommendation_engine import sample_request
        request = sample_request()
        request["request_text"] = "Обойдёмся без музейных залов"
        preferences = dict(taxonomy_version="1.0", claims=[dict(kind="category", value="museum", polarity="avoid", evidence="без музейных залов")], needs_clarification=False, clarification_question=None, unsupported_requests=[])
        with patch.dict("os.environ", {"ML_API_TOKEN": "", "REQUEST_PARSER_URL": ""}), TestClient(parser_app) as parser, TestClient(model_app) as model, patch("services.parser_service.app.online_client", return_value=FakeClient(preferences)):
            result = parser.post("/internal/v1/request-parses", json=dict(contract_version="1.0", request_id="ml-flow", text=request["request_text"]))
            self.assertEqual(result.status_code, 200)
            request["parsed_request"] = result.json()["parsed_request"]
            response = model.post("/internal/v1/recommendations", json=request)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["candidates"])
            self.assertTrue(all("museum" not in c["place"]["categories"] for c in response.json()["candidates"]))


if __name__ == "__main__":
    unittest.main()
