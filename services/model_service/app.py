from __future__ import annotations

from fastapi import FastAPI, HTTPException

from place_ranker import RankCandidate, rank_places
from query_match import query_match_score
from shared.contracts import RankRequest, RankResponse


app = FastAPI(title="Family Routes Model Service", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "model-service"}


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
