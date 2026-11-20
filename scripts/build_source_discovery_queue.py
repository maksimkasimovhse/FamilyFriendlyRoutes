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
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data/enriched/osm_nizhny_1000/parsing_queue.csv"
DEFAULT_OUTPUT = ROOT / "data/enriched/osm_nizhny_1000"

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


def write_csv(rows: list[dict[str, str]], path: Path) -> None:
    fields = (
        "priority", "place_id", "title", "category", "candidate_url", "candidate_host", "source_kind",
        "authority_status", "discovery_status", "parse_status", "notes",
    )
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
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
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    osm_rows = read_osm_candidates(args.input)
    all_rows = sorted(osm_rows + brief_candidates(), key=lambda row: (row["priority"] != "high", row["title"].casefold(), row["candidate_url"]))
    write_csv(all_rows, args.output / "source_discovery_queue.csv")
    write_registry(all_rows, args.output / "source_registry_candidates.json")
    print(json.dumps({"osm_url_candidates": len(osm_rows), "brief_seeds": len(BRIEF_SEEDS), "registry_candidates": len({row['candidate_host'] for row in all_rows if row['source_kind'] != 'discovery_only'})}, ensure_ascii=False))


if __name__ == "__main__":
    main()
