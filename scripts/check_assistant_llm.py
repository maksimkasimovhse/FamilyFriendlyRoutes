"""Opt-in GigaChat smoke check using synthetic messages, with a secret-free report."""
import argparse
import json
import os
import shlex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "models"))
from assistant_schema import parse_assistant
from gigachat_client import GigaChatStructuredClient


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", required=True, help="Call the configured GigaChat account with synthetic data")
    parser.add_argument("--case", help="Only messages containing this synthetic fragment")
    args = parser.parse_args()
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if key.strip().startswith("GIGACHAT_") and key.strip() not in os.environ:
                values = shlex.split(value)
                if len(values) == 1:
                    os.environ[key.strip()] = values[0]
    bundle = os.environ.get("GIGACHAT_CA_BUNDLE", "")
    certificate = ROOT / "infra/docker/certs/russian_trusted_root_ca_pem.crt"
    if (not bundle or not Path(bundle).is_file()) and certificate.is_file():
        os.environ["GIGACHAT_CA_BUNDLE"] = str(certificate)
    client = GigaChatStructuredClient(timeout_seconds=12)
    context = {
        "selected_date": "2030-06-15", "observed_at": "2030-06-15T10:00:00+03:00",
        "family": {"children": [{"child_id": "child-1", "age_years": 5}, {"child_id": "child-2", "age_years": 9}]},
        "days": [{"date": "2030-06-15", "stops": [
            {"stop_id": "stop-museum", "title": "Музей", "progress": "planned", "mandatory": False},
            {"stop_id": "stop-park", "title": "Парк", "progress": "planned", "mandatory": False}]},
            {"date": "2030-06-16", "stops": []}],
        "history": [], "choices": [],
    }
    for day in context["days"]:
        day["end_point"] = {"coordinates": [44.01, 56.326], "label": "Отель — точка завершения дня"}
    cases = [
        ("Ребёнок устал, хотим меньше ходить", "shorten_day", "rest"),
        ("Нужен туалет прямо сейчас", "find_places", "toilet"),
        ("Хотим поесть по пути", "find_places", "food"),
        ("Убери следующую точку", "remove_stop", None),
        ("Через час нужно быть в отеле", "return_to_hotel", "return"),
        ("Пошёл дождь, где укрыться?", "find_places", "shelter"),
        ("Перенеси музей на завтра", "move_stop", None),
        ("До отеля нужно дойти к 11:00", "return_to_hotel", "return"),
        ("Хотим пройти не больше 500 метров", "shorten_day", "less_walking"),
        ("Добавь второй вариант", "add_activity", None),
        ("Хотим животных, без музеев", "preferences", None),
    ]
    results = []
    for message, action, need in cases:
        if args.case and args.case not in message:
            continue
        start = time.monotonic()
        try:
            case_context = dict(context)
            if message == "Добавь второй вариант":
                case_context["choices"] = [{"place_id": "cafe-1", "number": 1, "name": "Кафе первое"}, {"place_id": "cafe-2", "number": 2, "name": "Кафе второе"}]
                case_context["history"] = [{"message": "Хотим поесть", "reply": "Нашёл два варианта"}]
            if action == "preferences":
                case_context["initial"] = True
            intent, response = parse_assistant(message, case_context, client)
            passed = intent.action == action and (need is None or need in {n.kind for n in intent.needs})
            if action == "return_to_hotel":
                passed = passed and intent.duration_sec == 3600
            if message == "Хотим пройти не больше 500 метров":
                passed = passed and intent.max_walk_distance_m == 500
            if message == "Добавь второй вариант":
                passed = passed and intent.place_id == "cafe-2"
            results.append({"message": message, "passed": passed, "action": intent.action,
                            "needs": [n.kind for n in intent.needs], "model": response.model,
                            "duration_sec": intent.duration_sec,
                            "max_walk_distance_m": intent.max_walk_distance_m,
                            "elapsed_sec": round(time.monotonic() - start, 2)})
        except Exception as error:
            results.append({"message": message, "passed": False, "error_type": type(error).__name__,
                            "elapsed_sec": round(time.monotonic() - start, 2)})
            if isinstance(error, ValueError):
                results[-1]["validation_error"] = str(error)[:1800]
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    destination = ROOT / "data/processed/assistant/llm_smoke.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"checked_at": datetime.now(timezone.utc).isoformat(),
                                     "passed": all(row["passed"] for row in results),
                                     "scenario_count": len(results), "synthetic_data_only": True,
                                     "checks": results}, ensure_ascii=False, indent=2) + "\n")
    if not all(row["passed"] for row in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
