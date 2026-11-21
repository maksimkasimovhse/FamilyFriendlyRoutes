"""Adapter from a reviewed catalog snapshot to the backend recommendation contract.

The ranker remains responsible only for scoring.  This module owns translation of
the catalog snapshot into the contract consumed by the Go planner, so model code
never fabricates opening hours, age limits, or venue facts.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from place_ranker import RankCandidate, rank_places


UNKNOWN = {"state": "unknown", "value": None, "evidence_ids": []}
DEFAULT_DURATION_SEC = 30 * 60
MODEL_VERSION = "transparent-age-fit-v1"


def _catalog_path() -> Path:
    return Path(os.environ.get("CATALOG_PATH", "/app/data/demo/catalog.jsonl"))


@lru_cache(maxsize=1)
def load_catalog() -> tuple[dict[str, Any], ...]:
    """Load a local, reviewed JSONL snapshot once per process."""
    path = _catalog_path()
    try:
        rows = tuple(json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"catalog snapshot is unavailable: {error}") from error
    if not rows:
        raise ValueError("catalog snapshot is empty")
    return rows


def _band(age_years: int) -> str:
    if 3 <= age_years <= 5:
        return "3-5"
    if 6 <= age_years <= 8:
        return "6-8"
    return "9-11"


def _interest_score(interests: list[str], tags: set[str]) -> float:
    # The ranker accepts non-negative raw interest signals and normalizes them.
    return float(len(set(interests) & tags))


def _duration(activity: dict[str, Any]) -> int:
    value = activity.get("duration_minutes")
    return DEFAULT_DURATION_SEC if not isinstance(value, (int, float)) or value <= 0 else int(value * 60)


def _tags(activity: dict[str, Any]) -> set[str]:
    return set(activity.get("topics") or []) | set(activity.get("formats") or [])


def _candidate_input(row: dict[str, Any], request: dict[str, Any]) -> RankCandidate | None:
    activity = row["activity"]
    tags = _tags(activity)
    children = request["profile"]["children"]
    age_fit = activity.get("age_fit") or {}
    hard_min, hard_max = activity.get("hard_age_min"), activity.get("hard_age_max")
    eligibility: dict[str, str] = {}
    child_interest: dict[str, float] = {}
    child_age_fit: dict[str, float | None] = {}
    for child in children:
        child_id = child["child_id"]
        age = child["age_years"]
        eligibility[child_id] = "ineligible" if (hard_min is not None and age < hard_min) or (hard_max is not None and age > hard_max) else "eligible"
        child_interest[child_id] = _interest_score(child.get("interest_ids") or [], tags)
        score = age_fit.get(_band(age))
        child_age_fit[child_id] = float(score) if isinstance(score, (int, float)) and 0 <= score <= 1 else None
    if any(status == "ineligible" for status in eligibility.values()):
        return None
    adult_interest = _interest_score(request["profile"].get("adult_interest_ids") or [], tags)
    return RankCandidate(
        activity_id=activity["activity_id"],
        eligibility=eligibility,
        child_interest=child_interest,
        child_age_fit=child_age_fit,
        adult_interest=adult_interest,
        popularity=0.5,
        query_match=0.5,
        tags=frozenset(tags),
    )


def _availability(request: dict[str, Any]) -> list[dict[str, Any]]:
    # The snapshot has no verified per-date hours yet. Unknown is deliberate:
    # the planner may make a conditional route but must not claim that a venue
    # is open.
    return [{"date": day["date"], "state": "unknown", "visit_windows": [], "last_entry_at": None, "occurrences": [], "evidence_ids": []} for day in request["days"]]


def _contract_candidate(row: dict[str, Any], request: dict[str, Any], rank: Any, ordinal: int) -> dict[str, Any]:
    place, activity = row["place"], row["activity"]
    evidence = row.get("evidence") or []
    evidence_ids = [item["evidence_id"] for item in evidence if item.get("evidence_id")]
    tags = _tags(activity)
    children = request["profile"]["children"]
    age_fit = activity.get("age_fit") or {}
    return {
        "place": {
            "place_id": place["place_id"], "name": place.get("title") or place.get("name") or activity["title"],
            "location": {"coordinates": [place["location"]["longitude"], place["location"]["latitude"]], "label": place.get("title") or activity["title"]},
            "entrance": None, "categories": place.get("categories") or [place.get("category") or "other"],
            "display_class": place.get("display_class") or "neutral",
            "indoor": (place.get("facts") or {}).get("indoor", UNKNOWN),
            "toilet": (place.get("facts") or {}).get("toilet", UNKNOWN),
            "shelter": (place.get("facts") or {}).get("shelter", UNKNOWN),
            "seating": (place.get("facts") or {}).get("seating", UNKNOWN),
            "restaurant": None, "address": place.get("address"),
            "opening_hours_raw": ((place.get("facts") or {}).get("opening_hours") or {}).get("value"),
        },
        "activity": {
            "activity_id": activity["activity_id"], "place_id": place["place_id"], "title": activity["title"],
            "kind": activity.get("kind") or "visit", "age_min_years": UNKNOWN, "age_max_years": UNKNOWN,
            "recommended_age_min_years": UNKNOWN, "recommended_age_max_years": UNKNOWN, "height_min_cm": UNKNOWN,
            "duration": {"duration_sec": _duration(activity), "source": "estimated", "evidence_ids": evidence_ids},
            "admission_rule": UNKNOWN, "booking_required": UNKNOWN, "evidence_ids": evidence_ids,
        },
        "availability": _availability(request),
        "eligibility": [{"child_id": child["child_id"], "status": "eligible", "reasons": []} for child in children],
        "scores": {
            "child_interest": [{"child_id": child["child_id"], "value": _interest_score(child.get("interest_ids") or [], tags)} for child in children],
            "child_age_fit": [{"child_id": child["child_id"], "value": age_fit.get(_band(child["age_years"]))} for child in children],
            "adult_interest": _interest_score(request["profile"].get("adult_interest_ids") or [], tags),
            "popularity": 0.5, "final_relevance": rank.final_relevance,
        },
        "balance_credit": [{"child_id": child["child_id"], "value": 1 / len(children)} for child in children],
        "is_top_place": ordinal < 3, "reasons": [], "warnings": [],
    }


def recommend(request: dict[str, Any]) -> dict[str, Any]:
    rows = [row for row in load_catalog() if row["activity"]["activity_id"] not in set(request.get("excluded_activity_ids") or []) | set(request.get("visited_activity_ids") or [])]
    by_id = {row["activity"]["activity_id"]: row for row in rows}
    selected_ids = {item["activity_id"] for item in request.get("selections") or []}
    if missing := selected_ids - set(by_id):
        raise ValueError(f"selected activity is absent from catalog: {sorted(missing)[0]}")
    inputs = [candidate for row in rows if (candidate := _candidate_input(row, request)) is not None]
    ranked = rank_places(inputs, limit=min(int(request.get("limit") or 50), 50))
    candidates = [_contract_candidate(by_id[item.activity_id], request, item, index) for index, item in enumerate(ranked)]
    return {
        "contract_version": "1.0", "request_id": request["request_id"], "trip_id": request["trip_id"],
        "trip_version": request["trip_version"], "catalog_version": request["catalog_version"],
        "model_version": MODEL_VERSION, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "complete" if candidates else "no_candidates", "candidates": candidates,
        "rejected": [], "evidence": [], "warnings": [],
    }
