#!/usr/bin/env python3
"""Создаёт демо-аккаунты с готовой анкетой через настоящий backend (для защиты и репетиций).

Запуск (стек поднят, открыт http://localhost:8000):  python3 scripts/seed-demo-users.py
Повторный запуск сохраняет существующие анкеты. --check только проверяет вход и анкету.
Аккаунты и анкеты лежат в data/backend/state.json (в git не попадает). Имена детей хранятся
только на устройстве — для демо-аккаунтов фронтенд подставляет их сам (frontend/js/onboarding.js, DEMO_NAMES).
"""
import argparse
import json, sys, urllib.request, urllib.error, http.cookiejar

DEFAULT_BASE = "http://localhost:8000"
PASSWORD = "demo-semya-nizhny-2026"
LIMITS = {"pace": "relaxed", "max_walk_distance_m_per_day": None, "max_continuous_walk_duration_sec": None, "restaurant_walk_reserve_m_per_day": 0}

USERS = [
    # (почта, анкета или None — «новичок» пройдёт анкету сам)
    ("masha@example.com", {
        "family": {"children": [{"child_id": "child-1", "age_years": 7, "height_cm": None, "interest_ids": ["history", "animals"]}],
                   "adult_count": 2, "adult_interest_ids": ["history", "architecture"]},
        "load_limits": {**LIMITS, "pace": "relaxed"}, "wishes": "Частые перерывы"}),
    ("petya@example.com", {
        "family": {"children": [{"child_id": "child-1", "age_years": 4, "height_cm": None, "interest_ids": ["animals", "play"]},
                                {"child_id": "child-2", "age_years": 9, "height_cm": None, "interest_ids": ["science", "history"]}],
                   "adult_count": 2, "adult_interest_ids": ["museums", "walks"]},
        "load_limits": {**LIMITS, "pace": "standard"}, "wishes": None}),
    # «Новичок» на странице входа каждый раз регистрирует новый аккаунт — заранее не создаём
]

def client(base=DEFAULT_BASE):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.ProxyHandler({}))
    state = {"csrf": None}
    def call(method, path, body=None):
        headers = {"Content-Type": "application/json", "Origin": base}
        if state["csrf"]: headers["X-CSRF-Token"] = state["csrf"]
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with opener.open(req, timeout=30) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e: return e.code, json.load(e)
    status, data = call("GET", "/api/v1/session")
    if status != 200 or not data.get("csrf_token"):
        raise RuntimeError(f"Не удалось получить сессию: HTTP {status}")
    state["csrf"] = data["csrf_token"]
    return call, state

def seed_user(call, state, email, profile, *, check_only=False):
    status, data = call("POST", "/api/v1/auth/login", {"email": email, "password": PASSWORD})
    action = "уже был"
    if status == 401 and not check_only:
        status, data = call("POST", "/api/v1/auth/register", {"email": email, "password": PASSWORD})
        action = "создан"
        if status == 409:
            # Another process may have seeded it meanwhile. Never reset passwords.
            status, data = call("POST", "/api/v1/auth/login", {"email": email, "password": PASSWORD})
            action = "уже был"
    if status != 200 and status != 201:
        code = data.get("error", {}).get("code", "UNKNOWN")
        raise RuntimeError(f"вход/создание: HTTP {status} ({code})")
    state["csrf"] = data["csrf_token"]
    if profile is None:
        return f"{email}: {action}, без шаблона анкеты"
    status, current = call("GET", "/api/v1/profile/family")
    if status == 200:
        return f"{email}: {action}, существующая анкета сохранена без изменений (версия {current.get('version')})"
    if status != 404 or current.get("error", {}).get("code") != "PROFILE_NOT_FOUND":
        raise RuntimeError(f"чтение анкеты: HTTP {status}; запись не выполнялась")
    if check_only:
        raise RuntimeError("аккаунт есть, анкета отсутствует; --check ничего не изменяет")
    status, saved = call("PUT", "/api/v1/profile/family", {"expected_version": 0, **profile})
    if status not in (200, 201):
        raise RuntimeError(f"создание анкеты: HTTP {status}")
    return f"{email}: {action}, отсутствующая анкета создана (версия {saved.get('version')})"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", default=DEFAULT_BASE)
    parser.add_argument("--check", action="store_true", help="Проверить вход и анкеты без регистрации и изменения профилей")
    args = parser.parse_args()
    failures = 0
    for email, profile in USERS:
        try:
            call, state = client(args.base_url.rstrip("/"))
            print(seed_user(call, state, email, profile, check_only=args.check))
        except (RuntimeError, OSError, ValueError) as error:
            failures += 1
            print(f"{email}: ОШИБКА {error}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
