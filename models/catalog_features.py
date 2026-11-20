"""Deterministic catalog text and feature inputs after reviewed extraction."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

from age_band_policy import AGE_BANDS, validate_age_fit_profile
from site_schema import ActivityExtraction


FEATURES_VERSION = "catalog-text-v1"


@dataclass(frozen=True)
class CatalogFeatureInput:
    description_text: str | None
    embedding_text: str
    embedding_input_sha256: str
    topics: tuple[str, ...]
    formats: tuple[str, ...]
    duration_minutes: int | None
    hard_age_min: int | None
    hard_age_max: int | None
    recommended_age_min: int | None
    recommended_age_max: int | None
    age_fit_profile: dict[str, float | None]
    features_version: str = FEATURES_VERSION


def _plain_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def build_embedding_text(
    title: str,
    description: str | None,
    topics: tuple[str, ...],
    formats: tuple[str, ...],
) -> tuple[str, str]:
    """Return versioned semantic text and its SHA-256 fingerprint."""
    cleaned_description = _plain_text(description) if description else None
    sections = [
        f"Название: {_plain_text(title)}",
        *([f"Описание: {cleaned_description}"] if cleaned_description else []),
        *([f"Темы: {', '.join(sorted(set(topics)))}"] if topics else []),
        *([f"Форматы: {', '.join(sorted(set(formats)))}"] if formats else []),
    ]
    embedding_text = "\n".join(sections)
    return embedding_text, hashlib.sha256(embedding_text.encode("utf-8")).hexdigest()


def _age_range(activity: ActivityExtraction, kind: str) -> tuple[int | None, int | None]:
    rules = [rule for rule in activity.age_rules if rule.kind == kind]
    if not rules:
        return None, None
    minimums = [rule.min_age_years for rule in rules if rule.min_age_years is not None]
    maximums = [rule.max_age_years for rule in rules if rule.max_age_years is not None]
    return (max(minimums) if minimums else None, min(maximums) if maximums else None)


def build_catalog_feature_input(
    activity: ActivityExtraction,
    *,
    age_fit_profile: dict[str, float | None] | None = None,
) -> CatalogFeatureInput:
    """Build stable embedding input without volatile schedule or evidence text.

    Age suitability is supplied by curation/model output. Hard restrictions and
    recommendations remain separate facts and never become implicit soft scores.
    """
    description = _plain_text(activity.description) if activity.description else None
    topics = tuple(sorted(set(activity.topics)))
    formats = tuple(sorted(set(activity.formats)))
    embedding_text, fingerprint = build_embedding_text(
        activity.source_title, description, topics, formats,
    )
    hard_min, hard_max = _age_range(activity, "hard_restriction")
    recommended_min, recommended_max = _age_range(activity, "recommendation")
    profile = validate_age_fit_profile(
        age_fit_profile if age_fit_profile is not None else {band: None for band in AGE_BANDS}
    )
    return CatalogFeatureInput(
        description_text=description,
        embedding_text=embedding_text,
        embedding_input_sha256=fingerprint,
        topics=topics,
        formats=formats,
        duration_minutes=activity.duration_minutes,
        hard_age_min=hard_min,
        hard_age_max=hard_max,
        recommended_age_min=recommended_min,
        recommended_age_max=recommended_max,
        age_fit_profile=profile,
    )


def feature_input_json(value: CatalogFeatureInput) -> str:
    """Canonical JSON for fixtures, queues and batch feature jobs."""
    return json.dumps(value.__dict__, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
