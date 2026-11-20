"""Собирает places.json для мок-ручки /api/v1/map/places (схема Place из openapi.json).

Источник — OSM-выгрузка frontend/data/amenities.geojson (туалеты, площадки, кафе в центре).
Факты по умолчанию «unknown». Известно из OSM только то, что туалет — это туалет.

ДЕМО: у 10 кафе рядом с остановками маршрута заполнены детские факты (детское меню,
детская зона, маленькие порции) с источником ev-demo-*. Это НЕ проверенные данные —
фронт показывает у таких кафе значок «демо». Заменить реальными, когда команда их соберёт.

Запуск: python3 infra/mock-api/build_places.py
"""

import json
import math
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")
UNKNOWN = {"state": "unknown", "value": None, "evidence_ids": []}
DEMO_CAFES_PER_STOP = 2


def known(value, evidence_id):
    return {"state": "known", "value": value, "evidence_ids": [evidence_id]}


def dist(a, b):
    k = math.pi / 180
    x = (b[0] - a[0]) * math.cos((a[1] + b[1]) / 2 * k)
    return math.hypot(x, b[1] - a[1]) * k * 6371000


amenities = json.load(open(os.path.join(ROOT, "frontend/data/amenities.geojson"), encoding="utf-8"))
stops = json.load(open(os.path.join(HERE, "catalog.json"), encoding="utf-8"))["items"]

# Кафе для демо: по 2 ближайших с названием к каждой остановке
cafes = [f for f in amenities["features"] if f["properties"]["kind"] == "cafe" and f["properties"].get("name")]
demo_ids = []
for s in stops:
    near = sorted(cafes, key=lambda f: dist(s["point"], f["geometry"]["coordinates"]))
    for f in near:
        if len([i for i in demo_ids if i]) >= DEMO_CAFES_PER_STOP * (stops.index(s) + 1):
            break
        if f["properties"]["osm"] not in demo_ids:
            demo_ids.append(f["properties"]["osm"])
# Разные сочетания, чтобы в демо было видно и «да», и «нет», и «нет данных»
PATTERNS = [
    {"children_menu": True, "play_area": True, "small_portions": True},
    {"children_menu": True, "play_area": False, "small_portions": None},
    {"children_menu": None, "play_area": None, "small_portions": True},
    {"children_menu": False, "play_area": None, "small_portions": None},
]

items, evidence = [], []
for f in amenities["features"]:
    p = f["properties"]
    osm = p["osm"]
    pid = "osm-" + osm.replace("/", "-")
    kind = p["kind"]
    place = {
        "place_id": pid,
        "name": p.get("name") or {"toilets": "Туалет", "playground": "Детская площадка", "cafe": "Кафе"}[kind],
        "location": {"coordinates": f["geometry"]["coordinates"], "label": None},
        "entrance": None,
        "categories": [{"toilets": "toilet", "playground": "playground", "cafe": "restaurant"}[kind]],
        "display_class": "family" if kind != "cafe" else "neutral",
        "indoor": UNKNOWN, "toilet": UNKNOWN, "shelter": UNKNOWN, "seating": UNKNOWN,
        "restaurant": None,
    }
    if kind == "toilets":
        ev = "ev-osm-" + osm.replace("/", "-")
        evidence.append({"evidence_id": ev, "source_url": "https://www.openstreetmap.org/" + osm,
                         "source_kind": "osm", "checked_at": NOW, "valid_until": None})
        place["toilet"] = known(True, ev)
    if kind == "cafe":
        place["restaurant"] = {k: UNKNOWN for k in ("children_menu", "small_portions", "play_area",
                                                    "play_area_min_age", "play_area_max_age", "play_area_supervision")}
        if osm in demo_ids:
            ev = "ev-demo-" + osm.replace("/", "-")
            evidence.append({"evidence_id": ev, "source_url": None, "source_kind": "manual",
                             "checked_at": NOW, "valid_until": None})
            for key, value in PATTERNS[demo_ids.index(osm) % len(PATTERNS)].items():
                if value is not None:
                    place["restaurant"][key] = known(value, ev)
            place["seating"] = known(True, ev)
            place["display_class"] = "family"
    items.append(place)

# Тип заведения («кофейня», «пиццерия»…) — в схеме Place такого поля нет, поэтому отдельным файлом для фронта
types = {"osm-" + f["properties"]["osm"].replace("/", "-"): f["properties"]["type"]
         for f in amenities["features"] if f["properties"].get("type")}
json.dump(types, open(os.path.join(ROOT, "frontend/data/place-types.json"), "w", encoding="utf-8"), ensure_ascii=False)

out = {"catalog_version": "mock-places-v1",
       "about": "МОК для /api/v1/map/places. OSM-выгрузка + демо-факты у кафе (evidence ev-demo-*, не проверено).",
       "items": items, "evidence": evidence}
json.dump(out, open(os.path.join(HERE, "places.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(f"places.json: {len(items)} мест, демо-кафе: {len(demo_ids)}")
for osm in demo_ids:
    f = next(x for x in amenities["features"] if x["properties"]["osm"] == osm)
    print("  демо:", f["properties"]["name"])
