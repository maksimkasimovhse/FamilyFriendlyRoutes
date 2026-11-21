import csv
import io
import json
import unittest
from pathlib import Path

from discover_tourism_descriptions import match_cards, parse_cards
from recover_osm_descriptions import candidates_from_page
from restore_osm_descriptions import normalize_url
from export_all_places import csv_value


class DescriptionRecoveryTests(unittest.TestCase):
    def test_directory_extracts_card_text_and_preserves_coordinate_order(self):
        html = b'<div class="items__item"><a class="items__item-name" href="museum/">Museum</a><div class="items__item-descr"><p>A <b>real</b> description.</p></div><span data-coords="[56.3,44.0]"></span></div><a href="?page=2">\xd0\x9f\xd0\xbe\xd0\xba\xd0\xb0\xd0\xb7\xd0\xb0\xd1\x82\xd1\x8c \xd0\xb5\xd1\x89\xd0\xb5</a>'
        cards, next_url = parse_cards(html, 'https://nn-grad.ru/kuda-poyti/', '2026-11-21', 'hash')
        self.assertEqual(cards[0]['description'], 'A real description.')
        self.assertEqual(cards[0]['coordinates_lat_lon'], [56.3, 44.0])
        self.assertEqual(next_url, 'https://nn-grad.ru/kuda-poyti/?page=2')

    def test_same_name_far_away_never_gets_a_description(self):
        original = {'place': {'name':'Музей науки', 'place_id':'osm:1', 'location':{'longitude':44.0,'latitude':56.3}}, 'provenance':{'raw_tags':{'name':'Музей науки'}}}
        card = {'name':'Музей науки', 'coordinates_lat_lon':[56.7,44.0]}
        self.assertEqual(match_cards([card], [original]), [])
        card['coordinates_lat_lon'] = [56.3,44.0]
        self.assertEqual(match_cards([card], [original])[0]['status'], 'exact_name_nearby')

    def test_review_and_marketing_are_not_a_place_description(self):
        page = {'text':'Спасибо ресторану за чудесный вечер, очень уютное место и замечательная кухня, обязательно приедем еще!\nПользователи становятся гостями: интернет-маркетинг для ресторанов, кафе, баров.'}
        self.assertEqual(candidates_from_page(page, ['Ресторан']), [])

    def test_only_a_quote_present_in_page_can_be_used(self):
        page = {'text':'Короткое меню.'}
        fake = {'activities':[{'description_evidence':[{'quote':'Музей истории предлагает экспозицию о событиях прошлого и предметы быта на постоянной выставке.', 'source_part':'visible_text'}]}]}
        self.assertEqual(candidates_from_page(page, ['Музей'], fake), [])

    def test_source_url_normalization_keeps_idn_and_rejects_social_login(self):
        self.assertEqual(normalize_url('империягрез.рф'), 'https://xn--c1adbibb0aykc7n.xn--p1ai/')
        self.assertIsNone(normalize_url('https://instagram.com/one'))
        self.assertIsNone(normalize_url('https://user:pass@example.com/'))

    def test_csv_literal_text_cannot_turn_into_a_formula(self):
        self.assertEqual(csv_value('=HYPERLINK("bad")'), '\'=HYPERLINK("bad")')
        self.assertEqual(csv_value(44.0), 44.0)
        self.assertEqual(json.loads(csv_value(['слово', 'два'])), ['слово', 'два'])

    def test_export_covers_every_input_and_preserves_mvp_membership(self):
        root = Path(__file__).resolve().parents[1]
        directory = root / 'outputs/all_places_v1'
        records = [json.loads(line) for line in (directory / 'places.jsonl').read_text().splitlines()]
        self.assertEqual(len(records), 1258)
        self.assertEqual(len({r['place_id'] for r in records}), len(records))
        self.assertEqual(sum(r['in_mvp'] for r in records), 281)
        with (directory / 'source_mapping.csv').open(encoding='utf-8-sig', newline='') as handle:
            mapping = list(csv.DictReader(handle))
        ids = {r['place_id'] for r in records}
        self.assertTrue(all(r['place_id'] in ids for r in mapping))
        self.assertEqual(sum(r['relation']=='primary' for r in mapping), 1258)
        self.assertEqual(sum(r['relation']=='merged_alias' for r in mapping), 1)
        self.assertEqual(sum(r['relation']=='identical_import' for r in mapping), 259)
        # Multiline descriptions must remain one logical CSV record each.
        with (directory / 'places.csv').open(encoding='utf-8-sig', newline='') as handle:
            csv_records = list(csv.DictReader(handle))
        self.assertEqual(len(csv_records), len(records))
        self.assertEqual({r['place_id'] for r in csv_records}, ids)


if __name__ == '__main__':
    unittest.main()
