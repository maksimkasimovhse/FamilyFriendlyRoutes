import copy
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from assistant_rules import parse_rules
from assistant_schema import parse_assistant
from recommendation_context import matches_purpose
from services.parser_service.app import app
from test_assistant import CONTEXT, FakeClient, intent


class JourneyFixTests(unittest.TestCase):
    def test_unnamed_child_is_not_guessed_and_explicit_age_is_retained(self):
        context = copy.deepcopy(CONTEXT)
        context['family']['children'] = [{'child_id': 'child-1', 'age_years': 5}, {'child_id': 'child-2', 'age_years': 9}]
        result, _ = parse_assistant('Ребёнок устал', context, FakeClient(intent()))
        self.assertIsNone(result.needs[0].child_id)
        value = intent()
        value['needs'][0]['evidence'] = '5 лет, устал'
        result, _ = parse_assistant('Ребёнку 5 лет, устал', context, FakeClient(value))
        self.assertEqual(result.needs[0].child_id, 'child-1')
        context['family']['children'][1]['age_years'] = 5
        result, _ = parse_assistant('Ребёнку 5 лет, устал', context, FakeClient(value))
        self.assertIsNone(result.needs[0].child_id)

    def test_confirmed_indoor_restaurant_can_be_a_rain_shelter(self):
        row = {'place': {'category': 'restaurant'}, 'activity': {'kind': 'meal'}}
        place = {'indoor': {'state': 'known', 'value': True}, 'shelter': {'state': 'unknown', 'value': None}}
        self.assertTrue(matches_purpose(row, place, 'rain'))
        place['indoor'] = {'state': 'unknown', 'value': None}
        self.assertFalse(matches_purpose(row, place, 'rain'))

    def test_rules_fallback_preserves_explicit_limits_and_rejects_unknown_conditions(self):
        context = {**copy.deepcopy(CONTEXT), 'initial': True}
        result, _ = parse_rules('Хотим пройти не больше 500 метров', context)
        self.assertEqual(result.action, 'preferences')
        self.assertEqual(result.max_walk_distance_m, 500)
        result, _ = parse_rules('Частые перерывы', context)
        self.assertIsNone(result.duration_sec)
        self.assertEqual(result.needs[0].kind, 'rest')
        result, _ = parse_rules('Нужна безглютеновая еда', context)
        self.assertEqual(result.action, 'clarify')

    def test_offline_needs_and_followup_still_produce_only_intents(self):
        for message, action in [('Ребёнок устал', 'shorten_day'), ('Хотим поесть по пути', 'find_places'), ('Пошёл дождь', 'find_places'), ('Убери следующую точку', 'remove_stop'), ('Добавь первый вариант', 'add_activity')]:
            with self.subTest(message=message):
                result, _ = parse_rules(message, CONTEXT)
                self.assertEqual(result.action, action)

    def test_unavailable_llm_is_explicitly_reported_as_rules(self):
        with patch.dict('os.environ', {'ML_API_TOKEN': '', 'ASSISTANT_RULES_FALLBACK': 'true'}), TestClient(app) as client, patch('services.parser_service.app.online_client', side_effect=ValueError('missing')):
            response = client.post('/internal/v1/assistant-intents', json={'contract_version': '1.0', 'request_id': 'fallback', 'message': 'Ребёнок устал', 'context': CONTEXT})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['parser']['provider'], 'rules')
            self.assertFalse(response.json()['route_changed'])

    def test_invalid_structured_llm_response_uses_rules_instead_of_502(self):
        body = {'contract_version': '1.0', 'request_id': 'invalid-llm', 'message': 'Ребёнок устал', 'context': CONTEXT}
        with patch.dict('os.environ', {'ML_API_TOKEN': '', 'ASSISTANT_RULES_FALLBACK': 'true'}), TestClient(app) as client, patch('services.parser_service.app.online_client', return_value=object()), patch('services.parser_service.app.parse_assistant', side_effect=ValueError('invalid schema')):
            response = client.post('/internal/v1/assistant-intents', json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['parser']['provider'], 'rules')
        self.assertEqual(response.json()['intent']['action'], 'shorten_day')


if __name__ == '__main__':
    unittest.main()
