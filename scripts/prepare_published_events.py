"""Normalize publisher JSON-LD into programmes and dated occurrences.

No checkout, live-seat promises, invented dates or default event durations.
"""
from __future__ import annotations
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime,timedelta,timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"models"));sys.path.insert(0,str(ROOT/"scripts"))
from source_matching import normalize_name
from prepare_demo_catalog import infer_topics, infer_formats

OUT=ROOT/"data/enriched/published_events"
MSK=ZoneInfo("Europe/Moscow")


def stable(prefix,value):
    return prefix+hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()[:24]


def objects(node):
    if isinstance(node,list):
        for item in node: yield from objects(item)
    elif isinstance(node,dict):
        yield node
        for item in node.values():
            if isinstance(item,(list,dict)):yield from objects(item)


def event_type(node):
    types=node.get("@type",[])
    types=[types] if isinstance(types,str) else types
    return any(isinstance(t,str) and (t=="Event" or t.endswith("Event")) for t in types)


def parse_time(value):
    if not isinstance(value,str) or "T" not in value:return None
    try:
        date=datetime.fromisoformat(value.replace("Z","+00:00"))
        return (date.replace(tzinfo=MSK) if date.tzinfo is None else date.astimezone(MSK))
    except ValueError:return None


def visible_duration(text):
    found=re.search(r"(?i)(?:длительность|продолжительность)[\s:—–-]{0,20}(?:(\d+)\s*час\w*(?:\s*(\d+)\s*мин\w*)?|(\d+)\s*мин\w*)",text)
    if not found:return None,None
    hours,minutes,only_minutes=found.groups()
    return (int(hours)*60+int(minutes or 0) if hours else int(only_minutes)),found.group()


def venue_details(event):
    location=event.get("location",{})
    if not isinstance(location,dict):return "",None
    address=location.get("address")
    if isinstance(address,dict):address=address.get("streetAddress")
    return location.get("name") or "",address


def match_venue(name,address,text,places):
    normalized=normalize_name(name)
    # Reviewed institutional alias and exact address in the source dataset.
    if "кремл" in normalized and "дмитриевск" in text.casefold():
        return "place:main:43","reviewed_meeting_point",True
    if "театр кукол" in normalized or ("театр" in normalized and "кукол" in normalized):
        return "place:main:64","reviewed_venue_alias",True
    if "филармони" in normalized and address and "кремль" in address.casefold() and re.search(r"\b2\b",address):
        return "place:main:78","reviewed_name_and_address",True
    exact=[p for p in places if normalize_name(p["name"])==normalized]
    if len(exact)==1:return exact[0]["place_id"],"exact_name_candidate",False
    aliases={"культурное пространство dkrt space":"dkrt","дельфинарий":"нижегородский дельфинарий","нижегородский планетарий им г м гречко":"нижегородский планетарий им г м гречко"}
    wanted=aliases.get(normalized)
    if wanted:
        selected=[p for p in places if normalize_name(p["name"])==wanted]
        if len(selected)==1:return selected[0]["place_id"],"name_alias_candidate",False
    return None,"unmatched_venue",False


