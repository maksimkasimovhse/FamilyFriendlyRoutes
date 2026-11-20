from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from request_schema import ParsedRequest


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ParseTextRequest(StrictModel):
    contract_version: Literal["1.0"]
    request_id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=4000)


class CatalogExtractionRequest(StrictModel):
    contract_version: Literal["1.0"]
    request_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    url: str = Field(min_length=1)


class RankCandidateInput(StrictModel):
    activity_id: str = Field(min_length=1)
    eligibility: dict[str, Literal["eligible", "ineligible", "unknown"]]
    child_interest: dict[str, float]
    child_age_fit: dict[str, float | None]
    adult_interest: float
    popularity: float = Field(ge=0, le=1)
    tags: list[str]


class RankRequest(StrictModel):
    contract_version: Literal["1.0"]
    request_id: str = Field(min_length=1)
    parsed_request: ParsedRequest | None
    candidates: list[RankCandidateInput]
    limit: int = Field(default=10, ge=0, le=100)


class ParserMetadata(StrictModel):
    provider: Literal["gigachat"]
    model: str
    usage: dict[str, object]


class ParseTextResponse(StrictModel):
    contract_version: Literal["1.0"]
    request_id: str
    parser: ParserMetadata
    parsed_request: ParsedRequest


class RankedItem(StrictModel):
    activity_id: str
    final_relevance: float = Field(ge=0, le=1)
    base_relevance: float = Field(ge=0, le=1)
    diversity_penalty: float = Field(ge=0, le=1)
    evidence_status: Literal["complete", "critical_unknown"]
    score_components: dict[str, float | None]
    warnings: list[str]


class RankResponse(StrictModel):
    contract_version: Literal["1.0"]
    request_id: str
    model_version: str
    ranked: list[RankedItem]
