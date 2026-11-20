import unittest

from place_ranker import RankCandidate, RankingPolicy, rank_places


def candidate(
    activity_id: str,
    *,
    eligibility: str = "eligible",
    age_fit: float | None = 0.8,
    interest: float = 1.0,
    query: float = 0.5,
    popularity: float = 0.5,
    tags: tuple[str, ...] = (),
) -> RankCandidate:
    return RankCandidate(
        activity_id=activity_id,
        eligibility={"child": eligibility},
        child_interest={"child": interest},
        child_age_fit={"child": age_fit},
        adult_interest=interest,
        popularity=popularity,
        query_match=query,
        tags=frozenset(tags),
    )


class PlaceRankerTests(unittest.TestCase):
    def test_mmr_prefix_is_stable_when_input_order_or_limit_changes(self):
        pool = [candidate(str(i), query=(i % 11) / 10, tags=(f"theme-{i % 5}",)) for i in range(80)]
        first = rank_places(pool, limit=12)
        full = rank_places(list(reversed(pool)), limit=80)
        self.assertEqual(first, full[:12])

    def test_known_ineligible_is_removed_even_with_high_scores(self):
        blocked = candidate("blocked", eligibility="ineligible", interest=100, query=1, popularity=1)
        allowed = candidate("allowed", interest=0, query=0, popularity=0)
        self.assertEqual([item.activity_id for item in rank_places([blocked, allowed])], ["allowed"])

    def test_age_fit_is_place_specific(self):
        suited = candidate("suited", age_fit=0.9)
        poor = candidate("poor", age_fit=0.1)
        self.assertEqual(rank_places([poor, suited])[0].activity_id, "suited")

    def test_unknown_critical_data_is_not_treated_as_complete(self):
        unknown = candidate("unknown", eligibility="unknown", age_fit=None, interest=20, query=1)
        known = candidate("known", age_fit=0.7, interest=1, query=0.5)
        ranked = rank_places([unknown, known])
        item = next(value for value in ranked if value.activity_id == "unknown")
        self.assertEqual(item.evidence_status, "critical_unknown")
        self.assertIn("AGE_OR_ELIGIBILITY_UNKNOWN", item.warnings)
        self.assertLess(item.final_relevance, item.base_relevance)

    def test_query_match_changes_order(self):
        policy = RankingPolicy(age_fit_weight=0, child_interest_weight=0, adult_interest_weight=0,
                               query_match_weight=1, popularity_weight=0)
        self.assertEqual(rank_places([candidate("low", query=0.1), candidate("high", query=0.9)], policy=policy)[0].activity_id,
                         "high")

    def test_mmr_can_choose_a_different_second_theme(self):
        policy = RankingPolicy(age_fit_weight=0, child_interest_weight=0, adult_interest_weight=0,
                               query_match_weight=1, popularity_weight=0, mmr_lambda=0.5)
        ranked = rank_places([
            candidate("museum-best", query=1.0, tags=("museum", "history")),
            candidate("museum-copy", query=0.95, tags=("museum", "history")),
            candidate("park", query=0.8, tags=("park", "nature")),
        ], policy=policy)
        self.assertEqual([item.activity_id for item in ranked[:2]], ["museum-best", "park"])


if __name__ == "__main__":
    unittest.main()
