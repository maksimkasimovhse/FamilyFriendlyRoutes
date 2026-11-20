import unittest

from query_match import query_match_score
from request_parser import ParsedRequest


class QueryMatchTests(unittest.TestCase):
    def setUp(self):
        self.parsed = ParsedRequest.model_validate({
            "taxonomy_version": "1.0",
            "claims": [
                {"kind": "interest", "value": "animals", "polarity": "prefer", "evidence": "животных"},
                {"kind": "category", "value": "museum", "polarity": "avoid", "evidence": "не музей"},
            ],
            "needs_clarification": False,
            "clarification_question": None,
            "unsupported_requests": [],
        })

    def test_preference_matches_and_avoidance_blocks(self):
        self.assertEqual(query_match_score(self.parsed, frozenset({"interest:animals", "category:park"})), 1)
        self.assertEqual(query_match_score(self.parsed, frozenset({"interest:animals", "category:museum"})), 0)
        self.assertEqual(query_match_score(self.parsed, frozenset({"category:park"})), 0)

    def test_absent_request_is_neutral(self):
        self.assertEqual(query_match_score(None, frozenset()), 0.5)


if __name__ == "__main__":
    unittest.main()
