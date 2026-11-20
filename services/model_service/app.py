from __future__ import annotations

import hmac
import os
import uuid
import httpx
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler

from place_ranker import RankCandidate, rank_places
from query_match import query_match_score
from request_schema import ParsedRequest, validate_evidence
from shared.contracts import RankRequest, RankResponse
from recommendation_engine import CATALOG_RELATIVE_PATH, CATALOG_VERSION, MODEL_VERSION, RecommendationEngine, RecommendationError


app = FastAPI(title="Family Routes Model Service", version="1.0.0")
ROOT = Path(__file__).resolve().parents[2]


def api_error(status: int, code: str, message: str, request_id: str | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {
        "code": code, "message": message, "request_id": request_id or str(uuid.uuid4()),
        "retryable": status >= 500, "current_version": None, "details": [],
    }})


@app.exception_handler(RequestValidationError)
async def invalid_recommendation_body(request: Request, error: RequestValidationError):
    if request.url.path == "/internal/v1/recommendations":
        return api_error(422, "INVALID_REQUEST", "Неверное тело запроса рекомендаций.")
    return await request_validation_exception_handler(request, error)


@lru_cache(maxsize=1)
def recommendation_engine() -> RecommendationEngine:
    return RecommendationEngine(
        Path(os.environ.get("MODEL_CATALOG_PATH", ROOT / CATALOG_RELATIVE_PATH)),
        ROOT / "docs/contracts/openapi.json", ROOT / "models/recommendation_policy.json",
        os.environ.get("MODEL_CATALOG_VERSION", CATALOG_VERSION),
    )


@app.middleware("http")
async def service_auth(request: Request, call_next):
    token = os.environ.get("ML_API_TOKEN", "")
    legacy = request.url.path == "/internal/v1/rankings"
    requires_auth = not legacy or os.environ.get("ML_REQUIRE_LEGACY_AUTH", "false").lower() == "true"
    if request.url.path != "/health" and requires_auth and token and not hmac.compare_digest(
        request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()
    ):
        return api_error(401, "SERVICE_AUTH_REQUIRED", "Требуется сервисный токен.")
    return await call_next(request)


@app.get("/health")
def health() -> dict:
    try:
        engine = recommendation_engine()
    except Exception:
        raise HTTPException(status_code=503, detail="Catalog is unavailable or invalid") from None
    return {"status": "ok", "service": "model-service", "model_version": MODEL_VERSION,
            "catalog_version": engine.catalog_version, "catalog_sha256": engine.content_sha256,
            "catalog_records": len(engine.records)}


@app.post("/internal/v1/recommendations")
def recommendations(request: dict) -> dict:
    try:
        engine = recommendation_engine()
    except Exception:
        return api_error(503, "CATALOG_UNAVAILABLE", "Каталог недоступен или некорректен.")
    try:
        parsed = None
        parser_url = os.environ.get("REQUEST_PARSER_URL", "")
        text = request.get("request_text")
        if request.get("parsed_request") is not None:
            try:
                if text is not None and not isinstance(text, str):
                    raise ValueError("request_text must be a string")
                parsed = ParsedRequest.model_validate(request["parsed_request"])
                validate_evidence(parsed, text or "")
            except ValueError:
                return api_error(422, "INVALID_REQUEST", "Некорректное понимание пожеланий.")
        elif parser_url and isinstance(text, str) and text.strip():
            token = os.environ.get("ML_API_TOKEN", "")
            headers = {"Authorization": "Bearer " + token} if token else {}
            try:
                request_id = str(uuid.uuid4())
                with httpx.Client(timeout=28, follow_redirects=False) as client:
                    response = client.post(parser_url, headers=headers, json={
                        "contract_version": "1.0", "request_id": request_id, "text": text})
                response.raise_for_status()
                value = response.json()
                if value.get("contract_version") != "1.0" or value.get("request_id") != request_id:
                    raise ValueError("parser envelope mismatch")
                parsed = ParsedRequest.model_validate(value["parsed_request"])
                validate_evidence(parsed, text)
            except (httpx.HTTPError, ValueError, KeyError):
                return api_error(503, "REQUEST_PARSER_UNAVAILABLE", "Не удалось разобрать пожелание; повторите запрос.")
        return engine.recommend(request, parsed_request=parsed)
    except RecommendationError as error:
        request_id = request.get("request_id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            request_id = None
        return api_error(error.status, error.code, str(error), request_id)


@app.post("/internal/v1/rankings", response_model=RankResponse)
def ranking(request: RankRequest) -> dict[str, object]:
    try:
        parsed = request.parsed_request
        candidates = [RankCandidate(
            activity_id=item.activity_id,
            eligibility=item.eligibility,
            child_interest=item.child_interest,
            child_age_fit=item.child_age_fit,
            adult_interest=item.adult_interest,
            popularity=item.popularity,
            query_match=query_match_score(parsed, frozenset(item.tags)),
            tags=frozenset(item.tags),
        ) for item in request.candidates]
        ranked = rank_places(candidates, limit=request.limit)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "contract_version": "1.0",
        "request_id": request.request_id,
        "model_version": "transparent-baseline-v1",
        "ranked": [{
            "activity_id": item.activity_id,
            "final_relevance": item.final_relevance,
            "base_relevance": item.base_relevance,
            "diversity_penalty": item.diversity_penalty,
            "evidence_status": item.evidence_status,
            "score_components": item.score_components,
            "warnings": list(item.warnings),
        } for item in ranked],
    }
