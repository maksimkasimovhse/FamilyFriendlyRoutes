"""Bounded, provider-neutral input for ML intent extraction; no backend mutations."""
from __future__ import annotations

from datetime import date, datetime
from math import isfinite

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ACTION_NAMES = ("clarify", "preferences", "find_places", "remove_stop", "shorten_day",
                "replan_day", "return_to_hotel", "add_activity", "replace_stop", "move_stop", "reorder_stops")


class ContextPart(BaseModel):
    # A backend may add fields; only documented context is forwarded to the LLM.
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)


class ChildContext(ContextPart):
    child_id: str = Field(min_length=1, max_length=100)
    age_years: int | None = Field(default=None, ge=3, le=11)
    interest_ids: list[str] = Field(default_factory=list, max_length=20)


class FamilyContext(ContextPart):
    children: list[ChildContext] = Field(default_factory=list, max_length=2)
    adult_count: int | None = Field(default=None, ge=1, le=10)
    adult_interest_ids: list[str] = Field(default_factory=list, max_length=20)


class StopContext(ContextPart):
    stop_id: str = Field(min_length=1, max_length=200)
    title: str = Field(default="", max_length=500)
    progress: str = Field(default="planned", pattern="^(planned|visited|skipped)$")
    mandatory: bool = False
    category: str | None = Field(default=None, max_length=100)
    activity_id: str | None = Field(default=None, max_length=200)


class PointContext(ContextPart):
    label: str | None = Field(default=None, max_length=500)
    coordinates: tuple[float, float] | None = None

    @field_validator("coordinates")
    @classmethod
    def coordinates_are_valid(cls, value):
        if value is not None and (not all(isfinite(v) for v in value) or not -180 <= value[0] <= 180 or not -90 <= value[1] <= 90):
            raise ValueError("invalid coordinates")
        return value


class WindowContext(ContextPart):
    start_at: datetime
    end_at: datetime

    @model_validator(mode="after")
    def ordered(self):
        if self.start_at.utcoffset() is None or self.end_at.utcoffset() is None or self.end_at <= self.start_at:
            raise ValueError("window requires timezone offsets and an ordered interval")
        return self


class DayContext(ContextPart):
    date: date
    stops: list[StopContext] = Field(default_factory=list, max_length=50)
    end_point: PointContext | None = None
    duration_budget_sec: float | None = Field(default=None, ge=0, le=86400)
    available_window: WindowContext | None = None


class ChoiceContext(ContextPart):
    place_id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=500)
    number: int | None = Field(default=None, ge=1, le=3)
    activity_id: str | None = Field(default=None, max_length=200)


class TurnContext(ContextPart):
    message: str = Field(min_length=1, max_length=4000)
    reply: str = Field(default="", max_length=2000)


class AssistantContext(ContextPart):
    initial: bool = False
    selected_date: date | None = None
    observed_at: datetime | None = None
    family: FamilyContext = Field(default_factory=FamilyContext)
    days: list[DayContext] = Field(default_factory=list, max_length=14)
    choices: list[ChoiceContext] = Field(default_factory=list, max_length=3)
    history: list[TurnContext] = Field(default_factory=list, max_length=6)
    pending_stop_id: str | None = Field(default=None, max_length=200)
    available_actions: list[str] | None = Field(default=None, max_length=len(ACTION_NAMES))

    @field_validator("history", "choices", "days", mode="before")
    @classmethod
    def null_lists_are_empty(cls, value):
        return [] if value is None else value

    @model_validator(mode="after")
    def references_are_consistent(self):
        dates = [d.date for d in self.days]
        stops = [s.stop_id for d in self.days for s in d.stops]
        children = [c.child_id for c in self.family.children]
        places = [p.place_id for p in self.choices]
        for values in (dates, stops, children, places):
            if len(values) != len(set(values)):
                raise ValueError("duplicate context IDs or dates")
        if self.selected_date is not None and self.selected_date not in dates:
            raise ValueError("selected_date is absent from days")
        if self.observed_at is not None and self.observed_at.utcoffset() is None:
            raise ValueError("observed_at requires a timezone offset")
        if self.pending_stop_id is not None and self.pending_stop_id not in {s.stop_id for d in self.days for s in d.stops if s.progress == "planned"}:
            raise ValueError("pending stop is not planned")
        if self.available_actions is not None and (len(self.available_actions) != len(set(self.available_actions)) or set(self.available_actions) - set(ACTION_NAMES)):
            raise ValueError("unknown or duplicate available actions")
        return self


def normalize_context(value: dict) -> dict:
    return AssistantContext.model_validate(value).model_dump(mode="json", exclude_none=True)
