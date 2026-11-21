"""Run the existing bounded site parser for OSM website links and discovered pages.

Each URL is a source candidate, not an asserted official identity. No link crawling.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "models"))
from collect_sites import collect, job_key, write_json

OUTPUT = ROOT / "data/processed/site_collection/osm_descriptions"
DISCOVERED = ROOT / "data/site_collection/osm_discovered_sources.json"
SOCIAL = {"vk.com", "www.vk.com", "instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com", "t.me"}


def load_local_env():
    # Read simple dotenv assignments as data; never execute shell code or log values.
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("GIGACHAT_") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key, value.strip().strip("\"'"))
    key = "GIGACHAT_CA_BUNDLE"
    if os.environ.get(key) and not Path(os.environ[key]).is_absolute():
        os.environ[key] = str(ROOT / os.environ[key])


def normalize_url(value):
    value = value.strip()
    if "://" not in value:
        value = "https://" + value
    p = urlparse(value)
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        return None
    host = p.hostname.encode("idna").decode().lower()
    if host in SOCIAL:
        return None
    return urlunparse((p.scheme, host, p.path or "/", "", p.query, ""))


def prepare(output=OUTPUT):
    rows = [json.loads(line) for line in (ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl").read_text().splitlines()]
    grouped, policies = {}, {}
    discoveries = json.loads(DISCOVERED.read_text())["sources"] if DISCOVERED.exists() else []
    extra = defaultdict(list)
    for item in discoveries:
        extra[item["place_id"]].append(item)
    queue = []
    for row in rows:
        place = row["place"]
        candidates = ([{"url": place["website"], "discovery_method": "osm_website_tag"}] if place.get("website") else []) + extra[place["place_id"]]
        accepted = []
        for item in candidates:
            url = normalize_url(item["url"])
            if not url:
                continue
            host = urlparse(url).hostname
            source_id = "osm-site:" + host
            policies[source_id] = {"source_id": source_id, "allowed_hosts": sorted({host, "www." + host.removeprefix("www."), host.removeprefix("www.")}),
                                   "enabled": True, "respect_robots": True, "max_response_bytes": 2_000_000,
                                   "note": "Public URL from OSM or name-based source discovery. Identity remains a candidate until text/address review."}
            job = grouped.setdefault(url, {"source_id": source_id, "url": url, "place_ids": [], "place_names": [], "discovery_methods": []})
            if place["place_id"] not in job["place_ids"]:
                job["place_ids"].append(place["place_id"])
                job["place_names"].append(place["name"])
            job["discovery_methods"].append(item.get("discovery_method", "name_search"))
            accepted.append(url)
        queue.append({"place_id": place["place_id"], "name": place["name"], "address": place.get("address"),
                      "category": place["categories"][0], "candidate_urls": accepted,
                      "search_query": f'{place["name"]} Нижний Новгород официальный сайт описание',
                      "status": "page_candidate" if accepted else "name_missing" if not row["provenance"]["raw_tags"].get("name") else "source_discovery_required"})
    jobs = sorted(grouped.values(), key=lambda j: (all(x == "osm_website_tag" for x in j["discovery_methods"]), j["url"]))
    write_json(output / "registry.json", {"sources": list(policies.values())})
    write_json(output / "jobs.json", {"jobs": jobs})
    write_json(output / "queue.json", {"places": queue})
    return jobs, queue


def run(limit=250, workers=6, extract=True):
    jobs, queue = prepare()
    if extract:
        load_local_env()
    # Group by host so each host is sequential with the collector's 3s delay.
    hosts = defaultdict(list)
    for job in jobs[:limit]:
        hosts[job["source_id"]].append(job)
    results = []
    def process(items):
        # Separate outputs avoid concurrent report writes. Existing snapshots resume.
        return collect(items, OUTPUT / "registry.json", OUTPUT / "hosts" / job_key(items[0]),
                       limit=len(items), extract=extract, delay=3)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(process, items) for items in hosts.values()]
        for future in as_completed(futures):
            results.extend(future.result()["jobs"])
            write_json(OUTPUT / "report.json", {"counts": dict(Counter(r["status"] for r in results)), "jobs": sorted(results, key=lambda r: r["url"]),
                                                "planned_urls": len(jobs), "planned_places": sum(bool(q["candidate_urls"]) for q in queue)})
    print(json.dumps({"counts": dict(Counter(r["status"] for r in results)), "planned_urls": len(jobs)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=6)
    parser.add_argument("--fetch-only", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if args.prepare_only:
        jobs, queue = prepare()
        print(json.dumps({"urls": len(jobs), "places_with_urls": sum(bool(q["candidate_urls"]) for q in queue)}))
    else:
        run(args.limit, args.workers, not args.fetch_only)
