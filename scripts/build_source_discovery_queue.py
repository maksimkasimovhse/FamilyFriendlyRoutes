"""Build a reviewable official-source queue for the OSM enrichment catalog.

URLs in OpenStreetMap are useful leads, not proof that a page is official or
safe to crawl.  This script deliberately creates disabled registry candidates:
an operator reviews a domain before copying it into ``data/source_registry.json``
with ``enabled=true``.  It also preserves the explicit source examples from the
data-enrichment brief as a small, high-value first batch.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data/enriched/osm_nizhny_1000/parsing_queue.csv"
DEFAULT_OUTPUT = ROOT / "data/enriched/osm_nizhny_1000"
DEFAULT_CATALOG = ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl"
DEFAULT_MANUAL_SEEDS = ROOT / "data/enriched/osm_nizhny_1000/manual_source_seeds.json"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_BATCH_SIZE = 50

# These are the concrete examples in docs/data_enrichment_ml_task.md.  A source
# can be authoritative for one fact and only a discovery lead for another, so
# that distinction is explicit in the output rather than inferred by the LLM.
BRIEF_SEEDS = (
    ("НГХМ: правила посещения", "https://artmuseumnn.ru/posetitelyam/pravila-posescheniya/", "official_site", "hours, last entry, admission rules"),
    ("НГХМ: стоимость и льготы", "https://artmuseumnn.ru/posetitelyam/stoimost-lgoty/", "official_site", "ticket types and published prices"),
    ("НГХМ: программы", "https://artmuseumnn.ru/programmy/", "official_site", "children's activities and programmes"),
    ("Музей «Микула»: мастер-классы", "https://www.culture.ru/events/6673877/master-klassy-v-muzee-mikula?institute=39218", "public_culture_catalog", "programme lead; verify individual sessions"),
    ("GRANAT", "https://granatnn.ru/restoran", "official_site", "children's menu and play area claims"),
    ("Соляная биржа", "https://solbirza.ru/", "official_site", "children's menu and play area claims"),
    ("MITRICH", "https://mitrichsteakhouse.ru/", "official_site", "children's-room staffing schedule"),
    ("Яндекс Карты: места с детской комнатой", "https://yandex.com/maps/discovery/podborka_eda_detskaya-komnata_nizhnij-novgorod-47/", "discovery_only", "candidate discovery only; do not parse as a fact source"),
)


def canonical_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    parsed = urlparse(value if "://" in value else f"https://{value}")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return parsed.geturl()


def host_for(url: str) -> str:
    host = urlparse(url).hostname
    if host is None:
        raise ValueError(f"URL without host: {url!r}")
    return host.lower().rstrip(".")


def source_id(host: str) -> str:
    ascii_host = host.encode("idna").decode("ascii")
    return "candidate-" + re.sub(r"[^a-z0-9]+", "-", ascii_host).strip("-")


def read_osm_candidates(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    candidates = []
    for row in rows:
        url = canonical_url(row["website"])
        if url is None:
            continue
        candidates.append(
            {
                "priority": row["priority"],
                "place_id": row["place_id"],
                "title": row["title"],
                "category": row["category"],
                "candidate_url": url,
                "candidate_host": host_for(url),
                "source_kind": "osm_tag",
                "authority_status": "unverified_official_candidate",
                "discovery_status": "needs_domain_review",
                "parse_status": "blocked_until_source_enabled",
                "notes": "OSM URL is a lead only; confirm official ownership, robots.txt and current content.",
            }
        )
    return candidates


def brief_candidates() -> list[dict[str, str]]:
    rows = []
    for title, raw_url, kind, note in BRIEF_SEEDS:
        url = canonical_url(raw_url)
        assert url is not None
        rows.append(
            {
                "priority": "high",
                "place_id": "",
                "title": title,
                "category": "brief_seed",
                "candidate_url": url,
                "candidate_host": host_for(url),
                "source_kind": kind,
                "authority_status": "brief_named_source" if kind != "discovery_only" else "discovery_only",
                "discovery_status": "needs_domain_review",
                "parse_status": "blocked_until_source_enabled" if kind != "discovery_only" else "not_parseable_source",
                "notes": note,
            }
        )
    return rows


def manual_candidates(path: Path) -> list[dict[str, str]]:
    """Load search-confirmed candidates without silently enabling their domains."""
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    seeds = payload.get("seeds", []) if isinstance(payload, dict) else []
    rows: list[dict[str, str]] = []
    for seed in seeds:
        if not isinstance(seed, dict):
            continue
        url = canonical_url(str(seed.get("candidate_url", "")))
        if url is None:
            raise ValueError(f"manual source seed has invalid candidate_url: {seed!r}")
        rows.append({
            "priority": "high", "place_id": str(seed.get("place_id", "")), "title": str(seed.get("title", "")),
            "category": str(seed.get("category", "")), "candidate_url": url, "candidate_host": host_for(url),
            "source_kind": str(seed.get("source_kind", "manual_candidate")),
            "authority_status": str(seed.get("authority_status", "unverified_official_candidate")),
            "discovery_status": "needs_domain_review", "parse_status": "blocked_until_source_enabled",
            "notes": str(seed.get("notes", "")), "discovery_evidence_url": str(seed.get("verification_url", "")),
        })
    return rows


def wikidata_claim_urls(entity: dict[str, object]) -> list[str]:
    claims = entity.get("claims")
    if not isinstance(claims, dict):
        return []
    urls: list[str] = []
    for claim in claims.get("P856", []):
        if not isinstance(claim, dict):
            continue
        mainsnak = claim.get("mainsnak")
        if not isinstance(mainsnak, dict):
            continue
        datavalue = mainsnak.get("datavalue")
        value = datavalue.get("value") if isinstance(datavalue, dict) else None
        if isinstance(value, str):
            url = canonical_url(value)
            if url:
                urls.append(url)
    return sorted(set(urls))


def select_local_wikidata_urls(urls: list[str]) -> list[str]:
    """Avoid turning a global brand's every country page into local candidates."""
    russian = [url for url in urls if host_for(url).endswith((".ru", ".рф"))]
    if russian:
        return russian[:1]
    return urls[:1]


