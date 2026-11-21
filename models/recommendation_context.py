"""Request geography and source-backed calendars, without online routing calls."""
from __future__ import annotations

import math
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def distance_m(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, h)))


def route_distance_m(point, coordinates):
    """Distance to the polyline, not just its vertices. Pilot-local projection."""
    lat = math.radians(point[1])
    scale_x, scale_y = 111195.08 * math.cos(lat), 111195.08
    project = lambda p: ((p[0]-point[0])*scale_x, (p[1]-point[1])*scale_y)
    best = math.inf
    for a, b in zip(coordinates, coordinates[1:]):
        ax, ay = project(a); bx, by = project(b)
        dx, dy = bx-ax, by-ay
        t = max(0, min(1, -(ax*dx+ay*dy)/(dx*dx+dy*dy))) if dx or dy else 0
        best = min(best, math.hypot(ax+t*dx, ay+t*dy))
    return best


def spatial_distance(point, request):
    scope = request["spatial_scope"]
    distance = None
    if scope:
        if scope["center"] is not None:
            distance = distance_m(point, scope["center"]["coordinates"])
            if distance > scope["radius_m"]:
                return False, distance
        routes = ([scope["route"]] if scope["route"] else []) + scope.get("routes", [])
        if routes:
            route_distance = min(route_distance_m(point, r["coordinates"]) for r in routes)
            if route_distance > scope["corridor_width_m"]:
                return False, route_distance
            distance = route_distance
    if distance is None and request["current_point"]:
        distance = distance_m(point, request["current_point"]["coordinates"])
    return True, distance


def calendar_for(row, dates, now):
    result = []
    session = row["activity"]["kind"] == "session"
    for day in dates:
        record = dict(date=day, state="unknown", visit_windows=[], last_entry_at=None, occurrences=[], evidence_ids=[])
        if session:
            for o in row.get("occurrences", []):
                start = datetime.fromisoformat(o["start_at"])
                if start.astimezone(MOSCOW).date().isoformat() != day or start <= now:
                    continue
                record["occurrences"].append(dict(occurrence_id=o["occurrence_id"],
                    interval=dict(start_at=o["start_at"], end_at=o["end_at"]), booking_status="unknown"))
                record["evidence_ids"].extend(o["evidence_ids"])
            record["state"] = "open" if record["occurrences"] else "closed"
        else:
            schedules = row.get("schedules", [])
            # Conflicting calendars and unsupported exceptions remain unknown.
            calendars = []
            for schedule in schedules:
                if not schedule.get("usable"):
                    continue
                windows = []
                target = date.fromisoformat(day)
                for origin in (target-timedelta(days=1), target):
                    for interval in schedule["intervals"]:
                        if DAYS[origin.weekday()] != interval["day_of_week"]:
                            continue
                        start = datetime.combine(origin, time.fromisoformat(interval["opens"]), MOSCOW)
                        end = datetime.combine(origin+timedelta(days=interval["end_day_offset"]),
                                               time.fromisoformat(interval["closes"]), MOSCOW)
                        # Contract v1 requires both endpoints within the requested date.
                        lower = datetime.combine(target, time.min, MOSCOW)
                        upper = datetime.combine(target, time(23, 59, 59), MOSCOW)
                        start, end = max(start, lower), min(end, upper)
                        if start < end:
                            windows.append((start.isoformat(), end.isoformat()))
                calendars.append((sorted(set(windows)), schedule["evidence_ids"]))
            if calendars and all(windows == calendars[0][0] for windows, _ in calendars):
                windows = calendars[0][0]
                record["visit_windows"] = [dict(start_at=a, end_at=b) for a,b in windows]
                # An omitted weekday is not proof of closure in a subset parser.
                record["state"] = "open" if windows else "unknown"
                record["evidence_ids"] = [eid for _, ids in calendars for eid in ids]
        record["evidence_ids"] = sorted(set(record["evidence_ids"]))
        result.append(record)
    return result


def matches_purpose(row, place, purpose):
    category, kind = row["place"]["category"], row["activity"]["kind"]
    true = lambda key: place[key]["state"] == "known" and place[key]["value"] is True
    if purpose in {"initial", "along_route"}:
        return kind in {"visit", "session"}
    if purpose == "restaurant":
        return kind == "meal"
    if purpose == "toilet":
        return kind == "utility" and (category == "toilet" or true("toilet"))
    if purpose == "rain":
        return category == "shelter" or true("shelter") or true("indoor")
    if purpose == "playground":
        return category == "playground"
    if purpose == "rest":
        return kind == "rest" and (category in {"bench", "shelter"} or true("seating"))
    return False


def restaurant_filters(request):
    """Structured requirements take precedence; only bounded explicit text aliases."""
    filters = dict(request.get("restaurant_filters") or {})
    text = request.get("request_text") or ""
    patterns = {"children_menu": r"детск\w*\s+меню|меню\s+для\s+детей",
                "play_area": r"детск\w*\s+(?:игров\w*\s+)?комнат\w*|игров\w*\s+(?:комнат|зон)\w*"}
    # Do not guess requirements in conditional/negated/additive prose.
    if not re.search(r"\b(?:не|без|если|или|возможно|желательно)\b", text, re.I):
        for key, pattern in patterns.items():
            if key not in filters and re.search(pattern, text, re.I):
                filters[key] = True
    return filters


def matches_restaurant(place, filters):
    for key, value in filters.items():
        if value is None:
            continue
        fact = (place.get("restaurant") or {}).get(key)
        if not fact or fact["state"] != "known" or fact["value"] is not value:
            return False
    return True


RESTAURANT_AMENITY_WEIGHTS = {
    # A high chair is the most directly useful facility for families with small children.
    "high_chairs": 0.30,
    "children_menu": 0.25,
    "play_area": 0.15,
    "play_area_supervision": 0.10,
    "small_portions": 0.10,
    "toilet": 0.10,
}


def _preference_fact(fact):
    """Unknown stays distinct from a sourced false value while ranking below true."""
    if not fact or fact.get("state") != "known":
        return 0.25
    return 1.0 if fact.get("value") is True else 0.0


def restaurant_rank_features(place, distance, text_relevance):
    """Restaurant-specific relevance led by proximity and family facilities.

    Distance is geodesic at recommendation time. The planner still validates the
    real walking route before a restaurant can be applied to a trip.
    """
    details = place.get("restaurant") or {}
    facts = {key: details.get(key) for key in RESTAURANT_AMENITY_WEIGHTS}
    facts["toilet"] = place.get("toilet")
    family = sum(RESTAURANT_AMENITY_WEIGHTS[key] * _preference_fact(facts[key])
                 for key in RESTAURANT_AMENITY_WEIGHTS)
    proximity = 0.5 if distance is None else 1 / (1 + max(0, distance) / 400)
    relevance = max(0.0, min(1.0, text_relevance))
    return {
        "proximity": proximity,
        "family_facilities": family,
        "text_relevance": relevance,
        "combined": 0.55 * proximity + 0.35 * family + 0.10 * relevance,
    }


def confirmed_restaurant_facilities(place):
    labels = {
        "high_chairs": "детские стульчики",
        "children_menu": "детское меню",
        "play_area": "игровая зона",
        "play_area_supervision": "присмотр в игровой зоне",
        "small_portions": "маленькие порции",
        "toilet": "туалет",
    }
    details = place.get("restaurant") or {}
    facts = {key: details.get(key) for key in labels}
    facts["toilet"] = place.get("toilet")
    return [label for key, label in labels.items()
            if facts[key] and facts[key].get("state") == "known" and facts[key].get("value") is True]
