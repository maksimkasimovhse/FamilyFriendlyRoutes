"""Audit the supplied tourism CSVs and build a reviewed city recommendation slice."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import shutil
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))

from prepare_demo_catalog import build_record, clean_description, coverage, distance_km, parse_point, write_outputs
from catalog_features import build_embedding_text
from source_matching import source_match_candidates
from expand_osm_catalog import expand_catalog


PILOT_BBOX = (43.5, 56.05, 44.4, 56.6)  # Same operational bounds as internal/routing/client.go.
CITY_CORE_BBOX = (43.75, 56.20, 44.15, 56.38)  # Sampling extent, not an administrative boundary.
REQUIRED = ("id", "address", "coordinate", "description", "title", "category")
DEFAULT_OUTPUT = ROOT / "data/catalog/city"


def normalized_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", value)).strip()


def in_bbox(point: tuple, bbox: tuple) -> bool:
    return bbox[0] <= point[0] <= bbox[2] and bbox[1] <= point[1] <= bbox[3]


def duplicate_groups(rows: list[dict], key) -> list[list[str]]:
    groups = defaultdict(list)
    for row in rows:
        groups[key(row)].append(row["id"])
    return [ids for ids in groups.values() if len(ids) > 1]


def audit_csv(path: Path) -> tuple[list[dict], dict]:
    raw = path.read_bytes()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames or []
        if len(columns) != len(set(columns)) or set(columns) != set(REQUIRED):
            raise ValueError(f"{path.name}: unexpected or repeated columns")
        rows = list(reader)
    invalid = []
    outside_core = []
    descriptions = []
    for row in rows:
        try:
            if None in row or any(not isinstance(row.get(c), str) or not row[c].strip() for c in REQUIRED):
                raise ValueError("missing field or wrong CSV row width")
            point = parse_point(row["coordinate"])
            if not all(math.isfinite(v) for v in point) or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                raise ValueError("coordinates outside global bounds")
            if not in_bbox(point, PILOT_BBOX):
                raise ValueError("coordinates outside routing pilot")
            if not in_bbox(point, CITY_CORE_BBOX):
                outside_core.append({"source_id": row["id"], "title": row["title"], "address": row["address"], "point": point})
            row["point"], row["distance_km"] = point, distance_km(point)
            descriptions.append(len(clean_description(row["description"])))
        except ValueError as error:
            invalid.append({"source_id": row.get("id"), "error": str(error)})
    ids = duplicate_groups(rows, lambda r: r["id"])
    if ids:
        invalid.append({"duplicate_ids": ids})
    report = {
        "file": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
        "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "rows": len(rows), "columns": columns,
        "missing_values": {c: sum(not (r.get(c) or "").strip() for r in rows) for c in REQUIRED},
        "categories": dict(sorted(Counter(str(r.get("category") or "") for r in rows).items())),
        "invalid_rows": invalid, "outside_core_sampling_bbox": outside_core,
        "normalized_name_groups": duplicate_groups(rows, lambda r: normalized_title(str(r.get("title") or ""))),
        "shared_coordinate_groups": duplicate_groups(rows, lambda r: r.get("point", r["coordinate"])),
        "exact_record_duplicates": duplicate_groups(rows, lambda r: tuple(r[c] for c in REQUIRED if c != "id")),
        "description_length": {"min": min(descriptions, default=0), "max": max(descriptions, default=0)},
        "semantic_fields_absent": ["official_url", "opening_hours", "visit_duration", "age_fit", "admission", "event_sessions", "price", "entrance_coordinates"],
        "published_at": None, "content_verified_at": None,
    }
    return rows, report


def audit_osm_mapping(main: list[dict], addition: list[dict]) -> dict:
    path = ROOT / "data/enriched/osm_nizhny_1000/source_dataset_mapping.csv"
    if not path.exists():
        return {"available": False}
    with path.open(encoding="utf-8-sig") as handle:
        mappings = list(csv.DictReader(handle))
    osm = {r["place"]["place_id"]: r for r in map(json.loads, (ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl").read_text().splitlines())}
    main_ids = {r["id"] for r in main}
    sources = {r["id"]: r for r in main + addition}
    suspect = []
    normalized_mismatches = 0
    for mapping in mappings:
        record = osm.get(mapping["matched_place_id"])
        if not record:
            continue
        row = sources.get(mapping["source_id"])
        if row and normalized_title(row["title"]) != normalized_title(record["place"]["name"]):
            normalized_mismatches += 1
        categories = record["place"]["categories"]
        if row and mapping["source_id"] in main_ids and set(categories) & {"bench", "toilet", "shelter", "restaurant", "playground"}:
            suspect.append({"source_id": mapping["source_id"], "source_title": row["title"],
                            "matched_place_id": mapping["matched_place_id"], "matched_title": record["place"]["name"],
                            "matched_categories": categories, "match_method": mapping["match_method"]})
    return {"available": True, "rows": len(mappings), "matched": sum(bool(m["matched_place_id"]) for m in mappings),
            "matched_with_different_normalized_title": normalized_mismatches,
            "incompatible_type_candidates": suspect,
            "conclusion": "name_or_80m is a candidate linkage, not verified identity; no OSM facts are copied to seed places"}


def audit_import(path: Path, existing: dict[str, list[dict]]) -> dict:
    rows, audit = audit_csv(path)
    index = defaultdict(list)
    for dataset, values in existing.items():
        for row in values:
            index[row["id"]].append((dataset, row))
    matches, conflicts, novel = [], [], []
    for row in rows:
        candidates = index.get(row["id"], [])
        equal = [dataset for dataset, original in candidates if all(row[key] == original[key] for key in REQUIRED)]
        if equal:
            matches.append({"source_id": row["id"], "matches_dataset": equal[0]})
        elif candidates:
            conflicts.append({"source_id": row["id"], "title": row["title"],
                              "differing_fields": [key for key in REQUIRED if row[key] != candidates[0][1][key]]})
        else:
            novel.append({key: row[key] for key in REQUIRED})
    return {"file": path.name, "sha256": audit["sha256"], "rows": len(rows),
            "invalid_rows": audit["invalid_rows"], "identical_existing_records": len(matches),
            "matches": matches, "id_conflicts": conflicts, "new_record_candidates": novel,
            "result": "already_present" if len(matches) == len(rows) and not audit["invalid_rows"] else "review_required"}


def build_city_catalog(seed: Path = ROOT / "db/seed", decisions_path: Path = ROOT / "data/catalog/seed_review_decisions.json") -> tuple[list[dict], dict, list[dict]]:
    datasets, audits = {}, {}
    for name in ("main", "addition"):
        datasets[name], audits[name] = audit_csv(seed / (name + ".csv"))
    decisions = json.loads(decisions_path.read_text())
    for name, audit in audits.items():
        if audit["invalid_rows"]:
            raise ValueError(f"{name}: invalid input rows; inspect source before publishing")
        if audit["sha256"] != decisions["source_sha256"][name]:
            raise ValueError(f"{name}: input changed; review decisions must be reassessed")
    source = {r["id"]: r for r in datasets["main"]}
    holds = {r["source_id"]: r for r in decisions["holds"]}
    merges = {r["source_id"]: r for r in decisions["merges"]}
    overrides = {r["source_id"]: r for r in decisions["title_overrides"]}
    reviewed_ids = set(holds) | set(merges) | set(overrides)
    if not reviewed_ids <= source.keys():
        raise ValueError("review references an absent source ID")
    if set(holds) & set(merges):
        raise ValueError("review statuses conflict")
    for duplicate_id, merge in merges.items():
        canonical_id = merge["canonical_source_id"]
        if canonical_id not in source or canonical_id in holds or canonical_id in merges:
            raise ValueError("merge target is absent, held or another alias")
        left, right = source[duplicate_id], source[canonical_id]
        if any(normalized_title(left[key]) != normalized_title(right[key]) for key in ("title", "category", "address")):
            raise ValueError("merge needs matching title, category and address")
    records, mapping = [], []
    for row in datasets["main"]:
        sid = row["id"]
        target = merges.get(sid, {}).get("canonical_source_id", sid)
        state = "held" if sid in holds else "alias" if sid in merges else "included"
        mapping.append({"source_dataset": "main", "source_id": sid, "source_title": row["title"], "status": state,
                        "canonical_place_id": "place:main:" + target if state != "held" else "",
                        "canonical_activity_id": f"activity:main:{target}:visit" if state != "held" else "",
                        "reason": holds.get(sid, merges.get(sid, {})).get("reason", "")})
        if state != "included":
            continue
        record = build_record(row)
        record["schema_version"] = "seed-city-catalog-v1"
        record["provenance"]["source_file_sha256"] = audits["main"]["sha256"]
        record["provenance"]["review_version"] = decisions["review_version"]
        record["source_aliases"] = [dup for dup, value in merges.items() if value["canonical_source_id"] == sid]
        record["data_quality_warnings"] = []
        if sid in overrides:
            override = overrides[sid]
            if override["source_quote"] not in clean_description(row["description"]):
                raise ValueError("title override lacks its exact source quote")
            record["place"]["title"] = record["activity"]["title"] = override["title"]
            record["provenance"]["title_override"] = override
            text, fingerprint = build_embedding_text(override["title"], record["activity"]["description_text"],
                                                     tuple(record["activity"]["topics"]), tuple(record["activity"]["formats"]))
            record["features"]["embedding_text"] = text
            record["features"]["embedding_input_sha256"] = fingerprint
        for conflict in decisions["description_conflicts"]:
            if sid in conflict["source_ids"]:
                record["data_quality_warnings"].append({"code": conflict["code"], "message": conflict["reason"]})
        records.append(record)
    for row in datasets["addition"]:
        mapping.append({"source_dataset": "addition", "source_id": row["id"], "source_title": row["title"], "status": "map_only",
                        "canonical_place_id": "place:addition:" + row["id"], "canonical_activity_id": "",
                        "reason": "Отдельный объект карты; не самостоятельная рекомендованная активность."})
    records.sort(key=lambda r: int(r["place"]["source_id"]))
    all_ids = [r["id"] for rows in datasets.values() for r in rows]
    report = {
        "schema_version": "case-seed-audit-v1", "catalog_version": decisions["catalog_version"],
        "sources": audits, "source_records": len(all_ids), "cross_dataset_id_overlap": sorted(set(r["id"] for r in datasets["main"]) & set(r["id"] for r in datasets["addition"])),
        "recommendable_records": len(records), "status_counts": dict(Counter(m["status"] for m in mapping)),
        "review_decisions": decisions, "osm_mapping_audit": audit_osm_mapping(datasets["main"], datasets["addition"]),
        "interpretation": "Structurally valid place directory, not training labels or verified family visit conditions. Shared positions in addition may represent separate artworks in one metro station.",
    }
    return records, report, mapping


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-csv", action="append", type=Path, default=[])
    args = parser.parse_args()
    records, audit, mapping = build_city_catalog()
    existing = {name: audit_csv(ROOT / "db/seed" / (name + ".csv"))[0] for name in ("main", "addition")}
    audit["supplemental_imports"] = []
    registry_path = ROOT / "data/catalog/import_registry.json"
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {"imports": []}
    imports = [(path, path.name) for path in args.import_csv]
    imported_hashes = {hashlib.sha256(path.read_bytes()).hexdigest() for path, _ in imports}
    imports.extend((ROOT / item["snapshot"], item["file"]) for item in registry["imports"]
                   if item["sha256"] not in imported_hashes and (ROOT / item["snapshot"]).exists())
    for path, original_name in imports:
        imported = audit_import(path, existing)
        imported["file"] = original_name
        destination = ROOT / "data/raw/user_imports" / (imported["sha256"] + ".csv")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if path.resolve() != destination.resolve():
            shutil.copyfile(path, destination)
        imported["snapshot"] = str(destination.relative_to(ROOT))
        audit["supplemental_imports"].append(imported)
        entry = {key: imported[key] for key in ("file", "sha256", "snapshot")}
        registry["imports"] = [item for item in registry["imports"] if item["sha256"] != imported["sha256"]] + [entry]
    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n")
    osm_path = ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl"
    if osm_path.exists():
        osm_records = [json.loads(line) for line in osm_path.read_text().splitlines() if line.strip()]
        seeds = [{**row, "source_dataset": dataset} for dataset, values in existing.items() for row in values]
        candidates = source_match_candidates(osm_records, seeds)
        audit["conservative_osm_candidates"] = {"count": sum(bool(c["matched_place_id"]) for c in candidates), "manual_review_required": True}
    seed_count = len(records)
    added, expansion, osm_decisions = expand_catalog(records)
    records.extend(added)
    audit["seed_recommendable_records"] = seed_count
    audit["osm_source_records"] = expansion["source_records"]
    audit["total_source_records"] = audit["source_records"] + expansion["source_records"]
    audit["catalog_version"] = expansion["catalog_version"]
    audit["recommendable_records"] = len(records)
    audit["osm_expansion"] = expansion
    mapping_fields = list(mapping[0])
    mapping.extend({field: decision[field] for field in mapping_fields} for decision in osm_decisions)
    audit["combined_status_counts"] = dict(Counter(item["status"] for item in mapping))
    write_outputs(records, DEFAULT_OUTPUT)
    coverage_report = coverage(records)
    coverage_report.update(schema_version="city-catalog-coverage-v2", catalog_version=audit["catalog_version"],
                           source_counts=dict(Counter(r["place"]["source_dataset"] for r in records)),
                           category_id_counts=dict(Counter(r["place"]["category"] for r in records)),
                           raw_osm_hours_records=sum(bool(r["place"].get("opening_hours_raw")) for r in records))
    (DEFAULT_OUTPUT / "coverage_report.json").write_text(json.dumps(coverage_report, ensure_ascii=False, indent=2) + "\n")
    (DEFAULT_OUTPUT / "osm_expansion_review.json").write_text(json.dumps(osm_decisions, ensure_ascii=False, indent=2) + "\n")
    with (DEFAULT_OUTPUT / "parsing_queue.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["priority", "place_id", "title", "category", "address", "official_url", "candidate_url", "review_status"])
        writer.writeheader()
        for record in records:
            place = record["place"]
            writer.writerow({"priority": "high" if place["category"] in {"museum", "playground", "park"} else "medium",
                             "place_id": place["place_id"], "title": place["title"], "category": place["category"],
                             "address": place.get("address"), "official_url": place.get("official_url"),
                             "candidate_url": place.get("website_candidate"),
                             "review_status": "needs_domain_review" if place.get("website_candidate") else "needs_source_discovery"})
    if osm_path.exists():
        with (DEFAULT_OUTPUT / "osm_source_candidates.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(candidates[0]))
            writer.writeheader(); writer.writerows(candidates)
    catalog = DEFAULT_OUTPUT / "catalog.jsonl"
    manifest = {"catalog_version": audit["catalog_version"], "record_count": len(records),
                "content_sha256": hashlib.sha256(catalog.read_bytes()).hexdigest(), "source_dataset": "challenge_seed_csv_and_osm",
                "seed_records": seed_count, "osm_records": len(added),
                "source_files": {**{name: item["sha256"] for name, item in audit["sources"].items()}, "osm_snapshot": expansion["source_snapshot_sha256"]},
                "review_version": audit["review_decisions"]["review_version"], "osm_review_version": expansion["review_version"]}
    for name, value in (("manifest.json", manifest), ("source_audit.json", audit)):
        (DEFAULT_OUTPUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    with (DEFAULT_OUTPUT / "source_mapping.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(mapping[0]))
        writer.writeheader(); writer.writerows(mapping)
    print(json.dumps({"source_records": audit["source_records"], "catalog_records": len(records),
                      "seed_records": seed_count, "added_osm_records": len(added),
                      "status_counts": audit["combined_status_counts"], "catalog_version": audit["catalog_version"],
                      "imports": [{"file": item["file"], "rows": item["rows"], "already_present": item["identical_existing_records"],
                                   "new_candidates": len(item["new_record_candidates"]), "conflicts": len(item["id_conflicts"])}
                                  for item in audit["supplemental_imports"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
