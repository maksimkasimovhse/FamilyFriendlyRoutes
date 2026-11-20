"""Build a small, honest demo catalog from the checked-in city dataset."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))

from catalog_features import FEATURES_VERSION, build_embedding_text  # noqa: E402


SOURCE = ROOT / "db" / "seed" / "main.csv"
OUTPUT = ROOT / "data" / "demo"
CENTER = (44.0050, 56.3269)
CATEGORY_QUOTAS = {
    "Достопримечательности": 8,
    "Музеи и выставочные центры": 8,
    "Парки и места отдыха": 6,
    "Памятники": 5,
    "Культурно-развлекательные организации": 5,
    "Театры": 4,
    "Набережные": 4,
}
CATEGORY_IDS = {
    "Достопримечательности": "landmark",
    "Музеи и выставочные центры": "museum",
    "Парки и места отдыха": "park",
    "Памятники": "landmark",
    "Культурно-развлекательные организации": "other",
    "Театры": "event",
    "Набережные": "landmark",
}
TOPIC_PATTERNS = {
    "animals": ("зоопарк", "животн", "фауна", "лошад"),
    "plants": ("ботан", "растен", "цвет", "флора"),
    "nature": ("природ", "парк", "сад", "набереж", "озелен"),
    "space": ("космос", "планетар", "астроном"),
    "science": ("наук", "эксперимент", "лаборатор"),
    "technology": ("техник", "инженер", "радио", "компьют"),
    "transport": ("транспорт", "паровоз", "автомоб", "трамва", "железн"),
    "history": ("истори", "старин", "кремл", "войн", "купец", "археолог"),
    "architecture": ("архитект", "здание", "усадьб", "собор", "церков"),
    "art": ("искусств", "картин", "галере", "скульп", "худож"),
    "music": ("музык", "оркестр", "концерт", "филармон"),
    "theatre": ("театр", "спектак", "сцен"),
    "literature": ("литератур", "писател", "библиот", "книг"),
    "crafts": ("ремес", "промыс", "мастер-класс", "мастерск"),
    "sport": ("спорт", "стадион", "физкультур"),
}


def clean_description(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", html.unescape(value))
    return re.sub(r"\s+", " ", value).strip()


def short_description(value: str, limit: int = 1200) -> str:
    cleaned = clean_description(value)
    if len(cleaned) <= limit:
        return cleaned
    boundary = cleaned.rfind(". ", int(limit * 0.6), limit)
    return cleaned[:boundary + 1 if boundary >= 0 else limit].rstrip()


def parse_point(value: str) -> tuple[float, float]:
    match = re.fullmatch(r"POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)", value.strip())
    if not match:
        raise ValueError(f"invalid WKT point: {value!r}")
    return float(match.group(1)), float(match.group(2))


def distance_km(point: tuple[float, float], center: tuple[float, float] = CENTER) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*point, *center))
    delta_lon, delta_lat = lon2 - lon1, lat2 - lat1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(value))


def infer_topics(text: str, category: str) -> tuple[str, ...]:
    source = text.casefold()
    topics = {topic for topic, patterns in TOPIC_PATTERNS.items() if any(pattern in source for pattern in patterns)}
    if not topics:
        if category in ("Парки и места отдыха", "Набережные"):
            topics.add("nature")
        elif category == "Театры":
            topics.add("theatre")
        elif category == "Культурно-развлекательные организации":
            topics.add("art")
        else:
            topics.add("history")
    return tuple(sorted(topics))


def infer_formats(text: str, category: str) -> tuple[str, ...]:
    source = text.casefold()
    formats: set[str] = set()
    if category in ("Парки и места отдыха", "Набережные"):
        formats.update(("active", "calm"))
    elif category == "Театры":
        formats.add("spectacular")
    else:
        formats.add("educational")
    if any(value in source for value in ("мастер-класс", "творческ", "мастерск")):
        formats.add("creative")
    if any(value in source for value in ("игров", "игра", "интерактив")):
        formats.add("playful")
    return tuple(sorted(formats))


def read_rows(path: Path = SOURCE) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open(encoding="utf-8-sig", newline="") as source:
        for raw in csv.DictReader(source):
            point = parse_point(raw["coordinate"])
            rows.append({**raw, "point": point, "distance_km": distance_km(point)})
    return rows


def select_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    selected: list[dict[str, object]] = []
    for category, quota in CATEGORY_QUOTAS.items():
        candidates = [row for row in rows if row["category"] == category]
        candidates.sort(key=lambda row: (float(row["distance_km"]), int(str(row["id"]))))
        if len(candidates) < quota:
            raise ValueError(f"category {category!r} has {len(candidates)} rows, expected {quota}")
        selected.extend(candidates[:quota])
    selected.sort(key=lambda row: (float(row["distance_km"]), str(row["category"]), int(str(row["id"]))))
    return selected


def build_record(row: dict[str, object]) -> dict[str, object]:
    source_id = str(row["id"])
    title = str(row["title"]).strip()
    category = str(row["category"])
    description = short_description(str(row["description"]))
    topics = infer_topics(f"{title} {description}", category)
    formats = infer_formats(f"{title} {description}", category)
    embedding_text, fingerprint = build_embedding_text(title, description, topics, formats)
    lon, lat = row["point"]  # type: ignore[misc]
    content_hash = hashlib.sha256(
        json.dumps({key: row[key] for key in ("id", "title", "address", "coordinate", "description", "category")},
                   ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        "schema_version": "demo-catalog-v1",
        "place": {
            "place_id": f"place:main:{source_id}",
            "source_dataset": "main",
            "source_id": source_id,
            "title": title,
            "address": str(row["address"]).strip(),
            "location": {"longitude": lon, "latitude": lat},
            "distance_from_center_km": round(float(row["distance_km"]), 3),
            "category_original": category,
            "category": CATEGORY_IDS[category],
            "official_url": None,
        },
        "activity": {
            "activity_id": f"activity:main:{source_id}:visit",
            "kind": "visit",
            "title": title,
            "description_text": description,
            "topics": list(topics),
            "formats": list(formats),
            "duration_minutes": None,
            "opening_hours": [],
            "occurrences": [],
            "hard_age_min": None,
            "hard_age_max": None,
            "recommended_age_min": None,
            "recommended_age_max": None,
            "age_fit": {"3-5": None, "6-8": None, "9-11": None},
        },
        "features": {
            "features_version": FEATURES_VERSION,
            "embedding_text": embedding_text,
            "embedding_input_sha256": fingerprint,
            "topic_origin": "heuristic_model",
            "format_origin": "heuristic_model",
            "description_origin": "seed_excerpt",
        },
        "provenance": {
            "source_kind": "seed_dataset",
            "content_sha256": content_hash,
            "facts_checked_at": None,
        },
    }


def coverage(records: list[dict[str, object]]) -> dict[str, object]:
    total = len(records)
    fields = Counter()
    categories = Counter()
    topics = Counter()
    for record in records:
        place = record["place"]  # type: ignore[assignment]
        activity = record["activity"]  # type: ignore[assignment]
        categories[place["category_original"]] += 1  # type: ignore[index]
        topics.update(activity["topics"])  # type: ignore[index]
        fields["coordinates"] += bool(place["location"])  # type: ignore[index]
        fields["description"] += bool(activity["description_text"])  # type: ignore[index]
        fields["topics"] += bool(activity["topics"])  # type: ignore[index]
        fields["formats"] += bool(activity["formats"])  # type: ignore[index]
        fields["official_url"] += bool(place["official_url"])  # type: ignore[index]
        fields["duration"] += activity["duration_minutes"] is not None  # type: ignore[index]
        fields["opening_hours"] += bool(activity["opening_hours"])  # type: ignore[index]
        fields["age_fit"] += any(value is not None for value in activity["age_fit"].values())  # type: ignore[index, union-attr]
    return {
        "schema_version": "demo-coverage-v1",
        "record_count": total,
        "category_counts": dict(sorted(categories.items())),
        "topic_counts": dict(sorted(topics.items())),
        "field_coverage": {
            field: {"known": fields[field], "total": total, "percent": round(fields[field] / total * 100, 1)}
            for field in ("coordinates", "description", "topics", "formats", "official_url", "duration", "opening_hours", "age_fit")
        },
        "next_enrichment_order": ["official_url", "opening_hours", "duration", "age_fit"],
    }


def write_outputs(records: list[dict[str, object]], output: Path = OUTPUT) -> None:
    output.mkdir(parents=True, exist_ok=True)
    with (output / "catalog.jsonl").open("w", encoding="utf-8") as target:
        for record in records:
            target.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    (output / "coverage_report.json").write_text(
        json.dumps(coverage(records), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    with (output / "parsing_queue.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=("priority", "place_id", "title", "category", "address", "official_url", "missing_fields"))
        writer.writeheader()
        for record in records:
            place = record["place"]
            priority = "high" if place["category_original"] in ("Музеи и выставочные центры", "Театры") else "medium"
            writer.writerow({
                "priority": priority,
                "place_id": place["place_id"],
                "title": place["title"],
                "category": place["category_original"],
                "address": place["address"],
                "official_url": "",
                "missing_fields": "official_url|opening_hours|duration|age_fit",
            })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    records = [build_record(row) for row in select_rows(read_rows(args.source))]
    write_outputs(records, args.output)
    print(json.dumps(coverage(records), ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
