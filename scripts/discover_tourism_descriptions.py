"""Parse public tourism directory cards and resolve name+coordinate candidates.

Only follows the directory's own next-page links, at most 60 pages, 3s per host.
Uses the project's safe HTML fetcher and stores original HTML and normalized text.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))
from site_ingestion import SourcePolicy, fetch_page
from source_matching import normalize_name, separation_m
from collect_sites import write_json

OUTPUT = ROOT / "data/processed/site_collection/tourism_directory"
START = "https://nn-grad.ru/kuda-poyti/"


def parse_cards(raw, page_url, fetched_at, content_sha256):
    soup = BeautifulSoup(raw, "html.parser")
    cards = []
    for node in soup.select(".items__item"):
        title, description, coords = node.select_one("a.items__item-name"), node.select_one(".items__item-descr"), node.select_one("[data-coords]")
        if not title or not title.get("href"):
            continue
        cards.append({"name": title.get_text(" ", strip=True),
                      "description": " ".join(description.get_text(" ", strip=True).split()) if description else None,
                      "coordinates_lat_lon": json.loads(coords["data-coords"]) if coords else None,
                      "source_url": urljoin(page_url, title["href"]), "listing_url": page_url,
                      "fetched_at": fetched_at, "content_sha256": content_sha256})
    next_node = next((a for a in soup.find_all("a", href=True) if "Показать еще" in a.get_text()), None)
    return cards, urljoin(page_url, next_node["href"]) if next_node else None


def name_score(left, right):
    left, right = normalize_name(left), normalize_name(right)
    if left == right:
        return 1.0
    l, r = set(left.split()), set(right.split())
    # One common generic word must never establish the identity of a place.
    meaningful = (l & r) - {"музей", "театр", "парк", "нижний", "новгород", "кафе", "библиотека", "имени", "им"}
    return SequenceMatcher(None, left, right).ratio() if meaningful else 0.0


def match_cards(cards, osm):
    matches = []
    for row in osm:
        p = row["place"]
        if not row["provenance"]["raw_tags"].get("name"):
            continue
        candidates = []
        for card in cards:
            if not card["coordinates_lat_lon"]:
                continue
            lat, lon = card["coordinates_lat_lon"]
            distance = separation_m((p["location"]["longitude"], p["location"]["latitude"]), (lon, lat))
            score = name_score(p["name"], card["name"])
            if distance <= 300 and score >= 0.68:
                candidates.append({**card, "distance_m": round(distance, 1), "name_score": round(score, 3)})
        candidates.sort(key=lambda c: (-c["name_score"], c["distance_m"]))
        if candidates:
            exact = [c for c in candidates if c["name_score"] == 1]
            if len(exact) == 1:
                candidates = exact
            matches.append({"place_id": p["place_id"], "name": p["name"], "candidates": candidates,
                            "status": "exact_name_nearby" if len(candidates) == 1 and candidates[0]["name_score"] == 1 else "needs_identity_review"})
    return matches


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    url, seen, cards, pages = START, set(), {}, []
    policy = SourcePolicy("nn-grad-tourism", ("nn-grad.ru", "www.nn-grad.ru"), True)
    while url and url not in seen and len(pages) < 60:
        if urlparse(url).hostname != "nn-grad.ru" or not urlparse(url).path.startswith("/kuda-poyti/"):
            raise ValueError("Pagination escaped the directory")
        seen.add(url)
        key = str(len(pages) + 1).zfill(3)
        raw_path, snapshot = OUTPUT / f"{key}.html", OUTPUT / f"{key}.json"
        if raw_path.exists() and snapshot.exists():
            saved = json.loads(snapshot.read_text())
        else:
            if pages:
                time.sleep(3)
            page = fetch_page(url, policy, raw_output=raw_path)
            saved = {"fetched_at": datetime.now(timezone.utc).isoformat(), "page": asdict(page)}
            write_json(snapshot, saved)
        found, next_url = parse_cards(raw_path.read_bytes(), url, saved["fetched_at"], saved["page"]["content_sha256"])
        for card in found:
            cards[card["source_url"]] = card
        pages.append({"url": url, "cards": len(found)})
        url = next_url
        osm = [json.loads(line) for line in (ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl").read_text().splitlines()]
        matched = match_cards(list(cards.values()), osm)
        write_json(OUTPUT / "cards.json", {"cards": list(cards.values())})
        write_json(OUTPUT / "matches.json", {"matches": matched})
        write_json(OUTPUT / "report.json", {"pages": pages, "cards": len(cards), "osm_matches": len(matched),
                                            "exact_name_nearby": sum(m["status"] == "exact_name_nearby" for m in matched),
                                            "pagination_complete": not url})
        print(json.dumps({"page": len(pages), "cards": len(cards), "osm_matches": len(matched)}), flush=True)
    if url:
        raise ValueError("Pagination was not completed; inspect report before claiming full coverage")
    details = []
    for match in matched:
        for card in match["candidates"]:
            detail_url = card["source_url"]
            if any(d["source_url"] == detail_url for d in details):
                continue
            import hashlib
            key = hashlib.sha256(detail_url.encode()).hexdigest()[:24]
            raw_path, snapshot = OUTPUT / f"detail_{key}.html", OUTPUT / f"detail_{key}.json"
            try:
                if raw_path.exists() and snapshot.exists():
                    saved = json.loads(snapshot.read_text())
                else:
                    time.sleep(3)
                    page = fetch_page(detail_url, policy, raw_output=raw_path)
                    saved = {"fetched_at": datetime.now(timezone.utc).isoformat(), "page": asdict(page)}
                    write_json(snapshot, saved)
                soup = BeautifulSoup(raw_path.read_bytes(), "html.parser")
                description = soup.select_one(".tabs .content")
                title = soup.select_one("h1.item__name")
                if not description or not title or normalize_name(title.get_text(" ", strip=True)) != normalize_name(card["name"]):
                    raise ValueError("Detail title or description block did not match the selected card")
                paragraphs = [" ".join(p.get_text(" ", strip=True).split()) for p in description.find_all("p") if p.get_text(strip=True)]
                text = "\n".join(paragraphs) if paragraphs else " ".join(description.get_text(" ", strip=True).split())
                details.append({"source_url": detail_url, "name": card["name"], "description": text,
                                "content_sha256": saved["page"]["content_sha256"], "fetched_at": saved["fetched_at"]})
            except Exception as error:
                details.append({"source_url": detail_url, "status": "error", "error_type": type(error).__name__})
            write_json(OUTPUT / "details.json", {"details": details})
            print(json.dumps({"details": len(details), "matched_places": len(matched)}), flush=True)


if __name__ == "__main__":
    main()
