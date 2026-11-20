"""МОК-сервис по контрактам docs/contracts/openapi.json — для демо, пока нет настоящих.

  POST /internal/v1/recommendations — вместо ML-сервиса (отвечает Go-бекенду, режим -ml-url)
  GET  /api/v1/map/places           — вместо ещё не реализованной ручки бекенда (карта, «Нужно сейчас»)
  GET  /healthz

Данные: catalog.json (места для маршрута) и places.json (туалеты, площадки, кафе;
собирается build_places.py из OSM-выгрузки). Только стандартная библиотека Python.
Слушает только 127.0.0.1 — наружу не публикуется.
"""

import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = json.load(open(os.path.join(HERE, "catalog.json"), encoding="utf-8"))
PLACES = json.load(open(os.path.join(HERE, "places.json"), encoding="utf-8"))
UNKNOWN = {"state": "unknown", "value": None, "evidence_ids": []}


def candidate(item, rank, req):
    """Один кандидат по схеме Candidate."""
    children = req["profile"]["children"]
    share = 1 / len(children)
    # Открытые городские места: доступны весь день каждой даты поездки
    availability = [{
        "date": day["date"], "state": "open",
        "visit_windows": [{"start_at": day["date"] + "T00:00:00+03:00", "end_at": day["date"] + "T23:59:00+03:00"}],
        "last_entry_at": None, "occurrences": [], "evidence_ids": [],
    } for day in req["days"]]
    return {
        "place": {
            "place_id": item["id"], "name": item["name"],
            "location": {"coordinates": item["point"], "label": item["name"]}, "entrance": None,
            "categories": [item["category"]], "display_class": "family",
            "indoor": UNKNOWN, "toilet": UNKNOWN, "shelter": UNKNOWN, "seating": UNKNOWN, "restaurant": None,
        },
        "activity": {
            "activity_id": item["id"], "place_id": item["id"], "title": item["name"], "kind": "visit",
            "age_min_years": UNKNOWN, "age_max_years": UNKNOWN,
            "recommended_age_min_years": UNKNOWN, "recommended_age_max_years": UNKNOWN,
            "height_min_cm": UNKNOWN,
            "duration": {"duration_sec": item["duration_sec"], "source": "estimated", "evidence_ids": []},
            "admission_rule": UNKNOWN, "booking_required": UNKNOWN, "evidence_ids": [],
        },
        "availability": availability,
        "eligibility": [{"child_id": c["child_id"], "status": "eligible", "reasons": []} for c in children],
        "scores": {
            "child_interest": [{"child_id": c["child_id"], "value": 0.8} for c in children],
            "adult_interest": 0.8, "popularity": 0.8,
            "final_relevance": round(1 - rank / 100, 3),   # порядок каталога = порядок важности
        },
        "balance_credit": [{"child_id": c["child_id"], "value": share} for c in children],
        "is_top_place": rank < 2, "reasons": [], "warnings": [],
    }


def recommendations(req):
    limit = req.get("limit") or 50
    excluded = set(req.get("excluded_activity_ids") or []) | set(req.get("visited_activity_ids") or [])
    items = [i for i in CATALOG["items"] if i["id"] not in excluded][:limit]
    return {
        "contract_version": "1.0", "request_id": req["request_id"], "trip_id": req["trip_id"],
        "trip_version": req["trip_version"], "catalog_version": req["catalog_version"],
        "model_version": "mock-ml-v1", "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "complete", "candidates": [candidate(i, n, req) for n, i in enumerate(items)],
        "rejected": [], "evidence": [], "warnings": [],
    }


def map_places(query):
    items = PLACES["items"]
    if "bbox" in query:
        w, s, e, n = (float(x) for x in query["bbox"][0].split(","))
        items = [p for p in items if w <= p["location"]["coordinates"][0] <= e and s <= p["location"]["coordinates"][1] <= n]
    if "categories" in query:
        wanted = set(",".join(query["categories"]).split(","))
        items = [p for p in items if wanted & set(p["categories"])]
    limit = min(int(query.get("limit", ["500"])[0]), 1000)
    items = items[:limit]
    used = {e for p in items for e in evidence_ids(p)}
    return {"catalog_version": PLACES["catalog_version"], "items": items,
            "evidence": [e for e in PLACES["evidence"] if e["evidence_id"] in used], "next_cursor": None}


def evidence_ids(place):
    facts = [place[k] for k in ("indoor", "toilet", "shelter", "seating")]
    if place.get("restaurant"):
        facts += list(place["restaurant"].values())
    return {e for f in facts for e in f["evidence_ids"]}


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz":
            return self.send(200, {"status": "alive", "mock": True})
        if url.path == "/api/v1/map/places":
            return self.send(200, map_places(parse_qs(url.query)))
        self.send(404, {"error": {"code": "NOT_FOUND", "message": "Мок не знает этот путь"}})

    def do_POST(self):
        if urlparse(self.path).path != "/internal/v1/recommendations":
            return self.send(404, {"error": {"code": "NOT_FOUND", "message": "Мок не знает этот путь"}})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.send(200, recommendations(req))
        except (ValueError, KeyError) as err:
            self.send(400, {"error": {"code": "INVALID_REQUEST", "message": str(err)}})

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-api: " + fmt % args + "\n")


if __name__ == "__main__":
    addr = os.environ.get("MOCK_API_LISTEN", "127.0.0.1:8090")
    host, port = addr.rsplit(":", 1)
    print(f"MOCK API http://{addr} (recommendations + map places)", flush=True)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