def parse_programme(snapshot,places,now):
    page=snapshot["page"]
    # Prefer the root Event; nested subEvents are sessions, not new programmes.
    roots=[]
    for node in page.get("json_ld",[]):
        if isinstance(node,dict) and event_type(node):roots.append(node)
        elif isinstance(node,dict) and isinstance(node.get("@graph"),list):roots.extend(n for n in node["@graph"] if isinstance(n,dict) and event_type(n))
    programmes,occurrences,unmatched=[],[],[]
    for root in roots:
        title=root.get("name")
        if not title:continue
        venue_name,address=venue_details(root)
        if re.search(r"(?i)дзержинск|заволжье|йошкар|арзамас|болдино|дивеево",venue_name+" "+(address or "")):
            continue
        pid,method,reviewed=match_venue(venue_name,address,page["text"],places)
        aid=stable("activity:event:",[page["source_url"],venue_name,address])
        visible_minutes,duration_quote=visible_duration(page["text"])
        source_age=root.get("typicalAgeRange")
        label=re.search(r"(\d+)\s*\+",str(source_age or ""))
        self_guided=bool(re.search(r"(?i)самостоятельн.*осмотр|экспозици",title))
        program={"activity_id":aid,"place_id":pid,"title":title,"kind":"visit" if self_guided else "session",
                 "venue_name":venue_name,"venue_address":address,"venue_match_method":method,"venue_identity_reviewed":reviewed,
                 "description":(root.get("description") or "")[:600] or None,
                 "content_label_min":int(label[1]) if label else None,"recommended_age_min":None,"recommended_age_max":None,
                 "hard_age_min":None,"hard_age_max":None,"adult_required":None,
                 "published_duration_minutes":visible_minutes,"duration_quote":duration_quote,
                 "source_url":page["final_url"],"content_sha256":page["content_sha256"],"fetched_at":snapshot["fetched_at"],
                 "content_verified_at":None,"booking_live_verified":False,"entity_status":"published_event_candidate"}
        context=title+" "+(root.get("description") or "")+" "+venue_name
        topics=set(infer_topics(context,""))
        if re.search(r"(?i)кварк|тесла|фотон|полимер",context):topics.add("science")
        if re.search(r"(?i)шоколад|кулинар",context):topics.add("cooking")
        if re.search(r"(?i)дельфин",context):topics.add("animals")
        if re.search(r"(?i)театр|спектакл",context):topics.add("theatre")
        if re.search(r"(?i)музык|концерт|саундтрек",context):topics.add("music")
        formats=set(infer_formats(context,""))
        if re.search(r"(?i)мастер-класс",title):formats.add("creative")
        if re.search(r"(?i)экскурс",title):formats.add("educational")
        if re.search(r"(?i)шоу|концерт|спектакл",context):formats.add("spectacular")
        program.update(topics=sorted(topics),formats=sorted(formats),feature_origin="heuristic_name_description_and_venue")
        if pid=="place:main:43" and "подземелья" in title.casefold():
            mixed=re.search(r"(?i)сборных групп\s*[-–]\s*(\d+)\s*лет[^;]+",page["text"])
            organized=re.search(r"(?i)организованных групп\s*[-–]\s*(\d+)\s*лет",page["text"])
            rules=[]
            if mixed:rules.append({"hard_age_min":int(mixed[1]),"adult_required":True,"adult_age_rule_text":"старше 18 лет" if "старше 18 лет" in mixed.group() else None,"condition":"сборная группа","quote":mixed.group()})
            if organized:rules.append({"hard_age_min":int(organized[1]),"adult_required":None,"condition":"организованная группа","quote":organized.group()})
            if rules:
                program["participation_rules"]=rules
                program["participation_rules_origin"]="published_rules_in_source_text"
        programmes.append(program)
        if not pid:unmatched.append({"activity_id":aid,"name":venue_name,"address":address,"source_url":page["final_url"]})
        sessions=root.get("subEvent") or [root]
        sessions=[sessions] if isinstance(sessions,dict) else sessions
        for event in sessions:
            if not isinstance(event,dict):continue
            start,end=parse_time(event.get("startDate")),parse_time(event.get("endDate"))
            if not start or start<now or start>now+timedelta(days=90):continue
            end_origin="publisher_json_ld"
            if not end and visible_minutes:
                end=start+timedelta(minutes=visible_minutes)
                end_origin="derived_from_published_duration"
            duration=int((end-start).total_seconds()/60) if end and 0<(end-start).total_seconds()<=86400 and (end-start).total_seconds()%60==0 else None
            conflict=bool(duration and visible_minutes and duration!=visible_minutes)
            offers=event.get("offers") or root.get("offers") or {}
            offers=offers[0] if isinstance(offers,list) and offers else offers
            offers=offers if isinstance(offers,dict) else {}
            source_stock=str(offers.get("availability",""))
            status="sold_out" if "SoldOut" in source_stock else "published_available" if "InStock" in source_stock or "LimitedAvailability" in source_stock else "unknown"
            event_status=str(event.get("eventStatus") or root.get("eventStatus") or "")
            cancelled="Cancelled" in event_status or "Postponed" in event_status
            timing=bool(end and duration and not conflict)
            occurrence={"occurrence_id":stable("occurrence:event:",[aid,start.isoformat()]),"activity_id":aid,"place_ids":[pid] if pid else [],
                        "title":title,"venue_name":venue_name,"venue_address":address,"start_at":start.isoformat(),"end_at":end.isoformat() if end else None,
                        "duration_minutes":duration,"duration_origin":"publisher_json_ld_interval" if duration else "unknown",
                        "end_origin":end_origin if end else "unknown",
                        "visible_duration_minutes":visible_minutes,"duration_conflict":conflict,"timezone":"Europe/Moscow",
                        "occurrence_kind":"entry_ticket" if self_guided else "session",
                        "timing_complete":timing,"planner_ready":bool(pid and timing and not self_guided and not cancelled and status!="sold_out"),
                        "venue_identity_reviewed":reviewed,"source_booking_status":status,"booking_status":"unknown","booking_live_verified":False,
                        "event_status_at_fetch":event_status,"price_value":offers.get("price",offers.get("lowPrice")),
                        "price_currency":offers.get("priceCurrency"),"price_type":"from" if "lowPrice" in offers else "published_offer",
                        "ticket_url":offers.get("url"),"source_url":page["final_url"],"source_part":"json_ld",
                        "content_sha256":page["content_sha256"],"fetched_at":snapshot["fetched_at"],"content_verified_at":None,
                        "warnings":["PUBLISHED_SCHEDULE_UNVERIFIED","BOOKING_UNKNOWN"]+(["DURATION_CONFLICT"] if conflict else [])}
            occurrences.append(occurrence)
    return programmes,occurrences,unmatched


