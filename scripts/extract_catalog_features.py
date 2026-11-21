"""Extract full enrichment properties from already collected pages, resumably."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))
from collect_sites import write_json
from restore_osm_descriptions import load_local_env
from site_features import extract_features, validate_claims
from gigachat_client import GigaChatStructuredClient

SOURCE = ROOT / "data/processed/site_collection/osm_descriptions/report.json"
OUTPUT = ROOT / "data/processed/site_collection/full_features"
VERSION = "task-features-v1"


def run(limit=100, workers=4):
    load_local_env()
    source_jobs = json.loads(SOURCE.read_text())["jobs"]
    extra = ROOT / "data/processed/site_collection/extra_family/report.json"
    if extra.exists():
        source_jobs += json.loads(extra.read_text())["jobs"]
    jobs = [job for job in source_jobs if job.get("snapshot")][:limit]
    results = []
    shared_client = None
    def process(job):
        snapshot = json.loads(Path(job["snapshot"]).read_text())
        page = snapshot["page"]
        key = hashlib.sha256((page["final_url"] + page["content_sha256"] + VERSION).encode()).hexdigest()[:24]
        destination = OUTPUT / "extractions" / (key + ".json")
        row = {"url": page["final_url"], "place_ids": job["place_ids"], "place_names": job["place_names"],
               "source_content_sha256": page["content_sha256"], "fetched_at": snapshot["fetched_at"], "snapshot": job["snapshot"]}
        try:
            if destination.exists():
                extraction = json.loads(destination.read_text())
                claims = extraction["claims"] + [r["claim"] for r in extraction["rejected_claims"]]
                accepted, rejected, warnings = validate_claims({"claims": claims, "warnings": extraction["warnings"]}, page)
                extraction.update(claims=accepted, rejected_claims=rejected, warnings=warnings)
                write_json(destination, extraction)
                row["cached"] = True
            else:
                extraction = extract_features(page, job["place_names"], shared_client)
                write_json(destination, {"schema_version": VERSION, **row, **extraction})
            row.update(status="extracted", claims=len(extraction["claims"]), rejected=len(extraction["rejected_claims"]), extraction=str(destination))
        except Exception as error:
            row.update(status="error", error_type=type(error).__name__, error=str(error))
        return row
    # One OAuth token per batch; parallel pages must not trigger an OAuth storm.
    all_cached = all((OUTPUT / "extractions" / (hashlib.sha256((json.loads(Path(j["snapshot"]).read_text())["page"]["final_url"] + json.loads(Path(j["snapshot"]).read_text())["page"]["content_sha256"] + VERSION).encode()).hexdigest()[:24] + ".json")).exists() for j in jobs)
    if not all_cached:
        shared_client = GigaChatStructuredClient(timeout_seconds=120)
        shared_client._get_token()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in as_completed([pool.submit(process, job) for job in jobs]):
            row = future.result()
            results.append(row)
            write_json(OUTPUT / "report.json", {"schema_version": VERSION, "planned_pages": len(jobs),
                       "counts": dict(Counter(r["status"] for r in results)), "claims": sum(r.get("claims", 0) for r in results),
                       "jobs": sorted(results, key=lambda r: r["url"])})
            print(json.dumps({k: row[k] for k in ("url", "status", "claims", "rejected") if k in row}, ensure_ascii=False), flush=True)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--workers", type=int, choices=range(1, 7), default=4)
    args = parser.parse_args()
    run(args.limit, args.workers)
