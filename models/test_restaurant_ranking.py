import unittest

from recommendation_context import confirmed_restaurant_facilities, matches_restaurant, restaurant_rank_features


def fact(value=None):
    return {"state": "unknown", "value": None, "evidence_ids": []} if value is None else {
        "state": "known", "value": value, "evidence_ids": ["source"]}


def place(**facts):
    restaurant = {key: fact(facts.get(key)) for key in (
        "high_chairs", "children_menu", "play_area", "play_area_supervision", "small_portions")}
    return {"restaurant": restaurant, "toilet": fact(facts.get("toilet"))}


class RestaurantRankingTests(unittest.TestCase):
    def test_distance_is_a_primary_signal(self):
        near = restaurant_rank_features(place(), 100, 0.5)
        far = restaurant_rank_features(place(), 1200, 0.5)
        self.assertGreater(near["combined"], far["combined"])

    def test_confirmed_child_facilities_improve_equal_distance_order(self):
        family = restaurant_rank_features(place(high_chairs=True, children_menu=True, play_area=True), 500, 0.5)
        bare = restaurant_rank_features(place(high_chairs=False, children_menu=False, play_area=False), 500, 0.5)
        unknown = restaurant_rank_features(place(), 500, 0.5)
        self.assertGreater(family["combined"], unknown["combined"])
        self.assertGreater(unknown["combined"], bare["combined"])

    def test_text_relevance_cannot_overpower_large_distance_difference(self):
        near = restaurant_rank_features(place(), 100, 0)
        far = restaurant_rank_features(place(), 1400, 1)
        self.assertGreater(near["combined"], far["combined"])

    def test_only_sourced_true_facilities_are_explained(self):
        self.assertEqual(confirmed_restaurant_facilities(place(
            high_chairs=True, children_menu=True, play_area=False)),
            ["детские стульчики", "детское меню"])

    def test_toilet_filter_uses_place_facility(self):
        self.assertTrue(matches_restaurant(place(toilet=True), {"toilet": True}))
        self.assertFalse(matches_restaurant(place(toilet=True), {"toilet": False}))


if __name__ == "__main__":
    unittest.main()
