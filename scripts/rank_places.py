"""Rank a JSON candidate list using the transparent baseline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))

from place_ranker import RankCandidate, rank_places  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="JSON array of RankCandidate objects")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    raw = json.loads(args.input.read_text(encoding="utf-8"))
    candidates = [RankCandidate(
        activity_id=item["activity_id"],
        eligibility=item["eligibility"],
        child_interest=item["child_interest"],
        child_age_fit=item["child_age_fit"],
        adult_interest=item["adult_interest"],
        popularity=item["popularity"],
        query_match=item["query_match"],
        tags=frozenset(item.get("tags", [])),
    ) for item in raw]
    print(json.dumps([
        {
            "activity_id": item.activity_id,
            "final_relevance": item.final_relevance,
            "base_relevance": item.base_relevance,
            "diversity_penalty": item.diversity_penalty,
            "evidence_status": item.evidence_status,
            "score_components": item.score_components,
            "warnings": item.warnings,
        }
        for item in rank_places(candidates, limit=args.limit)
    ], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
