import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from assistant_schema import parse_assistant, strict_intent_schema
from services.parser_service.app import app


def intent(action="shorten_day"):
    return dict(action=action, date="2030-06-15", target_date=None, stop_id=None, place_id=None,
                stop_ids=[], duration_sec=None, duration_evidence=None, question=None,
                needs=[dict(kind="rest", child_id="child-1", urgency="now", evidence="Ребёнок устал")],
                preferences=dict(taxonomy_version="1.0", claims=[], needs_clarification=False,
                                 clarification_question=None, unsupported_requests=[]))


CONTEXT = dict(days=[dict(date="2030-06-15", end_point=dict(coordinates=[44.01, 56.326]), stops=[dict(stop_id="stop-1", progress="planned"),
                     dict(stop_id="old-stop", progress="visited")])],
               family=dict(children=[dict(child_id="child-1")]), history=[],
               choices=[dict(place_id="cafe-1")])


class FakeClient:
    def __init__(self, value): self.value = value
    def extract(self, **kwargs):
        return SimpleNamespace(value=self.value, model="fake-gigachat", usage={})


class AssistantTests(unittest.TestCase):
    def test_needs_and_explicit_interval(self):
        value = intent("return_to_hotel")
        value.update(duration_sec=3600, duration_evidence="Через час")
        result, _ = parse_assistant("Ребёнок устал. Через час нужно быть в отеле", CONTEXT, FakeClient(value))
        self.assertEqual(result.duration_sec, 3600)
        self.assertEqual(result.needs[0].child_id, "child-1")
        value["duration_sec"] = 600
        with self.assertRaises(ValueError):
            parse_assistant("Ребёнок устал. Через час нужно быть в отеле", CONTEXT, FakeClient(value))

    def test_rejects_invented_id_historical_stop_and_evidence(self):
        for key, value in [("place_id", "invented"), ("stop_id", "old-stop"), ("date", "2030-06-18")]:
            data = intent(); data[key] = value
            if key == "place_id": data["action"] = "add_activity"
            if key == "stop_id": data["action"] = "remove_stop"
            with self.subTest(key=key), self.assertRaises(ValueError):
                parse_assistant("Ребёнок устал", CONTEXT, FakeClient(data))
        data = intent(); data["needs"][0]["evidence"] = "выдумка"
        with self.assertRaises(ValueError):
            parse_assistant("Ребёнок устал", CONTEXT, FakeClient(data))

    def test_return_cannot_use_a_generated_hotel_identifier(self):
        data = intent("return_to_hotel")
        data["place_id"] = "invented-hotel"
        data["stop_id"] = "invented-hotel-stop"
        parsed, _ = parse_assistant("Ребёнок устал", CONTEXT, FakeClient(data))
        self.assertIsNone(parsed.place_id)
        self.assertIsNone(parsed.stop_id)

    def test_absolute_deadline_and_walking_units(self):
        data = intent("return_to_hotel")
        data.update(duration_sec=60, duration_evidence="к 11:00")
        context = copy.deepcopy(CONTEXT)
        context.update(observed_at="2030-06-15T07:00:00Z", selected_date="2030-06-15")
        parsed, _ = parse_assistant("Ребёнок устал, вернёмся к 11:00", context, FakeClient(data))
        self.assertEqual(parsed.duration_sec, 3600)
        data = intent("preferences")
        data.update(max_walk_distance_m=500, walk_evidence="не больше 0,5 км", needs=[])
        parsed, _ = parse_assistant("Пройдём не больше 0,5 км", context, FakeClient(data))
        self.assertEqual(parsed.action, "shorten_day")
        self.assertEqual(parsed.max_walk_distance_m, 500)

    def test_followup_uses_history_and_known_choices(self):
        context = copy.deepcopy(CONTEXT)
        context["history"] = [dict(message="Ребёнок устал", reply="Вот варианты")]
        data = intent("add_activity"); data["place_id"] = "cafe-1"
        result, _ = parse_assistant("Давай первый", context, FakeClient(data))
        self.assertEqual(result.place_id, "cafe-1")

    def test_simple_kremlin_request_never_requires_visit_format(self):
        data = intent("clarify")
        data.update(question="Что именно вы хотите увидеть в кремле?", needs=[])
        data["preferences"].update(needs_clarification=True, clarification_question=data["question"])
        result, _ = parse_assistant("Хочу посмотреть кремль", CONTEXT, FakeClient(data))
        self.assertEqual(result.action, "find_places")
        self.assertIsNone(result.question)
        self.assertFalse(result.preferences.needs_clarification)
        self.assertEqual([claim.value for claim in result.preferences.claims], ["landmark", "history", "architecture"])

        # Adding a named landmark must first find real catalog cards.  It must
        # not ask the user to define a visit format or choose a made-up venue.
        data = intent("clarify")
        data.update(question="Какой кремль вы хотите добавить в маршрут?", needs=[])
        data["preferences"].update(needs_clarification=True, clarification_question=data["question"])
        result, _ = parse_assistant("Добавь Кремль в маршрут", CONTEXT, FakeClient(data))
        self.assertEqual(result.action, "find_places")
        self.assertIsNone(result.question)
        self.assertFalse(result.preferences.needs_clarification)

        data = intent("find_places")
        data["needs"] = [dict(kind="shelter", child_id=None, urgency="now", evidence="Хочу посмотреть кремль")]
        result, _ = parse_assistant("Хочу посмотреть кремль", CONTEXT, FakeClient(data))
        self.assertEqual(result.needs, [])

    def test_closed_schema_and_unsupported_action(self):
        schema = strict_intent_schema()
        self.assertFalse(schema["additionalProperties"])
        self.assertTrue(all(v.get("additionalProperties") is False for v in schema["$defs"].values() if v.get("type") == "object"))
        contextual = strict_intent_schema(CONTEXT)
        self.assertEqual(contextual["properties"]["date"]["anyOf"][0]["enum"], ["2030-06-15"])
        self.assertEqual(contextual["properties"]["place_id"]["anyOf"][0]["enum"], ["cafe-1"])
        data = intent("delete_trip")
        with self.assertRaises(ValueError):
            parse_assistant("Ребёнок устал", CONTEXT, FakeClient(data))

    def test_parser_endpoint_auth_and_no_secret_error(self):
        with patch.dict("os.environ", {"ML_API_TOKEN": "service-secret"}), TestClient(app) as client:
            body = dict(contract_version="1.0", request_id="test", message="Ребёнок устал", context=CONTEXT)
            self.assertEqual(client.post("/internal/v1/assistant-intents", json=body).status_code, 401)
            with patch("services.parser_service.app.online_client", return_value=FakeClient(intent())):
                response = client.post("/internal/v1/assistant-intents", json=body, headers={"Authorization": "Bearer service-secret"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["intent"]["action"], "shorten_day")

    def test_recommendation_consumes_validated_llm_preferences(self):
        from test_recommendation_engine import sample_request
        from services.model_service.app import app as model_app
        body = sample_request()
        body["request_text"] = "Обойдёмся без музейных залов"
        body["parsed_request"] = dict(taxonomy_version="1.0", claims=[dict(kind="category", value="museum", polarity="avoid", evidence="без музейных залов")], needs_clarification=False, clarification_question=None, unsupported_requests=[])
        with patch.dict("os.environ", {"ML_API_TOKEN": "", "REQUEST_PARSER_URL": "http://unreachable.invalid"}), TestClient(model_app) as client:
            response = client.post("/internal/v1/recommendations", json=body)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(all("museum" not in c["place"]["categories"] for c in response.json()["candidates"]))
            body["parsed_request"]["claims"][0]["evidence"] = "придуманный текст"
            self.assertEqual(client.post("/internal/v1/recommendations", json=body).status_code, 422)


if __name__ == "__main__": unittest.main()
