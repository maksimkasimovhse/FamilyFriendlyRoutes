"""Restore extractive place descriptions from snapshots collected by the site parser.

Only source text is published. LLM paraphrases, hours and age rules are not promoted.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
sys.path.insert(0, str(ROOT / "scripts"))
from source_matching import normalize_name
from collect_sites import write_json

SOURCE = ROOT / "data/enriched/osm_nizhny_1000/catalog.jsonl"
SITES = ROOT / "data/processed/site_collection/osm_descriptions"
TOURISM = ROOT / "data/processed/site_collection/tourism_directory"
OUTPUT = ROOT / "data/enriched/osm_descriptions"
SUBJECT = re.compile(r"(?i)музе|галере|экспозиц|истори|посвящ|выстав|театр|библиотек|ресторан|кофейн|кухн|кафе|пекар|культур|парк|пространств|центр|ремес|является|расположен|основан|представлен")
NOISE = re.compile(r"(?i)cookie|куки|персональн|конфиденциал|пользовательск|согласие на|обработк[ауи] данных|\bИНН\b|\bОГРН\b|©|все права защищ|забронировать|добавить в корзину|\bскидк|рекламн|публичн.*оферт|маркетинг|разработка сайтов|новая коллекция посвящена|продвижени[ея] сайтов|родился|бар-менеджер|отч[её]т с|благодарност|спасибо|ходили с|очень приятное место|наш слоган|новогодн|приготовит для вас")


def contains_name(text, aliases):
    text = " " + normalize_name(text or "") + " "
    return any((value := normalize_name(name)) and " " + value + " " in text for name in aliases)


def candidates_from_page(page, aliases, extraction=None):
    lines = page["text"].splitlines()
    candidates = []
    for index, line in enumerate(lines):
        # A contiguous source paragraph is evidence, including spelling and punctuation.
        quote = line.strip()
        if not 70 <= len(quote) <= 1800 or not SUBJECT.search(quote) or NOISE.search(quote):
            continue
        if len(quote) > 1100:
            quote = quote[:1100].rsplit(". ", 1)[0] + "." if ". " in quote[:1100] else quote[:1100].rsplit(" ", 1)[0]
        score = 5 * contains_name(quote, aliases) + min(len(SUBJECT.findall(quote)), 5) + (2 if index < 25 else 0)
        candidates.append((score, -index, quote))
    # Retain exact, validated model evidence as a fallback; never the generated claim.
    for activity in (extraction or {}).get("activities", []):
        for span in activity.get("description_evidence", []):
            quote = span["quote"]
            if span["source_part"] == "visible_text" and quote in page["text"] and 70 <= len(quote) <= 1100 and SUBJECT.search(quote) and not NOISE.search(quote):
                candidates.append((5 * contains_name(quote, aliases) + 2, 0, quote))
    candidates.sort(reverse=True)
    return candidates


def structured_description(page, aliases):
    allowed = {"Restaurant", "CafeOrCoffeeShop", "FoodEstablishment", "Museum", "Library", "LocalBusiness", "Organization", "WebSite", "WebPage"}
    def objects(node):
        if isinstance(node, list):
            for item in node:
                yield from objects(item)
        elif isinstance(node, dict):
            yield node
            if "@graph" in node:
                yield from objects(node["@graph"])
    for node in objects(page.get("json_ld", [])):
        types = node.get("@type", [])
        types = [types] if isinstance(types, str) else types
        text = node.get("description")
        if allowed.intersection(types) and isinstance(text, str) and 40 <= len(text) <= 1500 and not NOISE.search(text):
            if contains_name(node.get("name"), aliases) or contains_name(page.get("title"), aliases):
                return text
    return None


def recover():
    osm = [json.loads(line) for line in SOURCE.read_text().splitlines()]
    by_id = {r["place"]["place_id"]: r for r in osm}
    observations = defaultdict(list)
    editorial = json.loads((ROOT / "data/site_collection/osm_description_review.json").read_text())
    rejected_sites = {r["place_id"] for r in editorial["reject_site_descriptions"]}
    selections = {(pid, selection["url"]): selection for selection in editorial["selections"] for pid in selection["place_ids"]}
    report = json.loads((SITES / "report.json").read_text()) if (SITES / "report.json").exists() else {"jobs": []}
    job_outcomes = defaultdict(list)
    for job in report["jobs"]:
        for pid in job["place_ids"]:
            job_outcomes[pid].append("fetched" if job.get("snapshot") else job["status"])
        if not job.get("snapshot"):
            continue
        snapshot = json.loads(Path(job["snapshot"]).read_text())
        page = snapshot["page"]
        extraction = json.loads(Path(job["extraction"]).read_text())["extraction"] if job.get("extraction") else None
        for pid in job["place_ids"]:
            original = by_id[pid]
            tags = original["provenance"]["raw_tags"]
            aliases = [original["place"]["name"]] + [tags[k] for k in ("name:ru", "name:en", "alt_name") if tags.get(k)]
            if pid in rejected_sites:
                continue
            selection = selections.get((pid, job["url"]))
            candidates = candidates_from_page(page, aliases, extraction)
            structured = structured_description(page, aliases)
            source_part = "visible_text"
            if selection:
                if selection.get("quote"):
                    quote = selection["quote"]
                else:
                    matching_lines = [line for line in page["text"].splitlines() if selection["line_contains"] in line]
                    if len(matching_lines) != 1:
                        raise ValueError(f"Reviewed description selector is ambiguous or missing: {pid}")
                    quote = matching_lines[0]
                if quote not in page["text"]:
                    raise ValueError(f"Reviewed quote is missing from source: {pid}")
            elif structured:
                quote = structured
                source_part = "json_ld"
            elif candidates:
                quote = candidates[0][2]
            else:
                continue
            # A page linked from OSM is a candidate; explicitly match its name too.
            identity = bool(selection) or contains_name(page.get("title"), aliases) or contains_name(quote, aliases)
            observations[pid].append({"description": quote, "status": "source_name_matched" if identity else "needs_identity_review",
                                      "scope": "brand" if len(job["place_ids"]) > 1 else "place",
                                      "origin": "parsed_site_excerpt", "source_url": page["final_url"],
                                      "quote": quote, "content_sha256": page["content_sha256"],
                                      "fetched_at": snapshot["fetched_at"], "source_part": source_part,
                                      "discovery_methods": job["discovery_methods"], "content_verified_at": None})
    if (TOURISM / "matches.json").exists():
        details = {d["source_url"]: d for d in json.loads((TOURISM / "details.json").read_text())["details"]} if (TOURISM / "details.json").exists() else {}
        for match in json.loads((TOURISM / "matches.json").read_text())["matches"]:
            for c in match["candidates"]:
                if c.get("description"):
                    detail = details.get(c["source_url"], {})
                    description = detail.get("description") or c["description"]
                    observations[match["place_id"]].append({
                        "status": "source_name_matched" if match["status"] == "exact_name_nearby" else "needs_identity_review",
                        "scope": "place", "origin": "parsed_tourism_detail" if detail.get("description") else "parsed_tourism_card",
                        "source_url": c["source_url"] if detail.get("description") else c["listing_url"],
                        "detail_url": c["source_url"], "description": description, "quote": description, "source_part": "html_description_block",
                        "content_sha256": detail.get("content_sha256", c["content_sha256"]), "fetched_at": detail.get("fetched_at", c["fetched_at"]),
                        "distance_m": c["distance_m"], "name_score": c["name_score"], "content_verified_at": None})
    output, queue = [], []
    for original in osm:
        pid = original["place"]["place_id"]
        tags = original["provenance"]["raw_tags"]
        description = original["activity"].get("description_text")
        accepted = [o for o in observations[pid] if o["status"] == "source_name_matched"]
        # Prefer descriptive paragraphs to short card captions.
        accepted.sort(key=lambda o: (o["scope"] == "place", o["origin"] == "parsed_site_excerpt", len(o["description"])), reverse=True)
        chosen = accepted[0] if accepted else None
        status = ("restored_from_site" if chosen else "osm_description" if description else
                  "identity_review" if observations[pid] else
                  "no_description_on_page" if any(s != "error" for s in job_outcomes[pid]) else
                  "fetch_failed" if job_outcomes[pid] else
                  "name_missing" if not tags.get("name") else "source_discovery_required")
        row = {"place_id": pid, "name": original["place"]["name"], "description": chosen["description"] if chosen else description,
               "description_status": status, "description_origin": chosen["origin"] if chosen else "osm_description" if description else "unknown",
               "description_evidence": [chosen] if chosen else [{"origin": "osm_description", "scope": "place",
                    "source_url": original["evidence"][0]["source_url"], "quote": description,
                    "source_part": "osm_tag", "fetched_at": original["provenance"].get("retrieved_at"),
                    "content_verified_at": None}] if description else [], "description_candidates": observations[pid],
               "osm_source_url": original["evidence"][0]["source_url"]}
        output.append(row)
        queue.append({"place_id": pid, "name": row["name"], "category": original["place"]["categories"][0],
                      "status": status, "source_url": chosen["source_url"] if chosen else "",
                      "candidate_urls": " | ".join(j["url"] for j in report["jobs"] if pid in j["place_ids"]),
                      "errors": " | ".join(j.get("error_type", "") for j in report["jobs"] if pid in j["place_ids"] and j.get("error_type")),
                      "description_characters": len(row["description"] or "")})
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "descriptions.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in output))
    with (OUTPUT / "queue.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(queue[0])); writer.writeheader(); writer.writerows(queue)
    counts = dict(Counter(r["description_status"] for r in output))
    write_json(OUTPUT / "report.json", {"records": len(output), "status_counts": counts,
        "description_count": sum(bool(r["description"]) for r in output),
        "restored_previously_missing": sum(r["description_status"] == "restored_from_site" and not by_id[r["place_id"]]["activity"].get("description_text") for r in output),
        "site_page_counts": report.get("counts", {}),
        "downloaded_pages": sum(bool(j.get("snapshot")) for j in report["jobs"]),
        "source_claims_not_field_verification": True,
        "notes": ["Source excerpts only; generated model claims are not promoted.", "Brand descriptions do not confirm a branch's visit conditions.", "No review-derived descriptions."]})
    print(json.dumps(counts, ensure_ascii=False))
    return output


if __name__ == "__main__":
    recover()