def parse_official_reader(saved,now):
    """Explicit date lists plus the year in a published programme period."""
    text=saved["text"]
    months={m:i+1 for i,m in enumerate(("января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"))}
    month_re="|".join(months)
    period=re.search(r"(\d{1,2})\s+("+month_re+r")\s+(20\d{2})\s*[—–-]\s*(\d{1,2})\s+("+month_re+r")\s+(20\d{2})",text,re.I)
    duration=re.search(r"Длительность:\s*(\d+)\s*минут",text,re.I)
    title=re.search(r"^#\s+(.+)$",text,re.M)
    if not period or not duration or not title:raise ValueError("Official reader excerpt lacks required event metadata")
    d,m,y,ed,em,ey=period.groups()
    first=datetime(int(y),months[m.casefold()],int(d),tzinfo=MSK).date()
    last=datetime(int(ey),months[em.casefold()],int(ed),tzinfo=MSK).date()
    minutes=int(duration[1]);aid=stable("activity:event:",[saved["url"],saved["place_id"]])
    sha=hashlib.sha256(text.encode()).hexdigest()
    fetched=saved["observed_at_utc"].replace(" UTC","+00:00").replace(" ","T",1)
    label=re.search(r"Возрастные ограничения:\s*(\d+)\+",text,re.I)
    audience=re.search(r"Для детей от\s*(\d+)\s*до\s*(\d+)\s*лет",text,re.I)
    programme={"activity_id":aid,"place_id":saved["place_id"],"title":title[1],"kind":"session","venue_name":saved["venue"],
               "venue_address":None,"venue_match_method":"reviewed_official_programme_and_venue","venue_identity_reviewed":True,
               "content_label_min":int(label[1]) if label else None,"hard_age_min":None,"hard_age_max":None,"adult_required":None,
               "recommended_age_min":int(audience[1]) if audience else None,"recommended_age_max":int(audience[2]) if audience else None,
               "age_recommendation_origin":"publisher_target_audience" if audience else "unknown",
               "published_duration_minutes":minutes,"duration_quote":duration.group(),"source_url":saved["url"],
               "retrieval_method":"web_reader","hash_basis":"saved_web_reader_text","content_sha256":sha,"fetched_at":fetched,
               "content_verified_at":None,"booking_live_verified":False,"entity_status":"published_official_programme"}
    tiers=[]
    for kind,pattern in (("child",r"Детский билет\s*[-–—]\s*(\d+)\s*руб[^\n]*"),("adult",r"Взрослый билет\s*[-–—]\s*(\d+)\s*руб[^\n]*"),("unspecified",r"Стоимость:\s*(\d+)\s*руб[^\n]*")):
        price=re.search(pattern,text,re.I)
        if price:tiers.append({"ticket_kind":kind,"amount":int(price[1]),"currency":"RUB","quote":price.group(),"fetched_at":fetched})
    programme["price_tiers"]=tiers
    if saved.get("key")=="novogodnyaya_vestochka":
        programme.update(description="Экскурсия об истории Нового года в СССР и мастер-класс по изготовлению открытки.",topics=["history","crafts"],formats=["educational","creative"])
    elif saved.get("key")=="office_deda_moroza":
        programme.update(description="Музыкально-танцевальная сказка с интерактивными играми, Дедом Морозом и Снегурочкой.",topics=["theatre","music"],formats=["playful","spectacular"])
    programme["description_origin"]="editorial_summary_of_official_source"
    programme["feature_origin"]="editorial_tagging_of_official_programme"
    occurrences=[]
    for line in text.splitlines():
        date=re.search(r"(\d{1,2})\s+("+month_re+r")",line,re.I)
        times=re.findall(r"(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)",line)
        if not date or not times:continue
        valid_dates=[]
        for year in range(first.year,last.year+1):
            try:
                candidate=datetime(year,months[date[2].casefold()],int(date[1]),tzinfo=MSK).date()
                if first<=candidate<=last:valid_dates.append(candidate)
            except ValueError:pass
        if len(valid_dates)!=1:raise ValueError("Session year is not uniquely supported by the published period")
        for hour,minute in times:
            start=datetime.combine(valid_dates[0],datetime.min.time(),tzinfo=MSK).replace(hour=int(hour),minute=int(minute))
            if start<now or start>now+timedelta(days=90):continue
            occurrences.append({"occurrence_id":stable("occurrence:event:",[aid,start.isoformat()]),"activity_id":aid,"place_ids":[saved["place_id"]],
                                "title":title[1],"venue_name":saved["venue"],"start_at":start.isoformat(),"end_at":(start+timedelta(minutes=minutes)).isoformat(),
                                "duration_minutes":minutes,"duration_origin":"published_minutes","end_origin":"derived_from_published_duration","duration_conflict":False,
                                "occurrence_kind":"session","timezone":"Europe/Moscow","timing_complete":True,"planner_ready":True,"venue_identity_reviewed":True,
                                "source_booking_status":"unknown","booking_status":"unknown","booking_live_verified":False,"source_url":saved["url"],
                                "quote":line,"period_quote":period.group(),"duration_quote":duration.group(),"source_part":"web_reader_text",
                                "retrieval_method":"web_reader","hash_basis":"saved_web_reader_text","content_sha256":sha,"fetched_at":fetched,"content_verified_at":None,
                                "price_tiers":tiers,"ticket_information_url":saved["url"],
                                "warnings":["PUBLISHED_SCHEDULE_UNVERIFIED","BOOKING_UNKNOWN"]})
    if not occurrences:raise ValueError("No explicit future date/time pairs parsed from official source")
    return programme,occurrences


