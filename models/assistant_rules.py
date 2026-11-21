"""Bounded fallback for explicit commands when the online LLM is unavailable.

Unknown conditions require clarification. No venue facts or route geometry are made up.
"""
import re
from datetime import date, timedelta

from assistant_context import normalize_context
from assistant_schema import explicit_distance, explicit_duration, validate_assistant_response
from baseline_query import parse_baseline_text
from gigachat_client import StructuredResponse


NEEDS = {
    "rest": r"устал\w*|сил нет|отдохн\w*|перерыв\w*",
    "food": r"поесть|голод\w*|перекус\w*|обед\w*|ужин\w*",
    "toilet": r"туалет\w*|санузел\w*|пописать",
    "shelter": r"дожд\w*|ливень|промок\w*|укры\w*",
    "play": r"поигра\w*|побега\w*|площадк\w*",
    "less_walking": r"меньше ходить",
    "return": r"(?:в|до) отел\w*|домой|к точке завершения дня|к точке финиша",
}
DISTANCE = r"(?:не больше|не более|максимум|не дальше)\s+(?:\d+(?:[.,]\d+)?\s*(?:километр\w*|км|метр\w*|м)|километра|полкилометра)"
INTERVAL = r"\b(?:(?:через\s+)?(?:\d+(?:[.,]\d+)?\s*(?:час\w*|минут\w*)|полчаса|полтора часа|час)|(?:к|до)\s*\d{1,2}:\d{2})\b"


def parse_rules(message, context):
    context = normalize_context(context)
    days = context.get("days", [])
    selected = context.get("selected_date") or (days[0]["date"] if len(days) == 1 else None)
    parsed = parse_baseline_text(message)
    needs = []
    recognized = []
    for kind, pattern in NEEDS.items():
        match = re.search(pattern, message, re.I)
        if match:
            recognized.append(match.group())
            needs.append(dict(kind=kind, child_id=None, urgency="now" if re.search("сейчас|срочно", message, re.I) else "unspecified", evidence=match.group()))
    walking = re.search(DISTANCE, message, re.I)
    interval = re.search(INTERVAL, message, re.I)
    distance = explicit_distance(walking.group()) if walking else None
    duration = explicit_duration(interval.group(), context, selected) if interval else None
    action = "preferences" if context.get("initial") else "clarify"
    question = None if context.get("initial") else "Уточните, какое изменение нужно подготовить."
    stop_id = place_id = target = None
    if not context.get("initial"):
        kinds = {n["kind"] for n in needs}
        if "return" in kinds:
            action = "return_to_hotel"
        elif walking or "rest" in kinds or "less_walking" in kinds:
            action = "shorten_day"
        elif needs or parsed.claims:
            action = "find_places"
        planned = [s for d in days if d["date"] == selected for s in d.get("stops", []) if s["progress"] == "planned"]
        if re.search(r"\b(?:убери|удали|пропусти|перенеси)\b", message, re.I):
            matches = [s for s in planned if any(len(w) >= 4 and w in s["title"].casefold() for w in re.findall(r"\w+", message.casefold()))]
            if re.search("следующ", message, re.I) and planned:
                matches = planned[:1]
            if len(matches) == 1:
                stop_id = matches[0]["stop_id"]
                recognized.append(matches[0]["title"])
                action = "remove_stop"
                if re.search("перенеси", message, re.I) and selected and re.search("завтра", message, re.I):
                    target = (date.fromisoformat(selected) + timedelta(days=1)).isoformat()
                    if target in {d["date"] for d in days}:
                        action = "move_stop"
                    else:
                        action, question = "clarify", "На какую существующую дату перенести остановку?"
            else:
                action, question = "clarify", "Какую остановку вы хотите изменить?"
        if re.search("пересчитай|опаздываем|задержались", message, re.I):
            action = "replan_day"
        choice = re.search(r"(?:вариант\s*([123])|([123])\s*вариант|первый|второй|третий)", message, re.I)
        if choice and re.search("добав|выбира|давай", message, re.I):
            number = int(choice[1] or choice[2] or {"первый": 1, "второй": 2, "третий": 3}[choice.group().casefold()])
            candidates = [c for i,c in enumerate(context.get("choices", []), 1) if c.get("number", i) == number]
            if len(candidates) == 1:
                action, place_id = "add_activity", candidates[0]["place_id"]
            else:
                action, question = "clarify", "Выберите один из предложенных вариантов."
    # Only discard an unsupported clause when every substantive word is covered.
    unknown = []
    for clause in parsed.unsupported_requests:
        remaining = clause.casefold()
        for pattern in [DISTANCE, INTERVAL, *NEEDS.values(), r"\b(?:реб[её]нок|дети|хотим|хочу|нужно|надо|пройти|пройд[её]м|гулять|ходить|частые|часто|по|пути|пош[её]л|где|быть|дойти|нам|мы|давай|добавь|вариант|первый|второй|третий|убери|удали|пропусти|перенеси|следующую|точку|остановку|на|завтра|пересчитай|маршрут|опаздываем|задержались|сейчас|срочно|и|пожалуйста)\b"]:
            remaining = re.sub(pattern, " ", remaining, flags=re.I)
        for span in recognized:
            remaining = remaining.replace(span.casefold(), " ")
        if re.search(r"[а-яёa-z]", remaining):
            unknown.append(clause)
    parsed.unsupported_requests = unknown
    if unknown:
        action, question = "clarify", "ИИ-разбор недоступен. Не могу надёжно учесть условие: «" + unknown[0][:150] + "». Уточните просьбу."
    if not needs and not parsed.claims and not walking and not interval and action == "preferences":
        action, question = "clarify", "Уточните пожелания к прогулке."
    if context.get("initial") and len(days) > 1 and (walking or interval):
        action, question = "clarify", "Для какого дня нужно ограничить время или ходьбу?"
    if action != "clarify":
        question = None
    value = dict(action=action, date=selected, target_date=target, stop_id=stop_id, place_id=place_id, stop_ids=[],
        duration_sec=duration, duration_evidence=interval.group() if interval and duration is not None else None,
        max_walk_distance_m=distance, walk_evidence=walking.group() if walking else None,
        question=question, needs=needs, preferences=parsed.model_dump())
    return validate_assistant_response(message, context, StructuredResponse(value=value, model="explicit-rules-v1", usage={}))
