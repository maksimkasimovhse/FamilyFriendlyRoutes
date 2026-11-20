"""Resolve place-specific age suitability separately from user interest.

Every activity has up to three soft suitability scores, one for each supported
age band. A child's age selects a score; it never applies a global multiplier
to all activities. Hard age restrictions belong to eligibility and must be
checked before this module is used.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping


AGE_BANDS = ("3-5", "6-8", "9-11")


def age_band(age_years: int) -> str:
    if isinstance(age_years, bool) or not isinstance(age_years, int) or not 3 <= age_years <= 11:
        raise ValueError("age_years must be an integer from 3 through 11")
    if age_years <= 5:
        return "3-5"
    if age_years <= 8:
        return "6-8"
    return "9-11"


def validate_age_fit_profile(profile: Mapping[str, float | None]) -> dict[str, float | None]:
    """Validate an activity profile with exactly one value per age band."""
    if set(profile) != set(AGE_BANDS):
        raise ValueError(f"age-fit profile must contain exactly: {', '.join(AGE_BANDS)}")
    result: dict[str, float | None] = {}
    for band in AGE_BANDS:
        value = profile[band]
        if value is None:
            result[band] = None
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"age fit for {band} must be a finite number in [0,1] or None")
        if not 0 <= value <= 1:
            raise ValueError(f"age fit for {band} must be in [0,1]")
        result[band] = float(value)
    return result


def age_fit_for_child(age_years: int, profile: Mapping[str, float | None]) -> float | None:
    """Select this activity's soft suitability score for a child's age band."""
    return validate_age_fit_profile(profile)[age_band(age_years)]


def resolve_children_age_fit(
    children: Iterable[Mapping[str, object]],
    profile: Mapping[str, float | None],
) -> list[dict[str, str | float | None]]:
    """Return Candidate.scores.child_age_fit entries for one activity."""
    checked_profile = validate_age_fit_profile(profile)
    result: list[dict[str, str | float | None]] = []
    seen: set[str] = set()
    for child in children:
        child_id = child.get("child_id")
        if not isinstance(child_id, str) or not child_id or child_id in seen:
            raise ValueError("child_id must be a unique nonempty string")
        age = child.get("age_years")
        band = age_band(age)  # type: ignore[arg-type]
        seen.add(child_id)
        result.append({"child_id": child_id, "value": checked_profile[band]})
    if not result:
        raise ValueError("at least one child is required")
    return result


def resolve_child_interest_weights(children: Iterable[Mapping[str, object]]) -> list[dict[str, str | float]]:
    """Keep child interests equal; age suitability is resolved separately."""
    children_list = list(children)
    resolved = resolve_children_age_fit(children_list, {band: None for band in AGE_BANDS})
    weight = 1 / len(resolved)
    return [{"child_id": str(entry["child_id"]), "weight": weight} for entry in resolved]
