"""Add distinct public tourism directory records, holding likely overlaps."""
import csv
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"models"));sys.path.insert(0,str(ROOT/"scripts"))
from export_all_places import blank
from source_matching import normalize_name,separation_m
from discover_tourism_descriptions import name_score
from prepare_demo_catalog import infer_topics,infer_formats

OUT=ROOT/"data/enriched/tourism_places"


def category(name,description):
    text=(name+" "+(description or "")).casefold()
    if "рукавишниковых" in name.casefold(): return "museum"
    if re.search(r"музей|галере|выставочн",name,re.I): return "museum"
    if re.search(r"театр|кинотеатр|филармон|консерватор|планетари|концерт",name,re.I): return "event"
    if re.search(r"дельфинар|аквапарк|батут|квест",text): return "other"
    if re.search(r"парк|зоопарк|сад\b",name,re.I): return "park"
    if re.search(r"ресторан|бар\b|кафе|кофейн|кухн|пиццери|пекарн|бистро|кондитер|энотек",text): return "restaurant"
    if re.search(r"библиотек|квест|аквапарк|клуб|дворец спорта|скалодром|батут|боулинг",text): return "other"
    return "landmark"


def build():
    base=[json.loads(l) for l in (ROOT/"outputs/all_places_v1/places.jsonl").read_text().splitlines()]
    cards=json.loads((ROOT/"data/processed/site_collection/tourism_directory/cards.json").read_text())["cards"]
    added,review=[],[]
    for card in sorted(cards,key=lambda c:c["source_url"]):
        pid="place:tourism:"+hashlib.sha256(card["source_url"].encode()).hexdigest()[:16]
        decision={"source_url":card["source_url"],"name":card["name"],"place_id":pid,"status":"held","reason":"","possible_existing_ids":[]}
        if not card.get("coordinates_lat_lon") or len(card["coordinates_lat_lon"])!=2:
            decision["reason"]="coordinates_missing";review.append(decision);continue
        lat,lon=card["coordinates_lat_lon"]
        if not (43.5<=lon<=44.4 and 56.05<=lat<=56.6):
            decision["reason"]="outside_pilot_bounds";review.append(decision);continue
        cat=category(card["name"],card.get("description"))
        overlaps=[]
        for other in base+added:
            if other["source_dataset"]=="addition": continue
            distance=separation_m((lon,lat),(other["longitude"],other["latitude"]))
            exact=normalize_name(card["name"])==normalize_name(other["name"])
            fuzzy=name_score(card["name"],other["name"])
            if (exact and distance<=300) or (distance<=150 and fuzzy>=0.55) or (cat==other["category"] and distance<=35):
                overlaps.append(other["place_id"])
        if overlaps:
            decision.update(reason="existing_or_overlapping_record_requires_review",possible_existing_ids=overlaps)
            review.append(decision);continue
        row=blank(pid,card["name"],cat,lon,lat)
        row.update(source_dataset="tourism",source_id=pid.rsplit(":",1)[1],source_url=card["source_url"],
                   description=card.get("description"),description_origin="parsed_tourism_card",
                   description_status="source_description",retrieved_at=card["fetched_at"],
                   category_origin="heuristic_name_and_description",in_mvp=False,mvp_status="new_source_candidate",
                   mvp_reason="New directory record; admission, entrance and family properties need review.")
        row["topics"]=list(infer_topics(row["name"]+" "+(row["description"] or ""),cat))
        row["formats"]=list(infer_formats(row["name"]+" "+(row["description"] or ""),cat))
        row["quality_flags"]=["TOURISM_SOURCE_UNVERIFIED","CATEGORY_HEURISTIC","ENTRANCE_NOT_VERIFIED"]
        # Relocations and differently named branches need a separate review even
        # when their points are too far apart to be an automatic overlap.
        related=[p["place_id"] for p in base if p["source_dataset"]!="addition" and p["category"]==cat and name_score(card["name"],p["name"])>=0.65]
        if related:
            row["possible_duplicate_ids"]=related
            row["quality_flags"].append("POSSIBLE_DUPLICATE_OR_BRANCH")
        row["description_evidence"]=[{"source_url":card["listing_url"],"detail_url":card["source_url"],"quote":card.get("description"),"source_part":"html_card","content_sha256":card["content_sha256"],"fetched_at":card["fetched_at"],"scope":"place","content_verified_at":None}]
        row["sources"]=[{"dataset":"nn_grad_tourism","source_url":card["listing_url"],"card":card}]
        added.append(row)
        decision.update(status="added_candidate",reason="No likely overlap under conservative name/coordinate rules")
        review.append(decision)
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/"places.jsonl").write_text("".join(json.dumps(row,ensure_ascii=False)+"\n" for row in added))
    with (OUT/"review.csv").open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(review[0]));writer.writeheader();writer.writerows({**r,"possible_existing_ids":" | ".join(r["possible_existing_ids"])} for r in review)
    report={"source_cards":len(cards),"added_candidates":len(added),"held":len(review)-len(added),"categories":dict(Counter(p["category"] for p in added)),"decisions":review}
    (OUT/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({k:v for k,v in report.items() if k!="decisions"},ensure_ascii=False))


if __name__=="__main__":build()
