"""Regression coverage for clients that existed before the assistant integration."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from request_schema import ParsedRequest
from services.model_service.app import app as model_app
from services.parser_service.app import app as parser_app


class LegacyAPICompatibilityTests(unittest.TestCase):
    def test_existing_rankings_still_work_without_a_new_token_header(self):
        body = dict(contract_version="1.0", request_id="legacy-rank", parsed_request=None,
                    candidates=[], limit=10)
        with patch.dict("os.environ", {"ML_API_TOKEN": "configured-token", "ML_REQUIRE_LEGACY_AUTH": "false"}), TestClient(model_app) as client:
            response = client.post("/internal/v1/rankings", json=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["ranked"], [])
            # New recommendation endpoints retain service-token protection.
            self.assertEqual(client.post("/internal/v1/recommendations", json={}).status_code, 401)
        with patch.dict("os.environ", {"ML_API_TOKEN": "configured-token", "ML_REQUIRE_LEGACY_AUTH": "true"}), TestClient(model_app) as client:
            self.assertEqual(client.post("/internal/v1/rankings", json=body).status_code, 401)

    def test_existing_request_parser_contract_still_accepts_existing_clients(self):
        parsed = ParsedRequest(taxonomy_version="1.0", claims=[], needs_clarification=False,
                               clarification_question=None, unsupported_requests=[])
        stub = SimpleNamespace(parsed=parsed, model="fixture", usage={})
        body = dict(contract_version="1.0", request_id="legacy-parse", text="Хотим музей")
        with patch.dict("os.environ", {"ML_API_TOKEN": "configured-token", "ML_REQUIRE_LEGACY_AUTH": "false"}), TestClient(parser_app) as client:
            with patch("services.parser_service.app.online_client", return_value=object()), patch("services.parser_service.app.parse_request_text", return_value=stub):
                self.assertEqual(client.post("/internal/v1/request-parses", json=body).status_code, 200)
            self.assertEqual(client.post("/internal/v1/catalog-extractions", json={}).status_code, 422)
            self.assertEqual(client.post("/internal/v1/assistant-intents", json={}).status_code, 401)
        with patch.dict("os.environ", {"ML_API_TOKEN": "configured-token", "ML_REQUIRE_LEGACY_AUTH": "true"}), TestClient(parser_app) as client:
            self.assertEqual(client.post("/internal/v1/request-parses", json=body).status_code, 401)


if __name__ == "__main__":
    unittest.main()
