"""Deterministically match parsed request claims against catalog tags."""

from __future__ import annotations

from request_schema import ParsedRequest


def claim_tag(kind: str, value: str) -> str:
    return f"{kind}:{value}"


def query_match_score(parsed: ParsedRequest | None, candidate_tags: frozenset[str]) -> float:
    """Return [0,1]; the LLM extracts claims but never assigns this score."""
    if parsed is None or not parsed.claims:
        return 0.5
    preferred = {claim_tag(claim.kind, claim.value) for claim in parsed.claims if claim.polarity == "prefer"}
    avoided = {claim_tag(claim.kind, claim.value) for claim in parsed.claims if claim.polarity == "avoid"}
    positive_coverage = len(preferred & candidate_tags) / len(preferred) if preferred else 1.0
    avoidance = 1 - (len(avoided & candidate_tags) / len(avoided) if avoided else 0.0)
    return positive_coverage * avoidance
