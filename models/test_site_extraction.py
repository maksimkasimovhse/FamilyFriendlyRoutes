import json
import unittest

from gigachat_client import StructuredResponse
from site_extractor import extract_site, normalize_occurrence_times, structured_schema
from site_ingestion import normalize_html
from site_schema import SiteExtraction, validate_evidence


HTML = b"""<!doctype html><html><head>
<title>Family Lab</title><link rel="canonical" href="/events/lab">
<script type="application/ld+json">{"@type":"Event","name":"Science Lab","startDate":"2026-12-01T12:00:00+03:00"}</script>
</head><body><header>Menu must disappear</header><main>
<h1>Science Lab</h1><p>Interactive experiments for children.</p>
<p>Open Monday from 10:00 to 18:00.</p><p>The session lasts 60 minutes.</p>
</main></body></html>"""


def extraction_value() -> dict:
    url = "https://example.org/events/lab"
    return {
        "schema_version": "1.0",
        "source_url": url,
        "page_title": "Family Lab",
        "place": {
            "source_name": "Science Lab",
            "name_evidence": [{"quote": "Science Lab", "source_url": url, "source_part": "visible_text"}],
            "address": None,
            "address_evidence": [],
            "opening_hours": [{
                "day_of_week": "monday", "opens": "10:00", "closes": "18:00",
                "evidence": [{"quote": "Open Monday from 10:00 to 18:00.", "source_url": url, "source_part": "visible_text"}],
            }],
        },
        "activities": [{
            "source_title": "Science Lab",
            "activity_type": "session",
            "description": "Interactive experiments for children.",
            "description_evidence": [{"quote": "Interactive experiments for children.", "source_url": url, "source_part": "visible_text"}],
            "topics": ["science"],
            "topic_evidence": [{"quote": "Science Lab", "source_url": url, "source_part": "visible_text"}],
            "formats": ["educational"],
            "format_evidence": [{"quote": "Interactive experiments", "source_url": url, "source_part": "visible_text"}],
            "duration_minutes": 60,
            "duration_evidence": [{"quote": "The session lasts 60 minutes.", "source_url": url, "source_part": "visible_text"}],
            "age_rules": [],
            "occurrences": [{
                "start_at": "2026-12-01T12:00:00+03:00", "end_at": None, "duration_minutes": None,
                "evidence": [{"quote": "2026-12-01T12:00:00+03:00", "source_url": url, "source_part": "json_ld"}],
            }],
            "booking_required": None,
            "booking_evidence": [],
        }],
        "warnings": [],
    }


class FakeClient:
    def extract(self, **_: object) -> StructuredResponse:
        return StructuredResponse(value=extraction_value(), model="fixture", usage={})


class SiteExtractionTests(unittest.TestCase):
    def setUp(self):
        self.page = normalize_html(
            HTML,
            source_url="https://example.org/events/lab",
            final_url="https://example.org/events/lab",
        )

    def test_html_normalization(self):
        self.assertNotIn("Menu must disappear", self.page.text)
        self.assertIn("Science Lab", self.page.text)
        self.assertEqual(self.page.canonical_url, "https://example.org/events/lab")
        self.assertEqual(self.page.json_ld[0]["@type"], "Event")

    def test_extraction_and_exact_evidence(self):
        extraction, response = extract_site(self.page, FakeClient())
        self.assertEqual(extraction.activities[0].duration_minutes, 60)
        self.assertEqual(response.model, "fixture")

    def test_missing_evidence_is_rejected(self):
        value = extraction_value()
        value["activities"][0]["duration_evidence"] = []
        with self.assertRaises(ValueError):
            SiteExtraction.model_validate(value)

    def test_hallucinated_quote_is_rejected(self):
        extraction = SiteExtraction.model_validate(extraction_value())
        extraction.activities[0].description_evidence[0].quote = "Not on the page"
        with self.assertRaises(ValueError):
            validate_evidence(extraction, self.page.text, self.page.final_url)

    def test_gigachat_schema_uses_closed_objects(self):
        schema = structured_schema()
        encoded = json.dumps(schema)
        self.assertNotIn('"oneOf"', encoded)
        self.assertNotIn('"discriminator"', encoded)
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(schema["properties"]))

    def test_occurrence_duration_is_derived_deterministically(self):
        value = extraction_value()
        occurrence = value["activities"][0]["occurrences"][0]
        occurrence["end_at"] = "2026-12-01T13:30:00+03:00"
        extraction = SiteExtraction.model_validate(value)
        normalize_occurrence_times(extraction)
        self.assertEqual(extraction.activities[0].occurrences[0].duration_minutes, 90)


if __name__ == "__main__":
    unittest.main()
