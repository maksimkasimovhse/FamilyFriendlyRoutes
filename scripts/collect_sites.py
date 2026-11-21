"""Bounded, resumable collection of explicitly reviewed pages (no crawling)."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))

from extract_site import load_policy
from site_ingestion import NormalizedPage, fetch_page


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def job_key(job: dict) -> str:
    return hashlib.sha256((job["source_id"] + "\n" + job["url"]).encode()).hexdigest()[:24]


def collect(jobs: list[dict], registry: Path, output: Path, *, delay: float = 3,
            limit: int = 10, extract: bool = False, refresh: bool = False, save_html: bool = False) -> dict:
    if delay < 1 or limit < 1:
        raise ValueError("delay must be >=1 second and limit must be positive")
    # Check the whole bounded batch before making any network requests.
    selected = jobs[:limit]
    policies = [load_policy(registry, job["source_id"]) for job in selected]
    if any(not policy.enabled for policy in policies):
        raise ValueError("batch contains a disabled source")
    client = None
    if extract:
        from gigachat_client import GigaChatStructuredClient
        client = GigaChatStructuredClient()
    results = []
    last_request = None
    for job, policy in zip(selected, policies):
        key = job_key(job)
        snapshot_path = output / "pages" / f"{key}.json"
        html_path = output / "pages" / f"{key}.html"
        extraction_path = output / "extractions" / f"{key}.json"
        row = {"job_key": key, **job}
        try:
            cached = snapshot_path.exists() and not refresh and (not save_html or html_path.exists())
            if cached:
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                page = NormalizedPage(**{**snapshot["page"], "json_ld": tuple(snapshot["page"]["json_ld"])})
            else:
                if last_request is not None:
                    time.sleep(max(0, delay - (time.monotonic() - last_request)))
                last_request = time.monotonic()
                page = fetch_page(job["url"], policy, raw_output=html_path) if save_html else fetch_page(job["url"], policy)
                if not page.text.strip():
                    raise ValueError("no visible text; requires a separately reviewed browser adapter")
                snapshot = {
                    "source_id": policy.source_id,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "content_verified_at": None,
                    "page": asdict(page),
                }
                write_json(snapshot_path, snapshot)
            row.update(snapshot=str(snapshot_path), characters=len(page.text),
                       final_url=page.final_url, fetched_at=snapshot["fetched_at"],
                       content_sha256=page.content_sha256, cached=cached, status="fetched")
            if client is not None:
                previous = json.loads(extraction_path.read_text(encoding="utf-8")) if extraction_path.exists() else {}
                if not refresh and previous.get("content_sha256") == page.content_sha256:
                    row["status"] = "extraction_cached"
                else:
                    from site_extractor import extract_site
                    extraction, response = extract_site(page, client)
                    write_json(extraction_path, {
                        "source_id": policy.source_id, "content_sha256": page.content_sha256,
                        "fetched_at": snapshot["fetched_at"],
                        "extractor": {"provider": "gigachat", "model": response.model, "usage": response.usage},
                        "extraction": extraction.model_dump(mode="json"),
                    })
                    row["status"] = "extracted"
                row["extraction"] = str(extraction_path)
        except Exception as error:
            # A failed page must not discard already collected pages or stop the batch.
            row.update(status="error", error_type=type(error).__name__, error=str(error))
        results.append(row)
        print(json.dumps({"source_id": job["source_id"], "url": job["url"], "status": row["status"]}, ensure_ascii=False), flush=True)
        report = {
            "schema_version": "site-collection-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
            "mode": "gigachat" if extract else "fetch_only", "limit": limit,
            "counts": dict(Counter(item["status"] for item in results)), "jobs": results,
        }
        write_json(output / "report.json", report)
    if not results:
        raise ValueError("batch has no jobs")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, default=ROOT / "data/site_collection/first_batch.json")
    parser.add_argument("--registry", type=Path, default=ROOT / "data/source_registry.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/processed/site_collection/first_batch")
    parser.add_argument("--delay", type=float, default=3)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--extract", action="store_true", help="Use configured GigaChat credentials")
    parser.add_argument("--refresh", action="store_true", help="Fetch again instead of reusing snapshots")
    parser.add_argument("--save-html", action="store_true", help="Keep bounded raw HTML for structured calendar adapters")
    args = parser.parse_args()
    jobs = json.loads(args.jobs.read_text(encoding="utf-8"))["jobs"]
    report = collect(jobs, args.registry, args.output, delay=args.delay, limit=args.limit,
                     extract=args.extract, refresh=args.refresh, save_html=args.save_html)
    if report["counts"].get("error"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
