"""Conservative seed-to-OSM entity candidates; proximity alone is insufficient."""

import math
import re
import unicodedata


COMPATIBLE = {
    "Памятники": {"landmark"}, "Достопримечательности": {"landmark", "museum"},
    "Парки и места отдыха": {"park"}, "Набережные": {"landmark", "park"},
    "Музеи и выставочные центры": {"museum"}, "Театры": {"event"},
    "Культурно-развлекательные организации": {"other", "museum", "event"},
    "Мозаика": {"landmark"}, "Тактильный объект": {"landmark"}, "Города-побратимы": {"landmark"},
}


def normalize_name(value):
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", value)).strip()


def separation_m(left, right):
    lon1, lat1, lon2, lat2 = map(math.radians, (*left, *right))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, a)))


def source_match_candidates(records, seed_rows, max_distance_m=300):
    by_name = {}
    for record in records:
        by_name.setdefault(normalize_name(record["place"]["name"]), []).append(record)
    result = []
    for row in seed_rows:
        point = tuple(map(float, re.fullmatch(r"POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)", row["coordinate"].strip()).groups()))
        matches = []
        for record in by_name.get(normalize_name(row["title"]), []):
            place = record["place"]
            if not set(place["categories"]) & COMPATIBLE.get(row["category"], set()):
                continue
            location = place["location"]
            distance = separation_m(point, (location["longitude"], location["latitude"]))
            if distance <= max_distance_m:
                matches.append((distance, place["place_id"]))
        unique = len(matches) == 1
        result.append({"source_dataset": row.get("source_dataset", "tourism_csv"), "source_id": row["id"],
                       "source_title": row["title"], "source_address": row["address"],
                       "matched_place_id": matches[0][1] if unique else None,
                       "match_distance_km": round(matches[0][0] / 1000, 4) if unique else None,
                       "match_method": "exact_name_nearby_candidate" if unique else "ambiguous" if matches else "unmatched"})
    return result
