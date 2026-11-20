"""Transparent baseline ranking for family activities."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal


Eligibility = Literal["eligible", "ineligible", "unknown"]


@dataclass(frozen=True)
class RankCandidate:
    activity_id: str
    eligibility: dict[str, Eligibility]
    child_interest: dict[str, float]
    child_age_fit: dict[str, float | None]
    adult_interest: float
    popularity: float
    query_match: float
    tags: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class RankingPolicy:
    age_fit_weight: float = 0.35
    child_interest_weight: float = 0.30
    adult_interest_weight: float = 0.10
    query_match_weight: float = 0.15
    popularity_weight: float = 0.10
    unknown_critical_factor: float = 0.65
    mmr_lambda: float = 0.85


@dataclass(frozen=True)
class RankedCandidate:
    activity_id: str
    final_relevance: float
    base_relevance: float
    diversity_penalty: float
    evidence_status: Literal["complete", "critical_unknown"]
    score_components: dict[str, float | None]
    warnings: tuple[str, ...]


def _unit(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be a finite number in [0,1]")
    return float(value)


def _saturate_nonnegative(value: float, name: str) -> float:
    """Map unbounded contract interest scores to [0,1) for the baseline."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return float(value) / (1 + float(value))


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left and not right:
        return 0.0
    return len(left & right) / len(left | right)


def score_candidate(candidate: RankCandidate, policy: RankingPolicy) -> RankedCandidate | None:
    if not candidate.activity_id:
        raise ValueError("activity_id must be nonempty")
    if not candidate.eligibility or set(candidate.eligibility) != set(candidate.child_interest) or set(candidate.eligibility) != set(candidate.child_age_fit):
        raise ValueError("eligibility, child_interest and child_age_fit must contain the same children")
    if any(status == "ineligible" for status in candidate.eligibility.values()):
        return None
    if any(status not in ("eligible", "unknown") for status in candidate.eligibility.values()):
        raise ValueError("invalid eligibility status")

    child_interest_values = [_saturate_nonnegative(value, "child_interest") for value in candidate.child_interest.values()]
    age_values = [None if value is None else _unit(value, "child_age_fit") for value in candidate.child_age_fit.values()]
    age_complete = all(value is not None for value in age_values)
    eligibility_complete = all(status == "eligible" for status in candidate.eligibility.values())
    components: dict[str, float | None] = {
        # Equal child contribution; suitability uses the least-suited child.
        "child_interest": sum(child_interest_values) / len(child_interest_values),
        "age_fit": min(value for value in age_values if value is not None) if age_complete else None,
        "adult_interest": _saturate_nonnegative(candidate.adult_interest, "adult_interest"),
        "query_match": _unit(candidate.query_match, "query_match"),
        "popularity": _unit(candidate.popularity, "popularity"),
    }
    weights = {
        "age_fit": policy.age_fit_weight,
        "child_interest": policy.child_interest_weight,
        "adult_interest": policy.adult_interest_weight,
        "query_match": policy.query_match_weight,
        "popularity": policy.popularity_weight,
    }
    if any(value < 0 for value in weights.values()) or sum(weights.values()) <= 0:
        raise ValueError("ranking weights must be nonnegative with a positive sum")
    known = [(weights[name], value) for name, value in components.items() if value is not None]
    base = sum(weight * value for weight, value in known) / sum(weight for weight, _ in known)
    complete = age_complete and eligibility_complete
    final = base if complete else base * _unit(policy.unknown_critical_factor, "unknown_critical_factor")
    warnings = () if complete else ("AGE_OR_ELIGIBILITY_UNKNOWN",)
    return RankedCandidate(
        activity_id=candidate.activity_id,
        final_relevance=final,
        base_relevance=base,
        diversity_penalty=0.0,
        evidence_status="complete" if complete else "critical_unknown",
        score_components=components,
        warnings=warnings,
    )


def rank_places(
    candidates: list[RankCandidate],
    *,
    limit: int = 10,
    policy: RankingPolicy = RankingPolicy(),
) -> list[RankedCandidate]:
    """Filter, score, then greedily rerank by MMR tag diversity."""
    if limit < 0:
        raise ValueError("limit must be nonnegative")
    _unit(policy.mmr_lambda, "mmr_lambda")
    _unit(policy.unknown_critical_factor, "unknown_critical_factor")
    by_id: dict[str, RankCandidate] = {}
    scored: dict[str, RankedCandidate] = {}
    for candidate in candidates:
        if candidate.activity_id in by_id:
            raise ValueError(f"duplicate activity_id: {candidate.activity_id}")
        by_id[candidate.activity_id] = candidate
        result = score_candidate(candidate, policy)
        if result is not None:
            scored[candidate.activity_id] = result

    selected: list[RankedCandidate] = []
    remaining = set(scored)
    similarities = {activity_id: 0.0 for activity_id in remaining}
    while remaining and len(selected) < limit:
        best_id = ""
        best_key = (-math.inf, -math.inf, "")
        best_penalty = 0.0
        for activity_id in remaining:
            similarity = similarities[activity_id]
            mmr = policy.mmr_lambda * scored[activity_id].final_relevance - (1 - policy.mmr_lambda) * similarity
            key = (mmr, scored[activity_id].final_relevance, activity_id)
            if key > best_key:
                best_id, best_key, best_penalty = activity_id, key, similarity
        item = scored[best_id]
        selected.append(RankedCandidate(
            activity_id=item.activity_id,
            final_relevance=item.final_relevance,
            base_relevance=item.base_relevance,
            diversity_penalty=best_penalty,
            evidence_status=item.evidence_status,
            score_components=item.score_components,
            warnings=item.warnings,
        ))
        remaining.remove(best_id)
        # Each selected item contributes once. Avoid rescanning the entire prefix.
        for activity_id in remaining:
            similarities[activity_id] = max(similarities[activity_id], _jaccard(by_id[activity_id].tags, by_id[best_id].tags))
    return selected
