import copy
import json
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from prepare_published_events import parse_programme,parse_official_reader


class PublishedEventsTests(unittest.TestCase):
    def fixture(self):
        event={"@type":"Event","name":"Подземелья кремля","startDate":"2026-11-21T08:30:00Z","endDate":"2026-11-21T09:30:00Z",
               "location":{"name":"Нижегородский кремль","address":{"streetAddress":"Нижний Новгород, Кремль, 6А"}},
               "offers":{"availability":"https://schema.org/SoldOut"}}
        page={"text":"Место сбора — Дмитриевская башня.\nДлительность\n1 час","source_url":"https://example.org/event","final_url":"https://example.org/event","content_sha256":"test","json_ld":[event]}
        return {"page":page,"fetched_at":"2026-11-20T00:00:00Z"},datetime(2026,11,20,tzinfo=ZoneInfo("Europe/Moscow"))

    def test_dates_are_normalized_to_moscow_and_sold_out_is_not_ready(self):
        snapshot,now=self.fixture();programmes,slots,_=parse_programme(snapshot,[],now)
        self.assertEqual(slots[0]["start_at"],"2026-11-21T11:30:00+03:00")
        self.assertEqual(slots[0]["duration_minutes"],60)
        self.assertEqual(slots[0]["booking_status"],"unknown")
        self.assertEqual(slots[0]["source_booking_status"],"sold_out")
        self.assertFalse(slots[0]["planner_ready"])

    def test_parent_and_sub_event_are_not_double_counted(self):
        snapshot,now=self.fixture();child=copy.deepcopy(snapshot["page"]["json_ld"][0])
        snapshot["page"]["json_ld"][0]["subEvent"]=[child]
        programmes,slots,_=parse_programme(snapshot,[],now)
        self.assertEqual(len(programmes),1);self.assertEqual(len(slots),1)

    def test_unknown_end_and_duration_stay_unknown(self):
        snapshot,now=self.fixture();snapshot["page"]["text"]="Место сбора — Дмитриевская башня."
        del snapshot["page"]["json_ld"][0]["endDate"]
        _,slots,_=parse_programme(snapshot,[],now)
        self.assertIsNone(slots[0]["end_at"]);self.assertIsNone(slots[0]["duration_minutes"])
        self.assertFalse(slots[0]["planner_ready"])

    def test_explicit_duration_can_derive_end_but_conflict_is_not_hidden(self):
        snapshot,now=self.fixture();del snapshot["page"]["json_ld"][0]["endDate"]
        _,slots,_=parse_programme(snapshot,[],now)
        self.assertEqual(slots[0]["end_origin"],"derived_from_published_duration")
        snapshot["page"]["json_ld"][0]["endDate"]="2026-11-21T10:00:00Z"
        _,slots,_=parse_programme(snapshot,[],now)
        self.assertTrue(slots[0]["duration_conflict"]);self.assertFalse(slots[0]["planner_ready"])

    def test_self_guided_entry_is_not_a_fixed_session(self):
        snapshot,now=self.fixture();snapshot["page"]["json_ld"][0]["name"]="Экспозиция (самостоятельный осмотр)"
        _,slots,_=parse_programme(snapshot,[],now)
        self.assertEqual(slots[0]["occurrence_kind"],"entry_ticket");self.assertFalse(slots[0]["planner_ready"])

    def test_official_period_supplies_year_but_never_daily_sessions(self):
        saved={"text":"# Детская программа\n12 декабря 2026 — 26 декабря 2026\nДлительность: 60 минут\nВозрастные ограничения: 6+\n12 декабря в 11:00 и 13:00\n26 декабря в 11:00 и 13:00", "url":"https://example.org/programme","place_id":"place:test","venue":"Музей","observed_at_utc":"2026-11-20 00:00:00 UTC"}
        _,slots=parse_official_reader(saved,datetime(2026,11,20,tzinfo=ZoneInfo("Europe/Moscow")))
        self.assertEqual(len(slots),4)
        self.assertEqual({s["start_at"][:10] for s in slots},{"2026-12-12","2026-12-26"})

    def test_dataset_links_and_ready_intervals(self):
        root=Path(__file__).resolve().parents[1]/"outputs/all_places_v2"
        places={p["place_id"] for p in (json.loads(l) for l in (root/"places.jsonl").read_text().splitlines())}
        self.assertGreater(len(places),1258)
        rows=[json.loads(l) for l in (root/"occurrences.jsonl").read_text().splitlines()]
        self.assertGreater(len(rows),30)
        self.assertEqual(len({r["occurrence_id"] for r in rows}),len(rows))
        for row in rows:
            self.assertTrue(all(pid in places for pid in row["place_ids"]))
            if row["planner_ready"]:
                self.assertEqual(len(row["place_ids"]),1)
                self.assertFalse(row.get("duration_conflict",False))
                self.assertNotEqual(row.get("source_booking_status"),"sold_out")
                self.assertEqual((datetime.fromisoformat(row["end_at"])-datetime.fromisoformat(row["start_at"])).total_seconds(),row["duration_minutes"]*60)


if __name__=="__main__":unittest.main()