def build():
    places=[json.loads(l) for l in (ROOT/"outputs/all_places_v1/places.jsonl").read_text().splitlines()]
    extra=ROOT/"data/enriched/tourism_places/places.jsonl"
    if extra.exists():places += [json.loads(l) for l in extra.read_text().splitlines()]
    extra=ROOT/"data/enriched/address_venues/places.jsonl"
    if extra.exists():places += [json.loads(l) for l in extra.read_text().splitlines()]
    report=json.loads((ROOT/"data/processed/site_collection/event_tickets/report.json").read_text())
    programmes,occurrences,unmatched={},{},{}
    now=datetime.now(timezone.utc)
    for job in report["jobs"]:
        if not job.get("snapshot"):continue
        snapshot=json.loads(Path(job["snapshot"]).read_text())
        ps,os,us=parse_programme(snapshot,places,now)
        for p in ps:programmes[p["activity_id"]]=p
        for o in os:occurrences[o["occurrence_id"]]=o
        for u in us:unmatched[u["activity_id"]]=u
    for file in (ROOT/"data/processed/site_collection/official_events").glob("*.reader.json"):
        programme,slots=parse_official_reader(json.loads(file.read_text()),now)
        programmes[programme["activity_id"]]=programme
        for slot in slots:occurrences[slot["occurrence_id"]]=slot
    OUT.mkdir(parents=True,exist_ok=True)
    for name,rows in (("programmes",programmes.values()),("occurrences",occurrences.values()),("unmatched_venues",unmatched.values())):
        (OUT/(name+".jsonl")).write_text("".join(json.dumps(r,ensure_ascii=False)+"\n" for r in rows))
    summary={"programmes":len(programmes),"upcoming_occurrences":len(occurrences),"mapped_programmes":sum(bool(p["place_id"]) for p in programmes.values()),
             "timing_complete":sum(o["timing_complete"] for o in occurrences.values()),"planner_ready_candidates":sum(o["planner_ready"] for o in occurrences.values()),
             "duration_conflicts":sum(o["duration_conflict"] for o in occurrences.values()),"source_sold_out":sum(o["source_booking_status"]=="sold_out" for o in occurrences.values()),
             "unmatched_venues":len(unmatched),"horizon_days":90,"generated_at":now.isoformat(),"source_page_counts":report["counts"]}
    (OUT/"report.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(summary,ensure_ascii=False))


if __name__=="__main__":build()
