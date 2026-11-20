"""Validated output contract for extracting catalog candidates from a web page."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from taxonomy import FORMATS, INTEREST_IDS


DayOfWeek = Literal["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


class EvidenceSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quote: str = Field(min_length=1, max_length=500)
    source_url: str
    source_part: Literal["visible_text", "json_ld"]


class OpeningInterval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day_of_week: DayOfWeek
    opens: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    closes: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    evidence: list[EvidenceSpan] = Field(min_length=1)


class EventOccurrence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_at: str | None
    end_at: str | None
    duration_minutes: int | None = Field(ge=1, le=1440)
    evidence: list[EvidenceSpan] = Field(min_length=1)


class AgeRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["hard_restriction", "recommendation", "content_label"]
    min_age_years: int | None = Field(ge=0, le=18)
    max_age_years: int | None = Field(ge=0, le=18)
    evidence: list[EvidenceSpan] = Field(min_length=1)

    @model_validator(mode="after")
    def ordered_range(self) -> "AgeRule":
        if self.min_age_years is None and self.max_age_years is None:
            raise ValueError("an age rule needs min_age_years or max_age_years")
        if self.min_age_years is not None and self.max_age_years is not None and self.min_age_years > self.max_age_years:
            raise ValueError("min_age_years cannot exceed max_age_years")
        return self


class ActivityExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_title: str = Field(min_length=1, max_length=300)
    activity_type: Literal["visit", "session", "meal", "rest", "utility"]
    description: str | None = Field(max_length=1200)
    description_evidence: list[EvidenceSpan]
    topics: list[Literal[*INTEREST_IDS]]
    topic_evidence: list[EvidenceSpan]
    formats: list[Literal[*FORMATS]]
    format_evidence: list[EvidenceSpan]
    duration_minutes: int | None = Field(ge=1, le=1440)
    duration_evidence: list[EvidenceSpan]
    age_rules: list[AgeRule]
    occurrences: list[EventOccurrence]
    booking_required: bool | None
    booking_evidence: list[EvidenceSpan]

    @model_validator(mode="after")
    def evidence_matches_values(self) -> "ActivityExtraction":
        pairs = (
            (self.description, self.description_evidence, "description"),
            (self.duration_minutes, self.duration_evidence, "duration"),
            (self.booking_required, self.booking_evidence, "booking_required"),
        )
        for value, evidence, name in pairs:
            if (value is None) != (not evidence):
                raise ValueError(f"{name} and its evidence must be present or absent together")
        if bool(self.topics) != bool(self.topic_evidence):
            raise ValueError("topics and topic_evidence must be present or absent together")
        if bool(self.formats) != bool(self.format_evidence):
            raise ValueError("formats and format_evidence must be present or absent together")
        return self


class PlaceExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_name: str | None = Field(max_length=300)
    name_evidence: list[EvidenceSpan]
    address: str | None = Field(max_length=500)
    address_evidence: list[EvidenceSpan]
    opening_hours: list[OpeningInterval]

    @model_validator(mode="after")
    def evidence_matches_values(self) -> "PlaceExtraction":
        if (self.source_name is None) != (not self.name_evidence):
            raise ValueError("source_name and name_evidence must be present or absent together")
        if (self.address is None) != (not self.address_evidence):
            raise ValueError("address and address_evidence must be present or absent together")
        return self


class SiteExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"]
    source_url: str
    page_title: str | None
    place: PlaceExtraction
    activities: list[ActivityExtraction]
    warnings: list[str]


def validate_evidence(
    extraction: SiteExtraction,
    normalized_text: str,
    source_url: str,
    json_ld_text: str = "",
) -> None:
    """Reject hallucinated quotes and evidence that points to another page."""
    haystacks = {
        "visible_text": " ".join(normalized_text.casefold().split()),
        "json_ld": " ".join(json_ld_text.casefold().split()),
    }

    def check(spans: list[EvidenceSpan]) -> None:
        for span in spans:
            if span.source_url != source_url:
                raise ValueError("evidence source_url must equal the fetched page URL")
            quote = " ".join(span.quote.casefold().split())
            if quote not in haystacks[span.source_part]:
                raise ValueError(f"evidence quote is absent from {span.source_part}: {span.quote!r}")

    for interval in extraction.place.opening_hours:
        check(interval.evidence)
    check(extraction.place.name_evidence)
    check(extraction.place.address_evidence)
    for activity in extraction.activities:
        check(activity.description_evidence)
        check(activity.topic_evidence)
        check(activity.format_evidence)
        check(activity.duration_evidence)
        check(activity.booking_evidence)
        for rule in activity.age_rules:
            check(rule.evidence)
        for occurrence in activity.occurrences:
            check(occurrence.evidence)
