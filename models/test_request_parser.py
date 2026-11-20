import json
import unittest

from request_parser import ParsedRequest, _extract_output_text, _strict_schema, validate_evidence


class RequestParserTests(unittest.TestCase):
    def test_valid_claim_and_exact_evidence(self):
        parsed = ParsedRequest.model_validate({
            "taxonomy_version": "1.0",
            "claims": [{"kind": "interest", "value": "animals", "polarity": "prefer", "evidence": "хотим животных"}],
            "needs_clarification": False,
            "clarification_question": None,
            "unsupported_requests": [],
        })
        validate_evidence(parsed, "Сегодня хотим животных и парк")

    def test_unknown_taxonomy_value_is_rejected(self):
        with self.assertRaises(ValueError):
            ParsedRequest.model_validate({
                "taxonomy_version": "1.0",
                "claims": [{"kind": "interest", "value": "dinosaurs", "polarity": "prefer", "evidence": "динозавры"}],
                "needs_clarification": False,
                "clarification_question": None,
                "unsupported_requests": [],
            })

    def test_non_source_evidence_is_rejected(self):
        parsed = ParsedRequest.model_validate({
            "taxonomy_version": "1.0",
            "claims": [{"kind": "format", "value": "active", "polarity": "prefer", "evidence": "активный отдых"}],
            "needs_clarification": False,
            "clarification_question": None, "unsupported_requests": [],
        })
        with self.assertRaises(ValueError):
            validate_evidence(parsed, "Хотим спокойно погулять")

    def test_extract_responses_output(self):
        content = json.dumps({"taxonomy_version": "1.0", "claims": [], "needs_clarification": False,
                              "clarification_question": None, "unsupported_requests": []})
        body = {"output": [{"type": "message", "content": [{"type": "output_text", "text": content}]}]}
        self.assertEqual(_extract_output_text(body), content)

    def test_schema_is_strict(self):
        schema = _strict_schema()
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        self.assertTrue(all(value.get("additionalProperties") is False for value in schema["$defs"].values()
                            if value.get("type") == "object"))
        self.assertIn("animals", schema["$defs"]["InterestClaim"]["properties"]["value"]["enum"])
        self.assertIn("museum", schema["$defs"]["CategoryClaim"]["properties"]["value"]["enum"])
        encoded = json.dumps(schema)
        self.assertNotIn('"oneOf"', encoded)
        self.assertNotIn('"discriminator"', encoded)
        self.assertIn('"anyOf"', encoded)


if __name__ == "__main__":
    unittest.main()