def fetch_wikidata_websites(ids: set[str]) -> dict[str, list[str]]:
    """Fetch official-website (P856) claims in documented, small API batches."""
    results: dict[str, list[str]] = {}
    for start in range(0, len(ids), WIKIDATA_BATCH_SIZE):
        batch = sorted(ids)[start:start + WIKIDATA_BATCH_SIZE]
        query = urlencode({"action": "wbgetentities", "ids": "|".join(batch), "props": "claims", "format": "json"})
        request = Request(f"{WIKIDATA_API}?{query}", headers={"User-Agent": "FamilyFriendlyRoutesCatalogBot/0.1 (source discovery)"})
        with urlopen(request, timeout=30) as response:  # nosec B310: fixed HTTPS endpoint
            payload = json.load(response)
        entities = payload.get("entities", {}) if isinstance(payload, dict) else {}
        if not isinstance(entities, dict):
            raise ValueError("unexpected Wikidata API response")
        for qid, entity in entities.items():
            if isinstance(qid, str) and isinstance(entity, dict):
                results[qid] = wikidata_claim_urls(entity)
        if start + WIKIDATA_BATCH_SIZE < len(ids):
            time.sleep(0.1)
    return results


def read_catalog(path: Path) -> list[dict[str, object]]:
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def wikidata_candidates(records: list[dict[str, object]], cache: dict[str, list[str]]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    eligible_categories = {"museum", "event", "restaurant", "other", "park", "playground"}
    for record in records:
        place = record.get("place", {})
        provenance = record.get("provenance", {})
        tags = provenance.get("raw_tags", {}) if isinstance(provenance, dict) else {}
        if not isinstance(place, dict) or not isinstance(tags, dict):
            continue
        categories = place.get("categories", [])
        category = categories[0] if isinstance(categories, list) and categories else ""
        if category not in eligible_categories or place.get("website"):
            continue
        for key, kind in (("wikidata", "wikidata_p856"), ("brand:wikidata", "brand_wikidata_p856")):
            qid = tags.get(key)
            if not isinstance(qid, str):
                continue
            for url in select_local_wikidata_urls(cache.get(qid, [])):
                rows.append(
                    {
                        "priority": "high" if category in {"museum", "event", "restaurant", "playground"} else "medium",
                        "place_id": str(place.get("place_id", "")),
                        "title": str(place.get("name", "")),
                        "category": str(category),
                        "candidate_url": url,
                        "candidate_host": host_for(url),
                        "source_kind": kind,
                        "authority_status": "unverified_official_candidate",
                        "discovery_status": "needs_domain_review",
                        "parse_status": "blocked_until_source_enabled",
                        "notes": f"Wikidata {qid} P856 claim; verify that the site applies to this local place.",
                    }
                )
    return rows


def write_csv(rows: list[dict[str, str]], path: Path) -> None:
    fields = (
        "priority", "place_id", "title", "category", "candidate_url", "candidate_host", "source_kind",
        "authority_status", "discovery_status", "parse_status", "notes", "discovery_evidence_url",
    )
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_registry(rows: list[dict[str, str]], path: Path) -> None:
    by_host: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        if row["source_kind"] != "discovery_only":
            by_host[row["candidate_host"]].append(row)
    sources = []
    for host, items in sorted(by_host.items()):
        kinds = sorted({item["source_kind"] for item in items})
        sources.append(
            {
                "source_id": source_id(host),
                "allowed_hosts": [host],
                "enabled": False,
                "respect_robots": True,
                "max_response_bytes": 2_000_000,
                "note": f"Candidate from {', '.join(kinds)}. Review ownership, robots.txt and redirects before enabling.",
            }
        )
    path.write_text(json.dumps({"sources": sources}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--manual-seeds", type=Path, default=DEFAULT_MANUAL_SEEDS)
    parser.add_argument("--refresh-wikidata", action="store_true", help="Refresh P856 official-website claims from Wikidata API")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    osm_rows = read_osm_candidates(args.input)
    records = read_catalog(args.catalog)
    wikidata_ids = {
        str(tags[key])
        for record in records
        for tags in [record.get("provenance", {}).get("raw_tags", {})]
        if isinstance(tags, dict)
        for key in ("wikidata", "brand:wikidata")
        if isinstance(tags.get(key), str)
    }
    cache_path = args.output / "wikidata_p856_cache.json"
    if args.refresh_wikidata:
        cache = fetch_wikidata_websites(wikidata_ids)
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    elif cache_path.exists():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        cache = {}
    wikidata_rows = wikidata_candidates(records, cache)
    manual_rows = manual_candidates(args.manual_seeds)
    all_rows = sorted(osm_rows + wikidata_rows + brief_candidates() + manual_rows, key=lambda row: (row["priority"] != "high", row["title"].casefold(), row["candidate_url"]))
    write_csv(all_rows, args.output / "source_discovery_queue.csv")
    write_registry(all_rows, args.output / "source_registry_candidates.json")
    print(json.dumps({"osm_url_candidates": len(osm_rows), "wikidata_url_candidates": len(wikidata_rows), "brief_seeds": len(BRIEF_SEEDS), "manual_candidates": len(manual_rows), "registry_candidates": len({row['candidate_host'] for row in all_rows if row['source_kind'] != 'discovery_only'})}, ensure_ascii=False))


if __name__ == "__main__":
    main()
