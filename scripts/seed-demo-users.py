#!/usr/bin/env python3
"""Создаёт демо-аккаунты с готовой анкетой через настоящий backend (для защиты и репетиций).

Запуск (стек поднят, открыт http://localhost:8000):  python3 scripts/seed-demo-users.py
Повторный запуск безопасен: существующий аккаунт получает «Войти» вместо повторной регистрации.
Аккаунты и анкеты лежат в data/backend/state.json (в git не попадает). Имена детей хранятся
только на устройстве — для демо-аккаунтов фронтенд подставляет их сам (frontend/js/onboarding.js, DEMO_NAMES).
"""
import json, sys, urllib.request, urllib.error, http.cookiejar

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
PASSWORD = "demo-semya-nizhny-2026"
LIMITS = {"pace": "relaxed", "max_walk_distance_m_per_day": None, "max_continuous_walk_duration_sec": None, "restaurant_walk_reserve_m_per_day": 0}

USERS = [
    # (почта, анкета или None — «новичок» пройдёт анкету сам)
    ("mama@example.com", {
        "family": {"children": [{"child_id": "child-1", "age_years": 7, "height_cm": None, "interest_ids": ["history", "animals"]}],
                   "adult_count": 2, "adult_interest_ids": ["history", "architecture"]},
        "load_limits": {**LIMITS, "pace": "relaxed"}, "wishes": "Частые перерывы"}),
    ("dvoe@example.com", {
        "family": {"children": [{"child_id": "child-1", "age_years": 4, "height_cm": None, "interest_ids": ["animals", "play"]},
                                {"child_id": "child-2", "age_years": 9, "height_cm": None, "interest_ids": ["science", "history"]}],
                   "adult_count": 2, "adult_interest_ids": ["museums", "walks"]},
        "load_limits": {**LIMITS, "pace": "standard"}, "wishes": None}),
    # «Новичок» на странице входа каждый раз регистрирует новый аккаунт — заранее не создаём
]

def client():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.ProxyHandler({}))
    state = {"csrf": None}
    def call(method, path, body=None):
        headers = {"Content-Type": "application/json", "Origin": BASE}
        if state["csrf"]: headers["X-CSRF-Token"] = state["csrf"]
        req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            with opener.open(req, timeout=30) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e: return e.code, json.load(e)
    state["csrf"] = call("GET", "/api/v1/session")[1]["csrf_token"]
    return call, state

for email, profile in USERS:
    call, state = client()
    status, data = call("POST", "/api/v1/auth/register", {"email": email, "password": PASSWORD})
    action = "создан"
    if status == 409 or (status >= 400 and data.get("error", {}).get("code") in ("EMAIL_TAKEN", "ACCOUNT_EXISTS", "CONFLICT")):
        status, data = call("POST", "/api/v1/auth/login", {"email": email, "password": PASSWORD})
        action = "уже был"
    if status >= 400:
        print(f"{email}: ОШИБКА {status} {data.get('error', {}).get('message')}"); continue
    state["csrf"] = data["csrf_token"]
    note = ""
    if profile:
        s, cur = call("GET", "/api/v1/profile/family")
        version = cur["version"] if s == 200 else 0
        s, saved = call("PUT", "/api/v1/profile/family", {"expected_version": version, **profile})
        note = f", анкета сохранена (версия {saved.get('version')})" if s < 300 else f", анкета: ОШИБКА {s} {saved.get('error', {}).get('message')}"
    else:
        note = ", без анкеты (пройдёт её сам)"
    print(f"{email}: {action}{note}")
print(f"\nПароль у всех: {PASSWORD}")
