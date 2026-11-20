"""Build a reproducible, source-backed first enrichment queue from OSM nodes.

The resulting catalog is deliberately not a claim that every place is family
friendly.  It stores only directly tagged OSM facts and represents all other
requested facts as unknown, so official-site parsing can fill them later.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import re
from collections import Counter, defaultdict, deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import osmium


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PBF = ROOT / "data/raw/osm_nizhny/volga-fed-district-261117.osm.pbf"
DEFAULT_SEED = ROOT / "db/seed/main.csv"
DEFAULT_OUTPUT = ROOT / "data/enriched/osm_nizhny_1000"

# A city bbox, not an administrative-boundary assertion. It keeps the first
# dataset focused on the tourist core and the main residential districts.
CITY_BBOX = (43.75, 56.20, 44.15, 56.38)  # min_lon, min_lat, max_lon, max_lat
CENTER = (44.0050, 56.3269)

AMENITY_CATEGORY = {
    "toilets": "toilet", "restaurant": "restaurant", "cafe": "restaurant",
    "fast_food": "restaurant", "bench": "bench", "shelter": "shelter",
    "library": "other", "theatre": "event", "cinema": "event",
    "arts_centre": "event", "community_centre": "other",
}
TOURISM_CATEGORY = {
    "museum": "museum", "gallery": "museum", "zoo": "park",
    "theme_park": "park", "attraction": "landmark", "viewpoint": "landmark",
}
LEISURE_CATEGORY = {
    "playground": "playground", "park": "park", "garden": "park",
    "nature_reserve": "park", "sports_centre": "other",
}
TARGET_QUOTAS = {
    "museum": 60, "event": 55, "park": 100, "playground": 165,
    "restaurant": 250, "toilet": 90, "bench": 100, "shelter": 45,
    "landmark": 85, "other": 50,
}


def clean_text(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"<[^>]+>", " ", html.unescape(value))
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def in_city(lon: float, lat: float) -> bool:
    min_lon, min_lat, max_lon, max_lat = CITY_BBOX
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def distance_km(lon: float, lat: float) -> float:
    return point_distance_km(lon, lat, *CENTER)


def point_distance_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (lon1, lat1, lon2, lat2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def category_for(tags: dict[str, str]) -> str | None:
    if tags.get("amenity") in AMENITY_CATEGORY:
        return AMENITY_CATEGORY[tags["amenity"]]
    if tags.get("tourism") in TOURISM_CATEGORY:
        return TOURISM_CATEGORY[tags["tourism"]]
    if tags.get("leisure") in LEISURE_CATEGORY:
        return LEISURE_CATEGORY[tags["leisure"]]
    if tags.get("man_made") == "shelter" or "shelter_type" in tags:
        return "shelter"
    if "historic" in tags or tags.get("memorial") in {"statue", "monument", "memorial"}:
        return "landmark"
    return None


def address(tags: dict[str, str]) -> str | None:
    parts = [tags[key] for key in ("addr:postcode", "addr:city", "addr:street", "addr:housenumber") if tags.get(key)]
    return ", ".join(parts) if parts else None


def flag(tags: dict[str, str], key: str) -> dict[str, Any]:
    value = tags.get(key)
    if value in {"yes", "true", "1"}:
        return {"state": "known", "value": True}
    if value in {"no", "false", "0"}:
        return {"state": "known", "value": False}
    return {"state": "unknown", "value": None}


def known(value: bool) -> dict[str, Any]:
    return {"state": "known", "value": value}


def topics(tags: dict[str, str], category: str) -> list[str]:
    values = " ".join(tags.get(key, "") for key in ("name", "description", "tourism", "historic", "leisure", "amenity", "cuisine")).casefold()
    result: set[str] = set()
    for topic, words in {
        "animals": ("zoo", "зооп", "animal"), "nature": ("park", "сад", "garden", "nature"),
        "history": ("historic", "мемори", "памят", "museum", "музе"), "art": ("gallery", "art", "искус"),
        "theatre": ("theatre", "театр", "cinema", "кино"), "food": ("restaurant", "cafe", "cuisine", "кафе"),
    }.items():
        if any(word in values for word in words):
            result.add(topic)
    if not result:
        result.add({"playground": "play", "toilet": "utility", "bench": "rest", "shelter": "shelter"}.get(category, category))
    return sorted(result)


def format_tags(tags: dict[str, str], category: str) -> list[str]:
    result: set[str] = set()
    if category in {"park", "playground"}:
        result.add("active")
    if category in {"museum", "event", "landmark"}:
        result.add("educational")
    if category == "restaurant":
        result.add("meal")
    if category in {"toilet", "bench", "shelter"}:
        result.add("utility")
    if tags.get("indoor") == "yes":
        result.add("indoor")
    return sorted(result)


class NodeCollector(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.items: list[dict[str, Any]] = []

    def node(self, node: osmium.osm.Node) -> None:
        if not node.location.valid():
            return
        lon, lat = node.location.lon, node.location.lat
        if not in_city(lon, lat):
            return
        tags = dict(node.tags)
        category = category_for(tags)
        if category is None:
            return
        self.items.append({"osm_type": "node", "osm_id": node.id, "longitude": lon, "latitude": lat, "category": category, "tags": tags})


def deduplicate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer named, more richly tagged points at nearly identical coordinates."""
    chosen: dict[tuple[str, int, int, str], dict[str, Any]] = {}
    for item in items:
        tags = item["tags"]
        title = clean_text(tags.get("name")) or ""
        key = (item["category"], round(item["longitude"] * 10000), round(item["latitude"] * 10000), title.casefold())
        current = chosen.get(key)
        if current is None or len(tags) > len(current["tags"]):
            chosen[key] = item
    return list(chosen.values())


