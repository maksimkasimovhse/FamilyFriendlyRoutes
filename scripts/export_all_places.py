"""Export every source place, including recovered descriptions from public pages.

This is a directory, not a set of verified family recommendations or training labels.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))
from prepare_city_catalog import audit_csv, audit_import
from prepare_demo_catalog import CATEGORY_IDS, clean_description, infer_topics, infer_formats
from source_matching import source_match_candidates

OUT = ROOT / "outputs/all_places_v1"
LABELS = {"restaurant": "Еда", "museum": "Музеи", "landmark": "Достопримечательности",
          "playground": "Детские площадки", "park": "Парки", "event": "Культурные площадки",
          "other": "Прочее", "toilet": "Туалеты", "bench": "Скамейки", "shelter": "Укрытия"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def csv_value(value):
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    # Preserve literal untrusted source text when the CSV is opened in Excel.
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def blank(place_id, name, category, lon, lat):
    return {"schema_version": "all-places-v1", "place_id": place_id, "name": name,
            "category": category, "category_ru": LABELS.get(category, category),
            "subcategory": None, "address": None, "longitude": lon, "latitude": lat,
            "description": None, "website_candidate": None, "phone_raw": None,
            "opening_hours_raw": None, "access_raw": None, "fee_raw": None,
            "wheelchair_raw": None, "indoor": None, "toilet": None, "shelter": None,
            "seating": None, "duration_minutes": None, "hard_age_min": None,
            "hard_age_max": None, "recommended_age_min": None, "recommended_age_max": None,
            "topics": [], "formats": [], "feature_origin": "heuristic",
            "in_mvp": False, "mvp_status": None, "mvp_reason": None,
            "source_dataset": None, "source_id": None, "source_url": None,
            "retrieved_at": None, "facts_checked_at": None,
            "description_origin": "unknown", "description_status": "unknown",
            "description_evidence": [], "description_candidates": [],
            "possible_duplicate_ids": [], "quality_flags": [], "sources": []}


def build(output=OUT):
    seed, audits = {}, {}
    for name in ("main", "addition"):
        seed[name], audits[name] = audit_csv(ROOT / f"db/seed/{name}.csv")
        if audits[name]["invalid_rows"]:
            raise ValueError(f"Invalid input: {name}")
    decisions_path = ROOT / "data/catalog/seed_review_decisions.json"
    decisions = json.loads(decisions_path.read_text())
    for name in seed:
        if audits[name]["sha256"] != decisions["source_sha256"][name]:
            raise ValueError("Seed changed; review merge decisions first")
    merges = {r["source_id"]: r["canonical_source_id"] for r in decisions["merges"]}
    overrides = {r["source_id"]: r["title"] for r in decisions["title_overrides"]}
    mvp_path = ROOT / "data/catalog/city/catalog.jsonl"
    mvp = {r["place"]["place_id"]: r for r in read_jsonl(mvp_path)}
    with (ROOT / "data/catalog/city/source_mapping.csv").open(encoding="utf-8-sig", newline="") as f:
        status = {(r["source_dataset"], r["source_id"]): r for r in csv.DictReader(f)}
    records, mapping = {}, []
    for dataset, rows in seed.items():
        for row in rows:
            sid = row["id"]
            canonical = merges.get(sid, sid) if dataset == "main" else sid
            pid = f"place:{dataset}:{canonical}"
            mapping.append({"source_dataset": dataset, "source_id": sid, "place_id": pid,
                            "relation": "merged_alias" if canonical != sid else "primary"})
            if canonical != sid:
                continue
            category = CATEGORY_IDS.get(row["category"], "landmark" if dataset == "addition" else "other")
            r = blank(pid, overrides.get(sid, row["title"]) if dataset == "main" else row["title"], category, *row["point"])
            r.update(address=row["address"], description=clean_description(row["description"]),
                     subcategory=row["category"], source_dataset=dataset, source_id=sid,
                     description_origin="seed_description", description_status="source_description")
            content = r["name"] + " " + r["description"]
            r["topics"] = list(infer_topics(content, row["category"]))
            r["formats"] = list(infer_formats(content, row["category"]))
            records[pid] = r
    # Store original source rows, including both descriptions of the merged park.
    for dataset, rows in seed.items():
        for row in rows:
            canonical = merges.get(row["id"], row["id"]) if dataset == "main" else row["id"]
            records[f"place:{dataset}:{canonical}"]["sources"].append({
                "dataset": dataset, "id": row["id"], "file": f"db/seed/{dataset}.csv",
                "file_sha256": audits[dataset]["sha256"],
                "original": {k: row[k] for k in ("id", "title", "address", "coordinate", "description", "category")}})
    osm_path = ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl"
    osm = read_jsonl(osm_path)
    review = {r["source_id"]: r for r in json.loads((ROOT / "data/catalog/city/osm_expansion_review.json").read_text())}
    for original in osm:
        p, a, prov = original["place"], original["activity"], original["provenance"]
        tags = prov["raw_tags"]
        r = blank(p["place_id"], p["name"], p["categories"][0], p["location"]["longitude"], p["location"]["latitude"])
        r.update(address=p.get("address"), description=a.get("description_text"),
                 website_candidate=p.get("website"), phone_raw=tags.get("phone") or tags.get("contact:phone"),
                 subcategory=tags.get("amenity") or tags.get("tourism") or tags.get("leisure"),
                 opening_hours_raw=tags.get("opening_hours"), access_raw=tags.get("access"),
                 fee_raw=tags.get("fee"), wheelchair_raw=tags.get("wheelchair"),
                 source_dataset="osm", source_id=p["osm_ref"],
                 source_url=original["evidence"][0]["source_url"], retrieved_at=prov.get("retrieved_at"),
                 topics=a["topics"], formats=a["formats"])
        for field in ("indoor", "toilet", "shelter", "seating"):
            fact = p["facts"][field]
            r[field] = fact["value"] if fact["state"] == "known" else None
        r["sources"] = [{"dataset": "osm", "id": p["osm_ref"], "source_url": r["source_url"],
                          "file_sha256": digest(osm_path), "raw_tags": tags}]
        if not tags.get("name"):
            r["quality_flags"].append("NAME_MISSING")
        r["quality_flags"].append("OSM_CONDITIONS_UNVERIFIED")
        r["possible_duplicate_ids"] = review.get(p["osm_ref"], {}).get("possible_overlap_ids", [])
        records[r["place_id"]] = r
        mapping.append({"source_dataset": "osm", "source_id": p["osm_ref"], "place_id": r["place_id"], "relation": "primary"})
    # The user SQL export is rechecked, not appended a second time.
    imports = []
    registry = json.loads((ROOT / "data/catalog/import_registry.json").read_text())
    for item in registry["imports"]:
        path = ROOT / item["snapshot"]
        if not path.exists():
            raise ValueError(f"Registered source snapshot missing: {item['file']}")
        audit = audit_import(path, seed)
        if audit["sha256"] != item["sha256"] or audit["result"] != "already_present":
            raise ValueError("Additional CSV changed or has new records; review import before export")
        imports.append({"file": item["file"], "sha256": item["sha256"], "rows": audit["rows"], "identical_existing_records": audit["identical_existing_records"]})
        for match in audit["matches"]:
            ds, sid = match["matches_dataset"], match["source_id"]
            canonical = merges.get(sid, sid) if ds == "main" else sid
            mapping.append({"source_dataset": item["file"], "source_id": sid,
                            "place_id": f"place:{ds}:{canonical}", "relation": "identical_import"})
    restored_path = ROOT / "data/enriched/osm_descriptions/descriptions.jsonl"
    restored = {r["place_id"]: r for r in read_jsonl(restored_path)} if restored_path.exists() else {}
    for r in records.values():
        s = status.get((r["source_dataset"], r["source_id"]), {})
        r.update(in_mvp=r["place_id"] in mvp, mvp_status=s.get("status"), mvp_reason=s.get("reason") or None)
        if r["in_mvp"]:
            r["quality_flags"].extend(w["code"] for w in mvp[r["place_id"]].get("data_quality_warnings", []))
        if r["source_dataset"] == "osm":
            recovered = restored.get(r["place_id"])
            if recovered:
                for field in ("description", "description_origin", "description_status", "description_evidence", "description_candidates"):
                    r[field] = recovered[field]
                if r["description_evidence"] and r["description_evidence"][0]["scope"] == "brand":
                    r["quality_flags"].append("DESCRIPTION_DESCRIBES_BRAND_NOT_BRANCH_CONDITIONS")
            else:
                r["description_origin"] = "osm_description" if r["description"] else "unknown"
                r["description_status"] = "osm_description" if r["description"] else "not_processed"
        if r["possible_duplicate_ids"]:
            r["quality_flags"].append("POSSIBLE_DUPLICATE")
        if not r["address"]:
            r["quality_flags"].append("ADDRESS_MISSING")
        if r["category"] == "event":
            r["quality_flags"].append("VENUE_NOT_SCHEDULED_EVENT")
    # Exact name + compatible type + <=300m only creates a review link, not a merge.
    seeds = [{**row, "source_dataset": ds} for ds, rows in seed.items() for row in rows]
    for match in source_match_candidates(osm, seeds):
        if match["matched_place_id"]:
            sid, ds = match["source_id"], match["source_dataset"]
            canonical = merges.get(sid, sid) if ds == "main" else sid
            left, right = records[f"place:{ds}:{canonical}"], records[match["matched_place_id"]]
            for a, b in ((left, right), (right, left)):
                a["possible_duplicate_ids"] = sorted(set(a["possible_duplicate_ids"] + [b["place_id"]]))
                a["quality_flags"] = sorted(set(a["quality_flags"] + ["POSSIBLE_DUPLICATE"]))
    result = sorted(records.values(), key=lambda r: (r["category"], r["name"].casefold(), r["place_id"]))
    assert len(records) == sum(len(rows) for rows in seed.values()) + len(osm) - len(merges)
    assert sum(r["in_mvp"] for r in result) == len(mvp)
    assert all(-180 <= r["longitude"] <= 180 and -90 <= r["latitude"] <= 90 for r in result)
    output.mkdir(parents=True, exist_ok=True)
    (output / "places.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in result))
    # CSV is a complete flat export; nested arrays/objects are JSON strings.
    with (output / "places.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(result[0]))
        writer.writeheader()
        for r in result:
            writer.writerow({k: csv_value(v) for k, v in r.items()})
    with (output / "source_mapping.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(mapping[0]))
        writer.writeheader(); writer.writerows(mapping)
    for source, destination in (("queue.csv", "description_queue.csv"), ("report.json", "description_report.json")):
        path = ROOT / "data/enriched/osm_descriptions" / source
        if path.exists():
            shutil.copyfile(path, output / destination)
    report = {"schema_version": "all-places-report-v1", "records": len(result),
              "mvp_records": sum(r["in_mvp"] for r in result), "source_records": sum(len(v) for v in seed.values()) + len(osm),
              "known_merged_aliases": len(merges), "supplemental_imports": imports,
              "categories": dict(sorted(Counter(r["category"] for r in result).items())),
              "source_counts": dict(Counter(r["source_dataset"] for r in result)),
              "osm_description_status": dict(Counter(r["description_status"] for r in result if r["source_dataset"] == "osm")),
              "coverage": {k: sum(r[k] is not None and r[k] != "" for r in result)
                           for k in ("address", "description", "website_candidate", "opening_hours_raw", "duration_minutes", "hard_age_min")},
              "input_sha256": {"main": audits["main"]["sha256"], "addition": audits["addition"]["sha256"],
                               "osm": digest(osm_path), "mvp": digest(mvp_path), "seed_decisions": digest(decisions_path),
                               "restored_descriptions": digest(restored_path) if restored_path.exists() else None},
              "output_sha256": {name: digest(output / name) for name in ("places.jsonl", "places.csv", "source_mapping.csv", "description_queue.csv", "description_report.json") if (output / name).exists()},
              "limitations": ["Potential CSV/OSM overlaps remain separate pending review.",
                              "Site descriptions are attributed source excerpts, not confirmation of current visiting conditions.",
                              "Brand text is distinguished from individual branch conditions.",
                              "Unnamed OSM objects cannot be searched by name."]}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("records", "mvp_records", "categories", "osm_description_status")}, ensure_ascii=False))
    return result, report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUT)
    build(parser.parse_args().output)
