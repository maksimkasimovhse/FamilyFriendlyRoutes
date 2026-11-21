"""Build linked task-complete tables, preserving unknowns and claim provenance."""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urljoin
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))
from site_features import validate_claims, PROPERTIES
from site_feature_rules import deterministic_claims, make_claim, simple_hours
from export_all_places import csv_value
from source_matching import normalize_name,separation_m

OUTPUT = ROOT / "outputs/all_places_v2"
VERSION = "enriched-places-v2"


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def identifier(prefix, value):
    return prefix + hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def write_table(name, rows):
    (OUTPUT / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows))
    if rows:
        with (OUTPUT / f"{name}.csv").open("w", encoding="utf-8-sig", newline="") as f:
            fields = list(dict.fromkeys(k for row in rows for k in row))
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows({k: csv_value(row.get(k)) for k in fields} for row in rows)


def json_objects(node):
    if isinstance(node, list):
        for item in node:
            yield from json_objects(item)
    elif isinstance(node, dict):
        yield node
        for item in node.values():
            if isinstance(item, (list, dict)):
                yield from json_objects(item)


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    places = read_jsonl(ROOT / "outputs/all_places_v1/places.jsonl")
    new_places_path = ROOT / "data/enriched/tourism_places/places.jsonl"
    if new_places_path.exists():
        places.extend(read_jsonl(new_places_path))
    address_places_path=ROOT/"data/enriched/address_venues/places.jsonl"
    if address_places_path.exists():places.extend(read_jsonl(address_places_path))
    by_id = {p["place_id"]: p for p in places}
    original = {p["place"]["place_id"]: p for p in read_jsonl(ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl")}
    observations, schedules, events, rejected = {}, {}, {}, []
    def observe(claim, pids, source, method, match_status="source_link_candidate"):
        value = next((claim[key] for key in ("value_text", "value_number", "value_boolean") if claim.get(key) is not None), None)
        row = {"place_ids": pids, "property": claim["property"], "subject": claim["subject"], "scope": claim["scope"],
               "value": value, "unit": claim.get("unit"), "condition_text": claim.get("condition_text"),
               "method": method, "entity_match_status": match_status, "status": "source_claim",
               "value_origin": "model_inference" if claim["property"] in {"topic", "format"} and method=="llm_with_exact_quote" else "source_extraction",
               "source_url": source["source_url"], "quote": claim["quote"], "source_part": claim["source_part"],
               "content_sha256": source.get("content_sha256"), "fetched_at": source.get("fetched_at"),
               "content_verified_at": None}
        row["observation_id"] = identifier("observation:", row)
        observations[row["observation_id"]] = row
        if claim["property"] in {"opening_hours_text", "kitchen_hours_text", "play_room_hours_text", "play_room_staff_hours_text"}:
            intervals = simple_hours(str(value), osm=method == "osm_tag")
            schedule = {"place_ids": pids, "scope": claim["scope"], "subject": claim["subject"],
                        "property": claim["property"], "raw_text": value, "timezone": "Europe/Moscow",
                        "intervals": intervals, "parse_status": "parsed_subset" if intervals else "raw_only",
                        "observation_id": row["observation_id"], "source_url": row["source_url"],
                        "condition_text": row["condition_text"], "content_verified_at": None}
            schedule["schedule_id"] = identifier("schedule:", schedule)
            schedules[schedule["schedule_id"]] = schedule
    # OSM properties stay source claims, retaining raw access distinctions.
    for pid, r in original.items():
        tags, p = r["provenance"]["raw_tags"], r["place"]
        source = {"source_url": r["evidence"][0]["source_url"], "fetched_at": r["provenance"].get("retrieved_at")}
        for key, prop in (("opening_hours", "opening_hours_text"), ("access", "access"), ("wheelchair", "wheelchair"),
                          ("surface", "surface"), ("playground", "equipment"), ("cuisine", "cuisine"),
                          ("charge", "ticket_price_text"), ("entrance", "entrance_text")):
            if tags.get(key):
                observe(make_claim(prop, tags[key], f"{key}={tags[key]}", subject=p["name"], source_part="osm_tag"), [pid], source, "osm_tag", "original_osm_entity")
        for field in ("indoor", "toilet", "shelter", "seating"):
            fact = p["facts"].get(field)
            if fact and fact["state"] == "known":
                prop, value = ("environment", "indoor" if fact["value"] else "outdoor") if field == "indoor" else (field, fact["value"])
                observe(make_claim(prop, value, json.dumps({"category":p["categories"], "tags":tags}, ensure_ascii=False), subject=p["name"], source_part="osm_tag"), [pid], source, "osm_tag", "original_osm_entity")
        for tag, prop in (("fee", "fee"), ("covered", "shelter"), ("shade", "shade"), ("fenced", "fence"), ("changing_table", "changing_table")):
            if tags.get(tag) in {"yes", "no"}:
                observe(make_claim(prop, tags[tag] == "yes", f"{tag}={tags[tag]}", subject=p["name"], source_part="osm_tag"), [pid], source, "osm_tag", "original_osm_entity")
        for tag, prop in (("min_age", "play_room_age_min"), ("max_age", "play_room_age_max")):
            if p["categories"][0] == "playground" and str(tags.get(tag, "")).isdigit():
                observe(make_claim(prop, int(tags[tag]), f"{tag}={tags[tag]}", subject=p["name"], scope="infrastructure", source_part="osm_tag", unit="years"), [pid], source, "osm_tag", "original_osm_entity")
    site_report = json.loads((ROOT / "data/processed/site_collection/osm_descriptions/report.json").read_text())
    extra_family_report = ROOT / "data/processed/site_collection/extra_family/report.json"
    if extra_family_report.exists():
        site_report["jobs"] += json.loads(extra_family_report.read_text())["jobs"]
    reviewed_full = {s["url"]:s for s in json.loads((ROOT / "data/site_collection/reviewed_full_features.json").read_text())["sources"]}
    feature_report_path = ROOT / "data/processed/site_collection/full_features/report.json"
    feature_report = json.loads(feature_report_path.read_text()) if feature_report_path.exists() else {"jobs": []}
    extracted_by_hash = {r["source_content_sha256"]: r for r in feature_report["jobs"] if r.get("extraction")}
    for job in site_report["jobs"]:
        if not job.get("snapshot"):
            continue
        snapshot = json.loads(Path(job["snapshot"]).read_text())
        page = snapshot["page"]
        raw_path=Path(job["snapshot"]).with_suffix(".html")
        if raw_path.exists():
            soup=BeautifulSoup(raw_path.read_bytes(),"html.parser")
            page["links"]=[{"text":a.get_text(" ",strip=True),"url":urljoin(page["final_url"],a["href"])} for a in soup.find_all("a",href=True) if a["href"].startswith(("http","/","#"))]
        source = {"source_url": page["final_url"], "fetched_at": snapshot["fetched_at"], "content_sha256": page["content_sha256"]}
        review = reviewed_full.get(job["url"])
        if review:
            for activity in review["activities"]:
                start = page["text"].find(activity["quote_start"])
                end = page["text"].find(activity["quote_end"], start)
                if start < 0 or end < 0:
                    raise ValueError("Reviewed activity block missing from snapshot")
                quote = page["text"][start:end+len(activity["quote_end"])]
                for prop,value,unit in (("duration_minutes",activity["duration_minutes"],"minutes"),("ticket_price",activity["price"],activity["price_unit"])):
                    claim = make_claim(prop,value,quote,subject=activity["subject"],scope="activity",unit=unit)
                    accepted,failures,_ = validate_claims({"claims":[claim],"warnings":[]},page)
                    if failures:
                        raise ValueError(f"Reviewed activity claim rejected: {failures[0]['reason']}")
                    observe(accepted[0], review["place_ids"], source, "editorial_source_block", "reviewed_name_and_address")
        cats = {by_id[pid]["category"] for pid in job["place_ids"]}
        deterministic = deterministic_claims(page, job["place_names"], cats)
        accepted, failures = [], []
        for index in range(0, len(deterministic), 100):
            good, bad, _ = validate_claims({"claims":deterministic[index:index+100], "warnings":[]}, page)
            accepted.extend(good); failures.extend(bad)
        rejected.extend({"url": page["final_url"], **r} for r in failures)
        for claim in accepted:
            observe(claim, job["place_ids"], source, "deterministic_page_rule")
        fjob = extracted_by_hash.get(page["content_sha256"])
        if fjob:
            result = json.loads(Path(fjob["extraction"]).read_text())
            raw = result["claims"] + [r["claim"] for r in result["rejected_claims"]]
            accepted, failures, _ = validate_claims({"claims":raw, "warnings":result.get("warnings", [])}, page)
            rejected.extend({"url":page["final_url"], **r} for r in failures)
            for claim in accepted:
                observe(claim, job["place_ids"], source, "llm_with_exact_quote")
        for event in json_objects(page.get("json_ld", [])):
            types = event.get("@type", [])
            types = [types] if isinstance(types, str) else types
            if not any(isinstance(t,str) and (t == "Event" or t.endswith("Event")) for t in types) or not event.get("name"):
                continue
            start, end = None, None
            for key in ("startDate", "endDate"):
                try:
                    text = event.get(key)
                    if not isinstance(text, str) or "T" not in text:
                        continue
                    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
                    dt = dt.replace(tzinfo=ZoneInfo("Europe/Moscow")) if dt.tzinfo is None else dt
                    if key == "startDate": start = dt
                    else: end = dt
                except ValueError:
                    pass
            duration = int((end-start).total_seconds()/60) if start and end and 0 < (end-start).total_seconds() <= 86400 else None
            item = {"place_ids":job["place_ids"], "title":event["name"], "start_at":start.isoformat() if start else None,
                    "end_at":end.isoformat() if end else None, "duration_minutes":duration,
                    "start_text":event.get("startDate"), "end_text":event.get("endDate"),
                    "timezone":"Europe/Moscow", "planner_ready":bool(start and end and duration and len(job["place_ids"])==1),
                    "temporal_status":"past" if (end or start) and (end or start) < datetime.now(timezone.utc) else "future_or_unknown",
                    "booking_status":"unknown", "source_url":page["final_url"], "source_part":"json_ld",
                    "raw_source":event, "fetched_at":snapshot["fetched_at"], "content_verified_at":None}
            item["occurrence_id"] = identifier("occurrence:source:", {k:item[k] for k in ("place_ids","title","start_text","end_text")})
            events[item["occurrence_id"]] = item
    # The saved tourism detail page contains structured map cards for the whole
    # directory, including addresses omitted from the short listing cards.
    detail_dir=ROOT/"data/processed/site_collection/tourism_directory"
    detail_files=sorted(detail_dir.glob("detail_*.json"))
    map_address_fills=0
    if detail_files:
        meta=json.loads(detail_files[0].read_text())
        raw=detail_files[0].with_suffix(".html")
        soup=BeautifulSoup(raw.read_bytes(),"html.parser")
        map_cards=[]
        for node in soup.select(".map__items-element"):
            name=node.select_one(".map__items-element-name")
            address=node.select_one(".map__items-element-address span")
            coords=node.select_one("[data-coords]")
            if name and address and coords:
                lat,lon=json.loads(coords["data-coords"])
                map_cards.append((normalize_name(name.get_text(" ",strip=True)),address.get_text(" ",strip=True),lon,lat))
        for place in places:
            matches=[a for n,a,lon,lat in map_cards if n==normalize_name(place["name"]) and separation_m((lon,lat),(place["longitude"],place["latitude"]))<=30]
            if len(set(matches))==1:
                address=matches[0]
                source={"source_url":meta["page"]["final_url"],"content_sha256":meta["page"]["content_sha256"],"fetched_at":meta["fetched_at"]}
                observe(make_claim("address",address,address,subject=place["name"],scope="place",source_part="html_map_card"),[place["place_id"]],source,"deterministic_map_card","exact_name_and_coordinate")
                if not place["address"]:
                    place["address"]=address;place["address_origin"]="tourism_map_card";map_address_fills+=1
                    place["quality_flags"]=[flag for flag in place["quality_flags"] if flag!="ADDRESS_MISSING"]
    values = list(observations.values())
    per_place = defaultdict(list)
    for o in values:
        for pid in o["place_ids"]:
            per_place[pid].append(o)
    def properties(pids, fields, scopes=None):
        relevant = [o for o in values if any(pid in o["place_ids"] for pid in pids) and (not scopes or o["scope"] in scopes)]
        result = {}
        multiple={"topic","format","interactivity","cuisine","dish","equipment","menu_url","opening_hours_text","kitchen_hours_text","play_room_hours_text","play_room_staff_hours_text","access_exception_text","session_schedule_text","closed_days_text","program_period_text"}
        for field in fields:
            found = [o for o in relevant if o["property"] == field]
            unique = {json.dumps(o["value"], ensure_ascii=False, sort_keys=True):o["value"] for o in found}
            state = "unknown" if not found else "conflict" if len(unique)>1 and field not in multiple else "brand_claim" if all(o["scope"]=="brand" for o in found) else "conditional" if any(o["condition_text"] for o in found) else "source_claim"
            value=list(unique.values()) if found and field in multiple else next(iter(unique.values())) if len(unique)==1 else None
            result[field] = {"state":state,"value":value,"observation_ids":[o["observation_id"] for o in found]}
        return result
    restaurant_fields = ("children_menu", "cuisine", "dish", "small_portions", "meal_price", "menu_url", "play_room", "play_room_age_min", "play_room_age_max", "play_room_conditions", "play_room_hours_text", "play_room_staff", "play_room_staff_hours_text", "toilet", "high_chairs", "colouring_books", "board_games", "kitchen_hours_text")
    infrastructure_fields = ("access", "opening_hours_text", "fee", "environment", "shelter", "seating", "equipment", "surface", "shade", "fence", "wheelchair", "play_room_age_min", "play_room_age_max", "entrance_text")
    activity_fields = ("topic", "format", "interactivity", "hard_age_min", "hard_age_max", "recommended_age_min", "recommended_age_max", "content_label_min", "min_height_cm", "adult_required", "duration_minutes", "visit_mode", "booking_required", "ticket_price", "last_entry_text")
    common_fields = ("address", "environment", "opening_hours_text", "closed_days_text", "last_entry_text", "ticket_price", "free_admission", "toilet", "seating", "shelter", "access", "wheelchair", "entrance_text", "access_exception_text")
    restaurants = [{"place_id":p["place_id"],"name":p["name"],"properties":properties([p["place_id"]], restaurant_fields),
                    "family_properties_verified":False} for p in places if p["category"]=="restaurant"]
    infrastructure = [{"place_id":p["place_id"],"name":p["name"],"type":p["category"],"longitude":p["longitude"],"latitude":p["latitude"],
                       "entrance_verified":False,"properties":properties([p["place_id"]], infrastructure_fields)} for p in places if p["category"] in {"toilet","playground","bench","shelter"}]
    policy = json.loads((ROOT / "models/recommendation_policy.json").read_text())
    enrichment_policy = json.loads((ROOT / "data/catalog/enrichment_policy.json").read_text())
    activities = []
    for p in places:
        if p["category"] not in {"toilet","bench","shelter"} and p["source_dataset"]!="addition":
            meal = p["category"]=="restaurant"
            activities.append({"activity_id":f"activity:{p['source_dataset']}:{p['source_id'].replace('/', ':')}:visit",
                               "place_id":p["place_id"],"title":p["name"],"kind":"meal" if meal else "visit","description":p["description"],
                               "topics":p["topics"],"formats":p["formats"],"feature_origin":"heuristic",
                               "duration_estimate_minutes":enrichment_policy["meal_duration_estimate_minutes"] if meal else policy["duration_estimates_sec"].get(p["category"],0)//60,
                               "duration_estimate_origin":enrichment_policy["policy_version"] if meal else policy["policy_version"],
                               "properties":properties([p["place_id"]],activity_fields,{"place"}),
                               "entity_status":"existing_mvp_activity" if p["in_mvp"] else "candidate_not_in_mvp",
                               "participation_allowed":"unknown","availability_verified":False})
    source_activities = defaultdict(list)
    for o in values:
        if o["scope"] in {"activity","play_room","event"}:
            for pid in o["place_ids"]:
                source_activities[(pid,o["scope"],o["subject"])].append(o)
    for (pid,scope,subject), facts in source_activities.items():
        activity = {"activity_id":identifier("activity:source:",[pid,scope,subject]),"place_id":pid,"title":subject,
                    "kind":"session_candidate" if scope=="event" else "play_room" if scope=="play_room" else "source_activity",
                    "properties":{},"duration_estimate_minutes":None,"entity_status":"source_candidate_pending_review"}
        for prop in set(o["property"] for o in facts):
            chosen = [o for o in facts if o["property"]==prop]
            unique = {json.dumps(o["value"],ensure_ascii=False):o["value"] for o in chosen}
            activity["properties"][prop] = {"state":"source_claim" if len(unique)==1 else "conflict", "value":next(iter(unique.values())) if len(unique)==1 else None,"observation_ids":[o["observation_id"] for o in chosen]}
        activities.append(activity)
        # Keep explicit starts with an unknown end; do not invent the duration.
        if scope == "event":
            months = {name:i+1 for i,name in enumerate(("января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"))}
            pattern = r"(\d{1,2})\s+("+"|".join(months)+r")\s+(20\d{2})(?:\s+года)?\s*(?:в\s*)?(\d{1,2}):(\d{2})"
            for fact in facts:
                match = re.search(pattern, fact["quote"], re.I)
                if not match:
                    continue
                day,month,year,hour,minute = match.groups()
                try:
                    start = datetime(int(year),months[month.casefold()],int(day),int(hour),int(minute),tzinfo=ZoneInfo("Europe/Moscow"))
                except ValueError:
                    continue
                key = identifier("occurrence:source:",[pid,subject,start.isoformat()])
                events[key] = {"occurrence_id":key,"place_ids":[pid],"activity_id":activity["activity_id"],"title":subject,
                               "start_at":start.isoformat(),"end_at":None,"duration_minutes":None,"timezone":"Europe/Moscow",
                               "planner_ready":False,"missing_required_fields":["end_at_or_duration"],"booking_status":"unknown",
                               "temporal_status":"past" if start < datetime.now(timezone.utc) else "future_or_unknown",
                               "source_url":fact["source_url"],"quote":fact["quote"],"observation_id":fact["observation_id"],
                               "content_sha256":fact["content_sha256"],"fetched_at":fact["fetched_at"],"content_verified_at":None}
    published = ROOT / "data/enriched/published_events"
    programmes = read_jsonl(published / "programmes.jsonl") if (published / "programmes.jsonl").exists() else []
    for programme in programmes:
        if programme["place_id"]:
            activities.append({**programme,"entity_status":"published_programme_candidate","properties":{},
                               "duration_estimate_minutes":None,"duration_estimate_origin":None})
    if (published / "occurrences.jsonl").exists():
        for occurrence in read_jsonl(published / "occurrences.jsonl"):
            events[occurrence["occurrence_id"]]=occurrence
    write_table("event_programmes",programmes)
    if (published / "unmatched_venues.jsonl").exists():
        write_table("unmatched_event_venues",read_jsonl(published / "unmatched_venues.jsonl"))
    photos = []
    with (ROOT / "db/seed/card_images.csv").open(encoding="utf-8-sig",newline="") as f:
        for image in csv.DictReader(f):
            sid = "67" if image["item_id"]=="225" else image["item_id"]
            pid = f"place:main:{sid}"
            if pid in by_id:
                photos.append({"place_id":pid,"source_item_id":image["item_id"],"url":image["source_url"],
                               "sha256":image["sha256"],"alt":image["alt"],"width":int(image["width"]),"height":int(image["height"]),
                               "identity_verified":False,"rights_verified":False,"origin":"legacy_seed_image_mapping"})
    photo_by_place = defaultdict(list)
    for photo in photos:
        photo_by_place[photo["place_id"]].append(photo)
    for p in places:
        p["dataset_version"] = VERSION
        p["properties"] = properties([p["place_id"]], common_fields, {"place","restaurant","infrastructure"})
        p["feature_observation_ids"] = [o["observation_id"] for o in per_place[p["place_id"]]]
        p["photo_candidates"] = photo_by_place[p["place_id"]]
    # Previously reviewed family restaurant observations remain useful before
    # their coordinates/identity can be resolved into the canonical place table.
    unmatched = []
    first_batch = ROOT / "data/processed/site_collection/first_batch/facts.jsonl"
    if first_batch.exists():
        for fact in read_jsonl(first_batch):
            unmatched.append({"source_entity_key":fact["entity_key"],"canonical_place_id":None,
                              "field":fact["field"],"value":fact["value"],"scope":fact["scope"],
                              "evidence":fact["evidence"],"entity_status":"needs_coordinates_and_matching",
                              "content_verified_at":None})
    write_table("unmatched_source_facts", unmatched)
    coverage = []
    for category in sorted({p["category"] for p in places}):
        selected = [p for p in places if p["category"]==category]
        for field in PROPERTIES:
            matching = [p for p in selected if any(o["property"]==field for o in per_place[p["place_id"]])]
            coverage.append({"category":category,"field":field,"records":len(selected),"with_source_claim":len(matching),
                             "unknown":len(selected)-len(matching),"coverage_percent":round(100*len(matching)/len(selected),2),
                             "verified_count":0})
    for name, rows in (("places",places),("activities",activities),("restaurants",restaurants),("infrastructure",infrastructure),
                       ("schedules",list(schedules.values())),("occurrences",list(events.values())),("observations",values),("photos",photos),("field_coverage",coverage),("rejected_claims",rejected)):
        write_table(name, rows)
    table_coverage=[]
    for name,rows,fields in (("places",places,("address","description","website_candidate","longitude","latitude")),
                            ("activities",activities,("published_duration_minutes","duration_estimate_minutes","topics","formats")),
                            ("restaurants",restaurants,restaurant_fields),("infrastructure",infrastructure,infrastructure_fields),
                            ("event_programmes",programmes,("place_id","description","content_label_min","recommended_age_min","published_duration_minutes","topics","formats")),
                            ("occurrences",list(events.values()),("start_at","end_at","duration_minutes","planner_ready"))):
        for field in fields:
            known=conflicts=estimates=0
            for row in rows:
                if field in row:
                    value=row[field]
                    present=value is not None and value!="" and value!=[]
                else:
                    prop=row.get("properties",{}).get(field,{})
                    value=prop.get("value");present=prop.get("state","unknown")!="unknown"
                    conflicts+=prop.get("state")=="conflict"
                known+=bool(present)
                estimates+=bool(present and field=="duration_estimate_minutes")
            table_coverage.append({"table":name,"field":field,"records":len(rows),"populated":known,"unknown":len(rows)-known,
                                   "populated_percent":round(known/len(rows)*100,2) if rows else 0,"editorial_estimates":estimates,"conflicts":conflicts})
    write_table("table_coverage",table_coverage)
    with (ROOT/"outputs/all_places_v1/source_mapping.csv").open(encoding="utf-8-sig",newline="") as f:
        source_mapping=list(csv.DictReader(f))
    for place in places:
        if place["source_dataset"] not in {"main","addition","osm"}:
            source_mapping.append({"source_dataset":place["source_dataset"],"source_id":place["source_id"],"place_id":place["place_id"],"relation":"new_source_candidate"})
    with (OUTPUT/"source_mapping.csv").open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(source_mapping[0]));writer.writeheader();writer.writerows(source_mapping)
    write_table("event_source_mapping",[{"source_url":p["source_url"],"activity_id":p["activity_id"],"place_id":p["place_id"]} for p in programmes])
    counts = {"places":len(places),"activities":len(activities),"restaurants":len(restaurants),"infrastructure":len(infrastructure),
              "schedules":len(schedules),"occurrences":len(events),"observations":len(values),"rejected_claims":len(rejected),
              "unmatched_source_facts":len(unmatched),"photo_candidates":len(photos),"published_event_programmes":len(programmes),
              "new_tourism_place_candidates":len(read_jsonl(new_places_path)) if new_places_path.exists() else 0,
              "new_address_place_candidates":len(read_jsonl(address_places_path)) if address_places_path.exists() else 0}
    report = {"dataset_version":VERSION,"counts":counts,"observation_methods":dict(Counter(o["method"] for o in values)),
              "properties":dict(Counter(o["property"] for o in values)),"places_with_site_properties":len({pid for o in values if o["method"]!="osm_tag" for pid in o["place_ids"]}),
              "parsed_schedules":sum(bool(s["intervals"]) for s in schedules.values()),"mvp_places":sum(p["in_mvp"] for p in places),
              "activities_with_editorial_duration_estimates":sum(a.get("duration_estimate_minutes") is not None for a in activities),
              "planner_ready_event_candidates":sum(o.get("planner_ready",False) for o in events.values()),
              "semantic_status":"source_claims_pending_entity_and_content_review", "unknown_is_not_false":True,
              "full_feature_extraction_progress":feature_report.get("counts"),
              "description_count":sum(bool(p["description"]) for p in places),
              "addresses_restored_from_map_cards":map_address_fills,
              "published_events_report":json.loads((published/"report.json").read_text()) if (published/"report.json").exists() else None,
              "input_sha256":{str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in
                              (ROOT/"outputs/all_places_v1/places.jsonl",new_places_path,address_places_path,ROOT/"db/seed/card_images.csv",ROOT/"models/recommendation_policy.json",ROOT/"data/catalog/enrichment_policy.json") if path.exists()},
              "output_sha256":{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUTPUT.glob("*.jsonl")}}
    (OUTPUT / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(report,ensure_ascii=False))
    return report


if __name__ == "__main__":
    build()