def select(items: list[dict[str, Any]], target: int) -> list[dict[str, Any]]:
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in deduplicate(items):
        item["distance_km"] = distance_km(item["longitude"], item["latitude"])
        # Named places are better candidates for later official-site parsing.
        item["sort_key"] = (not bool(clean_text(item["tags"].get("name"))), item["distance_km"], -len(item["tags"]), item["osm_id"])
        by_category[item["category"]].append(item)
    for values in by_category.values():
        values.sort(key=lambda item: item["sort_key"])

    selected: list[dict[str, Any]] = []
    used: set[tuple[str, int]] = set()
    for category, quota in TARGET_QUOTAS.items():
        for item in by_category[category][:quota]:
            selected.append(item)
            used.add((item["osm_type"], item["osm_id"]))
    remaining = sorted((item for values in by_category.values() for item in values if (item["osm_type"], item["osm_id"]) not in used), key=lambda item: item["sort_key"])
    selected.extend(remaining[:max(0, target - len(selected))])
    if len(selected) < target:
        raise ValueError(f"only {len(selected)} eligible OSM nodes found; target is {target}")
    return selected[:target]


def record(item: dict[str, Any], retrieved_at: str) -> dict[str, Any]:
    tags: dict[str, str] = item["tags"]
    category: str = item["category"]
    osm_ref = f"{item['osm_type']}/{item['osm_id']}"
    evidence_id = f"evidence:osm:{item['osm_type']}:{item['osm_id']}"
    title = clean_text(tags.get("name")) or f"{category} OSM {item['osm_id']}"
    description = clean_text(tags.get("description") or tags.get("short_description"))
    website = tags.get("website") or tags.get("contact:website")
    return {
        "schema_version": "osm-enrichment-v1",
        "place": {
            "place_id": f"place:osm:{item['osm_type']}:{item['osm_id']}", "name": title,
            "location": {"longitude": item["longitude"], "latitude": item["latitude"]},
            "address": address(tags), "categories": [category],
            "display_class": "family" if category in {"park", "playground", "restaurant", "toilet", "bench", "shelter"} else "neutral",
            "website": website, "osm_ref": osm_ref,
            "facts": {
                "indoor": flag(tags, "indoor"),
                "toilet": known(True) if category == "toilet" else flag(tags, "toilets"),
                "shelter": known(True) if category == "shelter" else flag(tags, "covered"),
                "seating": known(True) if category == "bench" else flag(tags, "seats"),
                "access": {"state": "known", "value": tags["access"]} if "access" in tags else {"state": "unknown", "value": None},
                "opening_hours": {"state": "known", "value": tags["opening_hours"]} if "opening_hours" in tags else {"state": "unknown", "value": None},
                "fee": flag(tags, "fee"),
            },
        },
        "activity": {
            "activity_id": f"activity:osm:{item['osm_type']}:{item['osm_id']}:visit", "kind": "utility" if category in {"toilet", "bench", "shelter"} else "visit",
            "title": title, "description_text": description, "topics": topics(tags, category), "formats": format_tags(tags, category),
            "duration_minutes": None, "duration_origin": "unknown", "opening_hours": [], "occurrences": [],
            "hard_age_min": None, "hard_age_max": None, "recommended_age_min": None, "recommended_age_max": None,
            "age_fit": {"3-5": None, "6-8": None, "9-11": None},
        },
        "evidence": [{"evidence_id": evidence_id, "source_kind": "osm", "source_url": f"https://www.openstreetmap.org/{osm_ref}", "checked_at": retrieved_at, "valid_until": None}],
        "provenance": {"source_kind": "osm", "source_ref": osm_ref, "retrieved_at": retrieved_at, "facts_checked_at": None, "raw_tags": tags},
    }


