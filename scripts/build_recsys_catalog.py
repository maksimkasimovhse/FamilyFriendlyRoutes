"""Compile the frozen enriched export into the serving catalog. No network/LLM."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
from taxonomy import FORMATS, INTEREST_IDS

VERSION = "city-enriched-v3"
OUTPUT = ROOT / "data/catalog/enriched"
EXPORT = ROOT / "outputs/all_places_v2"
UNKNOWN = {"state": "unknown", "value": None, "evidence_ids": []}


def read(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def compile_catalog(source=EXPORT):
    old = {r["place"]["place_id"]: r for r in read(ROOT / "data/catalog/city/catalog.jsonl")}
    places = read(source / "places.jsonl")
    events = read(source / "event_programmes.jsonl")
    reviewed_venues = {e["place_id"] for e in events if e.get("venue_identity_reviewed")}
    observations = {o["observation_id"]: o for o in read(source / "observations.jsonl")}
    restaurants = {r["place_id"]: r for r in read(source / "restaurants.jsonl")}
    schedules = defaultdict(list)
    for schedule in read(source / "schedules.jsonl"):
        if schedule["property"] == "opening_hours_text" and schedule["scope"] in {"place", "restaurant"}:
            for pid in schedule["place_ids"]:
                schedules[pid].append(schedule)
    rows, held, by_place = [], [], {}

    def hold(identifier, why):
        held.append({"id": identifier, "reason": why})

    def entity_evidence(eid, url, fetched, quote=None, sha=None, kind=None):
        if not fetched:
            return None
        kind = kind or ("osm" if url and "openstreetmap.org" in url else "official")
        return dict(evidence_id=eid, source_url=url, source_kind=kind, checked_at=fetched,
                    valid_until=None, quote=quote, content_sha256=sha, verification_status="source_claim")

    for place in places:
        pid, category = place["place_id"], place["category"]
        lon, lat = place["longitude"], place["latitude"]
        flags = place.get("quality_flags", [])
        reason = None
        if not (43.5 <= lon <= 44.4 and 56.05 <= lat <= 56.6):
            reason = "OUTSIDE_ROUTING_AREA"
        elif place["source_dataset"] == "addition":
            reason = "DUPLICATE_SOURCE_ROW"
        elif place["source_dataset"] == "main" and not place["in_mvp"]:
            reason = "VENUE_WITHOUT_PUBLIC_VISIT_PROGRAMME"
        elif not place["in_mvp"] and pid not in reviewed_venues and any(f in flags for f in ("POSSIBLE_DUPLICATE", "POSSIBLE_DUPLICATE_OR_BRANCH")):
            reason = "IDENTITY_REVIEW_REQUIRED"
        elif "NAME_MISSING" in flags and category not in {"bench", "toilet", "shelter", "playground"}:
            reason = "NAME_MISSING"
        if reason:
            hold(pid, reason)
            continue
        base = old.get(pid)
        evidence = {e["evidence_id"]: deepcopy(e) for e in base.get("evidence", [])} if base else {}
        notes = {n["code"]: n["message"] for n in base.get("data_quality_warnings", [])} if base else {}
        notes["SOURCE_FACTS_UNVERIFIED"] = "Сведения источников не проверены на месте; часы и условия могут измениться."
        if "OSM_CONDITIONS_UNVERIFIED" in flags:
            notes["OSM_SOURCE_UNVERIFIED"] = "Сведения OpenStreetMap могут быть неполными или устаревшими."
        if place.get("possible_duplicate_ids"):
            notes["POSSIBLE_DUPLICATE"] = "Возможное совпадение с другой площадкой требует проверки."
        if place["source_dataset"] in {"tourism", "publisher"}:
            notes["VENUE_SOURCE_UNVERIFIED"] = "Название и точка площадки взяты из публичного каталога; вход не проверен."

        def claim(key, props=None):
            prop = (props if props is not None else place.get("properties", {})).get(key, {})
            if prop.get("state") != "source_claim" or prop.get("value") is None:
                return deepcopy(UNKNOWN)
            ids = []
            for oid in prop.get("observation_ids", []):
                o = observations[oid]
                if o.get("condition_text") or o.get("scope") == "brand":
                    continue
                # The brand-wide site did not identify this restaurant branch.
                if o["source_url"].rstrip("/") == "https://www.syrovarnya.com":
                    continue
                e = entity_evidence(oid, o["source_url"], o["fetched_at"], o["quote"], o.get("content_sha256"))
                if e:
                    evidence[oid] = e
                    ids.append(oid)
            return dict(state="known", value=prop["value"], evidence_ids=ids) if ids else deepcopy(UNKNOWN)

        facts = {k: claim(k) for k in ("toilet", "shelter", "seating")}
        if base:
            for key, fact in base["place"].get("facts", {}).items():
                if key in facts and facts[key]["state"] == "unknown":
                    facts[key] = deepcopy(fact)
        indoor = deepcopy(UNKNOWN)
        environment = claim("environment")
        if environment["state"] == "known" and environment["value"] in {"indoor", "outdoor"}:
            indoor = {**environment, "value": environment["value"] == "indoor"}
        restaurant = None
        if pid in restaurants:
            props = restaurants[pid]["properties"]
            restaurant = {target: claim(key, props) for target,key in {
                "children_menu": "children_menu", "small_portions": "small_portions", "play_area": "play_room",
                "play_area_min_age": "play_room_age_min", "play_area_max_age": "play_room_age_max",
                "play_area_supervision": "play_room_staff"}.items()}
            supervision = restaurant["play_area_supervision"]
            if supervision["state"] == "known":
                supervision["value"] = True
                notes["SUPERVISION_SCHEDULE_LIMITED"] = "Персонал игровой зоны работает по отдельному расписанию; проверьте часы в источнике."
            for key in ("cuisine", "menu_url", "play_room_staff_hours_text"):
                value = claim(key, props)
                if value["state"] == "known":
                    restaurant[{"cuisine":"cuisine", "menu_url":"menu_urls", "play_room_staff_hours_text":"play_area_staff_hours_raw"}[key]] = value["value"]
            if any(v.get("state") == "brand_claim" for v in props.values()):
                notes["BRANCH_PROPERTIES_UNKNOWN"] = "Сведения сети не подтверждают условия конкретного филиала."
        p = dict(place_id=pid, name=place["name"], address=place.get("address"),
                 location=dict(coordinates=[lon, lat], label=place["name"]), entrance=None,
                 categories=[category], display_class="unknown", indoor=indoor, **facts,
                 restaurant=restaurant, opening_hours_raw=place.get("opening_hours_raw"),
                 description=place.get("description"), website=place.get("website_candidate"), phone=place.get("phone_raw"))
        p["access_raw"],p["fee_raw"] = place.get("access_raw"),place.get("fee_raw")
        if place.get("access_raw") not in {None,"yes","public"}:
            notes["ACCESS_CONDITIONAL"] = "Источник указывает условия доступа; проверьте, доступны ли услуги посетителям без покупки билета или заказа."
        kind = {"restaurant":"meal", "bench":"rest", "shelter":"rest", "toilet":"utility"}.get(category,"visit")
        aid = base["activity"]["activity_id"] if base else f"activity:{pid.removeprefix('place:')}:{kind}"
        estimates = {"restaurant":2700, "bench":900, "shelter":900, "toilet":600,
                     "museum":3600, "park":2700, "playground":1800, "landmark":1200, "event":3600, "other":1800}
        a = dict(activity_id=aid, place_id=pid, title=place["name"], kind=kind,
                 duration=dict(duration_sec=estimates[category], source="estimated", evidence_ids=[]), evidence_ids=[])
        for key in ("age_min_years", "age_max_years", "recommended_age_min_years", "recommended_age_max_years",
                    "height_min_cm", "admission_rule", "booking_required"):
            a[key] = deepcopy(base["activity"].get("facts", {}).get(key, UNKNOWN)) if base else deepcopy(UNKNOWN)
        ss = []
        for schedule in schedules[pid]:
            o = observations[schedule["observation_id"]]
            if o.get("condition_text") or o["scope"] == "brand":
                continue
            e = entity_evidence(o["observation_id"],o["source_url"],o["fetched_at"],o["quote"],o.get("content_sha256"))
            if e:
                evidence[e["evidence_id"]] = e
                ss.append(dict(intervals=schedule["intervals"], evidence_ids=[e["evidence_id"]],
                               usable=schedule["parse_status"] == "parsed_subset"))
        topics = [t for t in place.get("topics", []) if t in INTEREST_IDS]
        formats = [f for f in place.get("formats", []) if f in FORMATS]
        row = dict(place=dict(place_id=pid,title=place["name"],category=category,location=dict(longitude=lon,latitude=lat)),
                   activity=dict(activity_id=aid,title=place["name"],kind=kind,topics=topics,formats=formats,
                                 age_fit=deepcopy(base["activity"]["age_fit"]) if base else {"3-5":None,"6-8":None,"9-11":None}),
                   api=dict(place=p,activity=a), schedules=ss, occurrences=[], access_raw=place.get("access_raw"),
                   data_quality_warnings=[dict(code=k,message=v) for k,v in sorted(notes.items())], evidence=list(evidence.values()))
        by_place[pid] = row
        rows.append(row)

    # A toilet visit in a restaurant is not a 45-minute meal. Keep service IDs stable
    # so add/replace can resolve exactly the activity shown in a need response.
    for base_row in list(rows):
        p=base_row["api"]["place"]
        true=lambda key:p[key]["state"]=="known" and p[key]["value"] is True
        services=[]
        if base_row["activity"]["kind"]!="utility" and true("toilet"):
            services.append(("toilet","utility",600,"Туалет"))
        if base_row["activity"]["kind"]!="rest" and (true("indoor") or true("shelter") or true("seating")):
            services.append(("rest","rest",900,"Перерыв"))
        for suffix,kind,duration,label in services:
            row=deepcopy(base_row)
            aid=base_row["activity"]["activity_id"]+":"+suffix
            title=label+" — "+p["name"]
            row["activity"].update(activity_id=aid,title=title,kind=kind,topics=[],formats=[])
            row["api"]["activity"].update(activity_id=aid,title=title,kind=kind,
                duration=dict(duration_sec=duration,source="estimated",evidence_ids=[]))
            row["data_quality_warnings"].append(dict(code="SERVICE_ACCESS_UNVERIFIED",message="Доступ к услуге внутри заведения может требовать заказа или билета; условия нужно уточнить."))
            rows.append(row)

    occurrences = defaultdict(list)
    for o in read(source / "occurrences.jsonl"):
        if o.get("planner_ready") and not o.get("duration_conflict") and o.get("source_booking_status") != "sold_out":
            occurrences[o["activity_id"]].append(o)
    for event in events:
        aid, pid = event["activity_id"],event.get("place_id")
        usable = occurrences[aid]
        if pid not in by_place or not event.get("venue_identity_reviewed"):
            hold(aid,"EVENT_VENUE_IDENTITY_REVIEW_REQUIRED")
            continue
        if not usable or len({o["duration_minutes"] for o in usable}) != 1:
            hold(aid,"EVENT_TIMING_UNUSABLE")
            continue
        if usable[0]["duration_minutes"] > 240:
            hold(aid,"EVENT_DURATION_REVIEW_REQUIRED")
            continue
        row = deepcopy(by_place[pid])
        eid = "evidence:"+aid
        ev = entity_evidence(eid,event["source_url"],event["fetched_at"],event.get("duration_quote"),event.get("content_sha256"))
        row["evidence"].append(ev)
        row["activity"] = dict(activity_id=aid,title=event["title"],kind="session",topics=event["topics"],formats=event["formats"],
                               age_fit={"3-5":None,"6-8":None,"9-11":None})
        a = deepcopy(row["api"]["activity"])
        a.update(activity_id=aid,title=event["title"],kind="session", duration=dict(duration_sec=usable[0]["duration_minutes"]*60,
                 source="official",evidence_ids=[eid]),evidence_ids=[eid],description=event.get("description"),content_label_min=event.get("content_label_min"))
        for target,key in (("age_min_years","hard_age_min"),("age_max_years","hard_age_max"),
                           ("recommended_age_min_years","recommended_age_min"),("recommended_age_max_years","recommended_age_max")):
            a[target] = dict(state="known",value=event[key],evidence_ids=[eid]) if event.get(key) is not None else deepcopy(UNKNOWN)
        rules = event.get("participation_rules", [])
        if rules and all(rule.get("hard_age_min") is not None for rule in rules):
            # A necessary bound shared by every published group type; do not infer admission.
            a["age_min_years"] = dict(state="known",value=min(r["hard_age_min"] for r in rules),evidence_ids=[eid])
        if rules:
            a["participation_rules_raw"] = [r["quote"] for r in rules]
            row["data_quality_warnings"].append(dict(code="PARTICIPATION_RULES_CONDITIONAL",message="Условия участия зависят от типа группы; проверьте сопровождение и правила организатора."))
        if event.get("adult_required") is True:
            a["admission_rule"] = dict(state="known",value="adult_required",evidence_ids=[eid])
        a["booking_required"] = (dict(state="known",value=event["booking_required"],evidence_ids=[eid])
                                 if isinstance(event.get("booking_required"),bool) else deepcopy(UNKNOWN))
        row["api"]["activity"] = a
        row["occurrences"] = [dict(occurrence_id=o["occurrence_id"],start_at=o["start_at"],end_at=o["end_at"],evidence_ids=[eid]) for o in usable]
        row["data_quality_warnings"].append(dict(code="PUBLISHED_SCHEDULE_UNVERIFIED",message="Сеанс опубликован источником; актуальное расписание и наличие билетов не проверены."))
        rows.append(row)
    return rows, held


def main():
    rows, held = compile_catalog()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    content = "".join(json.dumps(r,ensure_ascii=False,sort_keys=True)+"\n" for r in rows)
    (OUTPUT / "catalog.jsonl").write_text(content)
    report = dict(catalog_version=VERSION, records=len(rows),places=len({r["place"]["place_id"] for r in rows}),
                  kinds=dict(Counter(r["activity"]["kind"] for r in rows)),
                  occurrences=sum(len(r["occurrences"]) for r in rows), held=held,
                  held_reasons=dict(Counter(r["reason"] for r in held)),
                  sha256=hashlib.sha256(content.encode()).hexdigest(),
                  input_sha256={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in
                                [*sorted(EXPORT.glob('*.jsonl')), ROOT/'data/catalog/city/catalog.jsonl',
                                 Path(__file__).resolve()]})
    (OUTPUT / "manifest.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({k:v for k,v in report.items() if k not in {"held","input_sha256"}},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
