"""Export reviewed observations only when their exact quotes exist in saved pages."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from collect_sites import job_key, write_json


def export_facts(claims: list[dict], snapshots: Path, output: Path) -> dict:
    facts = []
    rejected = []
    for claim in claims:
        try:
            snapshot = json.loads((snapshots / f"{job_key(claim)}.json").read_text(encoding="utf-8"))
            page = snapshot["page"]
            if snapshot["source_id"] != claim["source_id"] or page["source_url"] != claim["url"]:
                raise ValueError("snapshot source does not match claim")
            quote = claim["quote"]
            if not quote.strip() or quote not in page["text"]:
                raise ValueError("exact quote is absent from snapshot")
            facts.append({
                "observation_id": hashlib.sha256(json.dumps(claim, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24],
                "entity_key": claim["entity_key"], "canonical_place_id": None,
                "field": claim["field"], "value": claim["value"], "scope": claim["scope"],
                "method": "editorial_review_with_exact_quote", "status": "source_claim",
                "evidence": {"quote": quote, "source_url": page["final_url"], "source_part": "visible_text",
                             "content_sha256": page["content_sha256"], "fetched_at": snapshot["fetched_at"]},
                "content_verified_at": None,
                "notes": claim.get("notes", ""),
            })
        except (OSError, KeyError, ValueError) as error:
            rejected.append({"claim": claim, "error": str(error)})
    output.mkdir(parents=True, exist_ok=True)
    (output / "facts.jsonl").write_text("".join(json.dumps(f, ensure_ascii=False) + "\n" for f in facts), encoding="utf-8")
    with (output / "facts.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["entity_key", "field", "value", "scope", "source_url", "quote", "fetched_at"])
        writer.writeheader()
        for fact in facts:
            writer.writerow({"entity_key": fact["entity_key"], "field": fact["field"],
                             "value": json.dumps(fact["value"], ensure_ascii=False), "scope": fact["scope"],
                             **{key: fact["evidence"][key] for key in ("source_url", "quote", "fetched_at")}})
    expected = {
        "restaurant": ["children_menu", "play_room", "cuisines", "address", "opening_hours_text",
                       "coordinates", "children_dishes", "meal_price", "kitchen_hours", "toilets", "high_chairs"],
        "play_room": ["published_age_range", "under_2_requires_adult", "babysitter_mentioned",
                      "equipment", "colouring_books", "animator_schedule_text", "board_games",
                      "drawing_boards", "soft_toys", "play_tent", "opening_hours_text", "access_conditions"],
    }
    coverage = []
    for entity in sorted({f["entity_key"] for f in facts}):
        for scope, fields in expected.items():
            known = {f["field"] for f in facts if f["entity_key"] == entity and f["scope"] == scope}
            coverage.append({"entity_key": entity, "scope": scope, "known_fields": sorted(known),
                             "unknown_fields": sorted(set(fields) - known)})
    report = {"schema_version": "reviewed-observations-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
              "entities": len({f["entity_key"] for f in facts}), "facts": len(facts), "rejected": rejected,
              "coverage": coverage,
              "publication_status": "internal_candidates_pending_entity_resolution_and_contract_update"}
    write_json(output / "facts_report.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claims", type=Path, default=ROOT / "data/site_collection/reviewed_claims.json")
    parser.add_argument("--snapshots", type=Path, default=ROOT / "data/processed/site_collection/first_batch/pages")
    parser.add_argument("--output", type=Path, default=ROOT / "data/processed/site_collection/first_batch")
    args = parser.parse_args()
    report = export_facts(json.loads(args.claims.read_text(encoding="utf-8"))["claims"], args.snapshots, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["rejected"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
