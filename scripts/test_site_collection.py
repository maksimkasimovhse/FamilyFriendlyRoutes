import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from collect_sites import collect
from export_reviewed_site_facts import export_facts
from site_ingestion import normalize_html


class CollectionTests(unittest.TestCase):
    def test_failure_is_recorded_and_resume_retries_only_failed_page(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "registry.json"
            registry.write_text(json.dumps({"sources": [{"source_id": "test", "enabled": True, "allowed_hosts": ["example.org"]}]}))
            jobs = [{"source_id": "test", "url": f"https://example.org/{i}"} for i in range(2)]
            page = normalize_html(b"<main>Children menu</main>", source_url=jobs[0]["url"], final_url=jobs[0]["url"])
            with patch("collect_sites.fetch_page", side_effect=[page, PermissionError("robots denied")]), patch("collect_sites.time.sleep"):
                report = collect(jobs, registry, root, delay=1)
            self.assertEqual(report["counts"], {"fetched": 1, "error": 1})
            page2 = normalize_html(b"<main>Page two</main>", source_url=jobs[1]["url"], final_url=jobs[1]["url"])
            with patch("collect_sites.fetch_page", return_value=page2) as fetch:
                report = collect(jobs, registry, root, delay=1)
            self.assertEqual(fetch.call_count, 1)
            self.assertTrue(report["jobs"][0]["cached"])
            self.assertEqual(report["counts"], {"fetched": 2})
            claim = dict(jobs[0], entity_key="test:restaurant", field="children_menu", value=True,
                         scope="restaurant", quote="Children menu")
            exported = export_facts([claim, {**claim, "quote": "invented quote"}], root / "pages", root)
            self.assertEqual(exported["facts"], 1)
            self.assertEqual(len(exported["rejected"]), 1)

    def test_disabled_source_rejects_batch_before_fetching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "registry.json"
            registry.write_text(json.dumps({"sources": [{"source_id": "test", "enabled": False, "allowed_hosts": ["example.org"]}]}))
            with patch("collect_sites.fetch_page") as fetch, self.assertRaises(ValueError):
                collect([{"source_id": "test", "url": "https://example.org"}], registry, root)
            fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
