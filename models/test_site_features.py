import unittest
from site_features import validate_claims
from site_feature_rules import make_claim, simple_hours


class FullFeatureTests(unittest.TestCase):
    def check(self,claim,text):
        return validate_claims({"claims":[claim],"warnings":[]},{"text":text,"json_ld":[]})

    def test_zero_plus_is_not_hard_admission_or_age_fit(self):
        claim=make_claim("hard_age_min",0,"Программа 0+",subject="Сказка",scope="event")
        accepted,rejected,_=self.check(claim,"Программа 0+")
        self.assertFalse(accepted);self.assertEqual(rejected[0]["reason"],"content_label_is_not_admission_rule")

    def test_label_is_preserved_instead_of_claimed_recommendation(self):
        claim=make_claim("recommended_age_min",6,"Концерт 6+",subject="Концерт",scope="event")
        accepted,_,_=self.check(claim,"Концерт 6+")
        self.assertEqual(accepted[0]["property"],"content_label_min")

    def test_no_mention_does_not_mean_no_childrens_menu(self):
        claim=make_claim("children_menu",False,"Основное меню ресторана",subject="Ресторан")
        accepted,rejected,_=self.check(claim,"Основное меню ресторана")
        self.assertFalse(accepted);self.assertTrue(rejected)

    def test_group_size_is_not_child_age(self):
        claim=make_claim("play_room_age_max",5,"В группе до 5 человек",subject="Экскурсия")
        accepted,rejected,_=self.check(claim,"В группе до 5 человек")
        self.assertFalse(accepted);self.assertEqual(rejected[0]["reason"],"age_unit_not_supported")

    def test_unrelated_false_slot_is_discarded_without_creating_a_fact(self):
        claim=make_claim("address","Нижний Новгород, улица Ленина, 1","Адрес: Нижний Новгород, улица Ленина, 1",subject="Место")
        claim["value_boolean"]=False
        accepted,_,_=self.check(claim,claim["quote"])
        self.assertEqual(accepted[0]["value_text"],claim["value_text"])
        self.assertIsNone(accepted[0]["value_boolean"])

    def test_traffic_notice_is_not_a_concert_end(self):
        quote="Перекрытие движения транспорта 3 и 4 октября 2026 года"
        claim=make_claim("event_end_text","4 октября 2026 года",quote,subject="Пакгаузы",scope="event")
        accepted,_,_=self.check(claim,quote)
        self.assertEqual(accepted[0]["property"],"access_exception_text")
        self.assertEqual(accepted[0]["scope"],"place")

    def test_russian_staff_hours_do_not_become_restaurant_hours(self):
        intervals=simple_hours("За детьми присматривает бэби-ситтер ЧТ - ВС с 14 до 22.")
        self.assertEqual({r["day_of_week"] for r in intervals},{"thursday","friday","saturday","sunday"})
        self.assertTrue(all(r["opens"]=="14:00" and r["closes"]=="22:00" for r in intervals))

    def test_late_closing_keeps_next_day_offset(self):
        intervals=simple_hours("Пт-Сб 12:00-02:00")
        self.assertEqual(len(intervals),2)
        self.assertTrue(all(r["end_day_offset"]==1 for r in intervals))

    def test_no_weekdays_does_not_invent_a_seven_day_human_schedule(self):
        self.assertEqual(simple_hours("10:00-20:00"),[])
        self.assertEqual(len(simple_hours("10:00-20:00",osm=True)),7)

    def test_explicit_round_the_clock_is_supported(self):
        self.assertEqual(len(simple_hours("24/7")),7)


if __name__=="__main__":unittest.main()