def parse_seed(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def parse_point(value: str) -> tuple[float, float]:
    match = re.fullmatch(r"POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)", value.strip())
    if not match:
        raise ValueError(f"invalid source point: {value!r}")
    return float(match.group(1)), float(match.group(2))


def source_matches(records: list[dict[str, Any]], seed_rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for row in seed_rows:
        lon, lat = parse_point(row["coordinate"])
        normalized = re.sub(r"\W+", "", row["title"].casefold())
        best: tuple[float, dict[str, Any]] | None = None
        for record_item in records:
            place = record_item["place"]
            location = place["location"]
            distance = point_distance_km(lon, lat, location["longitude"], location["latitude"])
            same_name = normalized and normalized == re.sub(r"\W+", "", place["name"].casefold())
            if same_name or distance <= 0.08:
                candidate = (distance, record_item)
                if best is None or candidate[0] < best[0]:
                    best = candidate
        matches.append({"source_dataset": "tourism_csv", "source_id": row["id"], "source_title": row["title"], "source_address": row["address"], "matched_place_id": best[1]["place"]["place_id"] if best else None, "match_distance_km": round(best[0], 4) if best else None, "match_method": "name_or_80m" if best else "unmatched"})
    return matches


def report(records: list[dict[str, Any]], seed_matches: list[dict[str, Any]], pbf: Path, target: int) -> dict[str, Any]:
    categories = Counter(record["place"]["categories"][0] for record in records)
    tag_counts = Counter()
    for record_item in records:
        for key in record_item["provenance"]["raw_tags"]:
            tag_counts[key] += 1
    return {
        "schema_version": "osm-enrichment-report-v1", "catalog_version": f"osm-nizhny-{datetime.now(UTC):%Y%m%d}",
        "target_count": target, "record_count": len(records), "source_pbf": str(pbf), "source_sha256": file_sha256(pbf),
        "bbox": {"min_lon": CITY_BBOX[0], "min_lat": CITY_BBOX[1], "max_lon": CITY_BBOX[2], "max_lat": CITY_BBOX[3]},
        "category_counts": dict(sorted(categories.items())), "seed_source_rows": len(seed_matches), "seed_matches": sum(match["matched_place_id"] is not None for match in seed_matches),
        "coverage": {"coordinates": 100.0, "source_evidence": 100.0, "opening_hours_from_osm": round(sum(record["place"]["facts"]["opening_hours"]["state"] == "known" for record in records) / len(records) * 100, 1), "website_from_osm": round(sum(record["place"]["website"] is not None for record in records) / len(records) * 100, 1), "age_fit": 0.0, "duration": 0.0, "sessions": 0.0},
        "top_raw_tags": tag_counts.most_common(30),
        "known_limitations": ["OSM-only snapshot; it does not verify official hours, admissions, age rules, menu or event sessions.", "Absence of a tag is represented as unknown, never false.", "Only OSM nodes are selected in this first pass; polygonal parks and buildings need a separate geometry pass."],
    }


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def write_outputs(records: list[dict[str, Any]], seed_rows: list[dict[str, str]], output: Path, pbf: Path, target: int) -> None:
    output.mkdir(parents=True, exist_ok=True)
    retrieved_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    catalog = [record(item, retrieved_at) for item in records]
    with (output / "catalog.jsonl").open("w", encoding="utf-8") as destination:
        for item in catalog:
            destination.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    with (output / "parsing_queue.csv").open("w", encoding="utf-8", newline="") as destination:
        fields = ("priority", "place_id", "title", "category", "website", "osm_url", "opening_hours_raw", "missing_fields", "parse_status")
        writer = csv.DictWriter(destination, fieldnames=fields)
        writer.writeheader()
        for item in catalog:
            place, activity = item["place"], item["activity"]
            category = place["categories"][0]
            priority = "high" if category in {"museum", "event", "playground", "restaurant", "toilet", "shelter"} else "medium"
            writer.writerow({"priority": priority, "place_id": place["place_id"], "title": place["name"], "category": category, "website": place["website"] or "", "osm_url": item["evidence"][0]["source_url"], "opening_hours_raw": place["facts"]["opening_hours"]["value"] or "", "missing_fields": "official_url|age_rules|recommended_age|duration|availability|sessions", "parse_status": "pending_official_source" if place["website"] else "needs_source_discovery"})
    matches = source_matches(catalog, seed_rows)
    with (output / "source_dataset_mapping.csv").open("w", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(destination, fieldnames=("source_dataset", "source_id", "source_title", "source_address", "matched_place_id", "match_distance_km", "match_method"))
        writer.writeheader()
        writer.writerows(matches)
    (output / "coverage_report.json").write_text(json.dumps(report(catalog, matches, pbf, target), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pbf", type=Path, default=DEFAULT_PBF)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--target", type=int, default=1000)
    args = parser.parse_args()
    if args.target <= 0:
        raise ValueError("target must be positive")
    collector = NodeCollector()
    collector.apply_file(str(args.pbf), locations=False)
    selected = select(collector.items, args.target)
    write_outputs(selected, parse_seed(args.seed), args.output, args.pbf, args.target)
    print(json.dumps({"eligible_nodes": len(collector.items), "selected": len(selected), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
