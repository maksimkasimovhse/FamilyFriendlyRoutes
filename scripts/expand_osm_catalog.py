"""Adapt additional visitor POIs from the saved OSM snapshot without fake facts."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from copy import deepcopy
from pathlib import Path

from catalog_features import build_embedding_text
from source_matching import normalize_name, separation_m
from prepare_demo_catalog import TOPIC_PATTERNS, short_description, distance_km


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl"
POLICY = ROOT / "data/catalog/osm_expansion_policy.json"
LABELS = {"museum": "Музеи и галереи", "event": "Культурные площадки", "park": "Парки и развлечения",
          "playground": "Детские площадки", "landmark": "Достопримечательности", "other": "Библиотеки"}
TYPE_NAMES = {"museum": "Музей", "event": "Культурная площадка", "park": "Парк развлечений",
              "playground": "Детская площадка", "landmark": "Достопримечательность", "other": "Библиотека"}
STOP_WORDS = {"музей", "музея", "истории", "история", "памятник", "имени", "центр", "культуры", "парк",
              "нижний", "нижнего", "новгород", "новгорода", "нижегородский", "государственный", "детская",
              "библиотека", "районная", "центральная", "городская", "выставочный", "галерея", "театр"}


def distinctive(value):
    return {word[:5] if len(word) >= 5 else word for word in normalize_name(value).split()
            if len(word) >= 3 and word not in STOP_WORDS}


def related(left, right):
    cultural = {"museum", "landmark", "event", "other"}
    return left == right or left in cultural and right in cultural


def adapt_record(source):
    original = source["place"]
    tags = source["provenance"]["raw_tags"]
    category = original["categories"][0]
    title = tags.get("name") or TYPE_NAMES[category]
    description = short_description(tags.get("description") or tags.get("short_description") or TYPE_NAMES[category] + ".")
    content = (title + " " + description).casefold()
    topics = {topic for topic, patterns in TOPIC_PATTERNS.items() if any(pattern in content for pattern in patterns)}
    if re.search(r"шоколад|кулинар|конфет", content):
        topics.add("cooking")
    if re.search(r"зоолог|животн|фауна", content):
        topics.add("animals")
    if re.search(r"геолог|минерал", content):
        topics.update(("science", "nature"))
    if tags.get("historic"):
        topics.add("history")
    formats = {"educational"}
    if category == "playground":
        topics, formats = set(), {"playful", "active"}
    elif category == "other":
        topics = {"literature"}
    elif category == "event":
        topics = {"theatre"} if tags.get("amenity") in {"theatre", "cinema"} else {"art"}
        formats = {"spectacular"}
    elif category == "park":
        topics, formats = set(), {"playful", "active"}
    text, fingerprint = build_embedding_text(title, description, tuple(sorted(topics)), tuple(sorted(formats)))
    evidence = deepcopy(source["evidence"])
    evidence_ids = [item["evidence_id"] for item in evidence]
    facts = {}
    for field in ("indoor", "toilet", "shelter", "seating"):
        original_fact = original["facts"][field]
        facts[field] = {**original_fact, "evidence_ids": evidence_ids if original_fact["state"] == "known" else []}
    location = deepcopy(original["location"])
    warnings = [{"code": "OSM_SOURCE_UNVERIFIED", "message": "Условия посещения из дополнительного источника ещё не подтверждены."}]
    if category == "event":
        warnings.append({"code": "PROGRAM_NOT_CONFIRMED", "message": "Это площадка; конкретная программа или сеанс не подтверждены."})
    return {
        "schema_version": "city-osm-catalog-v1",
        "place": {"place_id": original["place_id"], "source_dataset": "osm", "source_id": original["osm_ref"],
                  "title": title, "address": original.get("address"), "location": location,
                  "distance_from_center_km": round(distance_km((location["longitude"], location["latitude"])), 3),
                  "category": category, "category_original": LABELS[category], "official_url": None,
                  "website_candidate": original.get("website"), "opening_hours_raw": tags.get("opening_hours"), "facts": facts},
        "activity": {"activity_id": source["activity"]["activity_id"], "kind": "visit", "title": title,
                     "description_text": description, "topics": sorted(topics), "formats": sorted(formats),
                     "duration_minutes": None, "opening_hours": [], "occurrences": [], "hard_age_min": None,
                     "hard_age_max": None, "recommended_age_min": None, "recommended_age_max": None,
                     "age_fit": {"3-5": None, "6-8": None, "9-11": None}},
        "features": {"features_version": "catalog-text-v1", "embedding_text": text, "embedding_input_sha256": fingerprint,
                     "topic_origin": "heuristic_model", "format_origin": "heuristic_model",
                     "description_origin": "osm_description" if tags.get("description") else "category_label"},
        "provenance": {**deepcopy(source["provenance"]), "content_sha256": hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                       "facts_checked_at": None}, "evidence": evidence, "source_aliases": [], "data_quality_warnings": warnings,
    }


def expand_catalog(seed_records, source_path=SOURCE, policy_path=POLICY):
    policy = json.loads(policy_path.read_text())
    raw = source_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != policy["source_snapshot_sha256"]:
        raise ValueError("OSM snapshot changed; expansion policy must be reviewed")
    sources = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    sources.sort(key=lambda r: (-bool(r["provenance"]["raw_tags"].get("name")), -len(r["provenance"]["raw_tags"]), r["place"]["place_id"]))
    added, decisions = [], []
    for source in sources:
        place = source["place"]
        tags = source["provenance"]["raw_tags"]
        category = place["categories"][0]
        ref = place["osm_ref"]
        name = tags.get("name", "")
        code, note, possible = "included", "", []
        if ref in policy["holds"]:
            code, note = "MANUAL_REVIEW", policy["holds"][ref]
        elif category not in policy["categories"]:
            code, note = "SUPPORT_OBJECT", "Ресторан или инфраструктура: отдельный поиск, не развлечение в начальном пуле."
        elif tags.get("access") in {"no", "private", "customers"}:
            code, note = "RESTRICTED_ACCESS", "Источник указывает ограниченный доступ."
        elif tags.get("addr:city", "").casefold() in {"бор", "дзержинск"}:
            code, note = "OTHER_CITY", "Другой город по адресу источника."
        elif category == "playground" and not (name or tags.get("access") == "yes"):
            code, note = "ACCESS_REVIEW", "Для безымянной площадки нет явного тега открытого доступа."
        elif category == "other" and (tags.get("amenity") != "library" or normalize_name(name) == "библиотека"):
            code, note = "PROGRAM_REVIEW", "Организации и неспецифицированные объекты требуют отдельной программы."
        elif re.search(r"школ|училищ|университет|ННГАСУ|ННГУ|ВВАГС|крепких напитков", name, re.I):
            code, note = "PROGRAM_REVIEW", "Нужны подтверждённые условия разового семейного посещения."
        elif category == "landmark" and (tags.get("memorial") in {"plaque", "stone", "cross", "stele"}
                or tags.get("historic") in {"tomb", "ruins", "truck", "field_kitchen", "cannon", "tank"}
                or tags.get("memorial") == "aircraft"):
            code, note = "MAP_OR_EXHIBIT_ONLY", "Табличка, малый объект или отдельный экспонат не становится самостоятельным посещением."
        if code == "included":
            point = (place["location"]["longitude"], place["location"]["latitude"])
            for record in seed_records + added:
                other = record["place"]
                location = other["location"]
                separation = separation_m(point, (location["longitude"], location["latitude"]))
                from_seed = other["source_dataset"] != "osm"
                near_limit = policy["nearby_seed_review_m"] if from_seed else policy["nearby_osm_review_m"]
                same = normalize_name(name) == normalize_name(other["title"])
                similar = bool(distinctive(name) & distinctive(other["title"]))
                if related(category, other["category"]) and (separation < near_limit or (
                    separation < policy["similar_name_review_m"] and (same or similar)
                )):
                    possible.append(other["place_id"])
            if possible:
                code, note = "OVERLAP_REVIEW", "Возможное пересечение с существующей записью; тождество не утверждается и факты не переносятся."
        if code == "included":
            added.append(adapt_record(source))
        decisions.append({"source_dataset": "osm", "source_id": ref, "source_title": place["name"],
                          "status": "included" if code == "included" else "held", "decision_code": code,
                          "canonical_place_id": place["place_id"] if code == "included" else "",
                          "canonical_activity_id": source["activity"]["activity_id"] if code == "included" else "",
                          "reason": note, "possible_overlap_ids": possible})
    added.sort(key=lambda r: r["place"]["place_id"])
    return added, {"catalog_version": policy["catalog_version"], "review_version": policy["review_version"],
                   "source_snapshot_sha256": digest, "source_records": len(sources), "added_records": len(added),
                   "added_by_category": dict(Counter(r["place"]["category"] for r in added)),
                   "decisions": dict(Counter(d["decision_code"] for d in decisions)), "verification_urls": policy["verification_urls"]}, decisions
