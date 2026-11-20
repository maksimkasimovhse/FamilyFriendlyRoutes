import unittest

from age_band_policy import (
    age_band,
    age_fit_for_child,
    resolve_child_interest_weights,
    resolve_children_age_fit,
    validate_age_fit_profile,
)


class AgeBandPolicyTests(unittest.TestCase):
    def test_band_boundaries(self):
        self.assertEqual([age_band(age) for age in (3, 5, 6, 8, 9, 11)],
                         ["3-5", "3-5", "6-8", "6-8", "9-11", "9-11"])

    def test_place_profile_determines_fit(self):
        preschool = {"3-5": 1.0, "6-8": 0.5, "9-11": 0.1}
        teenward = {"3-5": 0.1, "6-8": 0.6, "9-11": 1.0}
        self.assertGreater(age_fit_for_child(4, preschool), age_fit_for_child(10, preschool))
        self.assertLess(age_fit_for_child(4, teenward), age_fit_for_child(10, teenward))
        self.assertIsNone(age_fit_for_child(7, {"3-5": 0.5, "6-8": None, "9-11": 0.8}))

    def test_profile_validation(self):
        self.assertEqual(validate_age_fit_profile({"3-5": 1, "6-8": 0.5, "9-11": None}),
                         {"3-5": 1.0, "6-8": 0.5, "9-11": None})
        with self.assertRaises(ValueError):
            validate_age_fit_profile({"3-5": 1, "6-8": 0.5})
        with self.assertRaises(ValueError):
            validate_age_fit_profile({"3-5": 1, "6-8": 0.5, "9-11": 1.1})

    def test_resolve_candidate_scores(self):
        result = resolve_children_age_fit(
            [{"child_id": "young", "age_years": 4}, {"child_id": "older", "age_years": 10}],
            {"3-5": 0.9, "6-8": 0.7, "9-11": 0.4},
        )
        self.assertEqual(result, [{"child_id": "young", "value": 0.9},
                                  {"child_id": "older", "value": 0.4}])

    def test_interest_weights_remain_equal(self):
        weights = resolve_child_interest_weights([
            {"child_id": "young", "age_years": 4},
            {"child_id": "older", "age_years": 10},
        ])
        self.assertEqual([entry["weight"] for entry in weights], [0.5, 0.5])
        self.assertEqual(resolve_child_interest_weights([{"child_id": "one", "age_years": 7}])[0]["weight"], 1)
        with self.assertRaises(ValueError):
            resolve_child_interest_weights([{"child_id": "one", "age_years": 2}])


if __name__ == "__main__":
    unittest.main()
