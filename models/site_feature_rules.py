"""Deterministic extraction of published labels, JSON-LD menus and simple hours.

This deliberately recognizes a subset and leaves unsupported schedules unparsed.
"""
from __future__ import annotations

import json
import re

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
DAY_ALIASES = (
    r"понедельник(?:а|ам|и)?|\bпн\b|\bmo\b|monday",
    r"вторник(?:а|ам|и)?|\bвт\b|\btu\b|tuesday",
    r"сред(?:а|у|ы|ам)|\bср\b|\bwe\b|wednesday",
    r"четверг(?:а|ам|и)?|\bчт\b|\bth\b|thursday",
    r"пятниц(?:а|у|ы|ам)|\bпт\b|\bfr\b|friday",
    r"суббот(?:а|у|ы|ам)|\bсб\b|\bsa\b|saturday",
    r"воскресень(?:е|я|ям)|\bвс\b|\bsu\b|sunday",
)


def simple_hours(text, *, osm=False):
    normalized = text.casefold().replace("ё", "е").replace("–", "-").replace("—", "-").replace("−", "-")
    if normalized.strip() == "24/7" or re.fullmatch(r"\s*(ежедневно\s*)?круглосуточно\s*", normalized):
        return [{"day_of_week": d, "opens": "00:00", "closes": "00:00", "end_day_offset": 1} for d in DAYS]
    # Holidays, dates, conditional hours and astronomical times require another parser.
    if re.search(r"\bph\b|\bsh\b|праздни|по зап|предвар|sunrise|sunset|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b", normalized):
        return []
    for day, pattern in zip(DAYS, DAY_ALIASES):
        normalized = re.sub(pattern, day, normalized)
    normalized = re.sub(r"\bс\s*(\d{1,2})\s*до\s*(\d{1,2})(?!\d)",r"\1:00-\2:00",normalized)
    clauses = re.split(r";|\n|(?<=\d)\s*,\s*(?=[a-z])", normalized)
    intervals = []
    for clause in clauses:
        matches = list(re.finditer(r"(\d{1,2})[:.](\d{2})\s*(?:-|до)\s*(\d{1,2})[:.](\d{2})", clause))
        if not matches:
            continue
        prefix = clause[:matches[0].start()]
        present = [d for d in DAYS if d in prefix]
        if re.search(r"ежедневно|каждый день|без выходных", prefix) or (osm and not prefix.strip()):
            selected = list(DAYS)
        elif len(present) == 2 and re.search(present[0] + r"\s*-\s*" + present[1], prefix):
            start, end = DAYS.index(present[0]), DAYS.index(present[1])
            selected = [DAYS[(start + offset) % 7] for offset in range((end-start) % 7 + 1)]
        elif len(present) == 2 and re.search(present[1] + r"\s*-\s*" + present[0], prefix):
            start, end = DAYS.index(present[1]), DAYS.index(present[0])
            selected = [DAYS[(start + offset) % 7] for offset in range((end-start) % 7 + 1)]
        else:
            selected = present
        for m in matches:
            oh, om, ch, cm = map(int, m.groups())
            if not (0 <= oh < 24 and 0 <= om < 60 and 0 <= ch <= 24 and 0 <= cm < 60) or (ch == 24 and cm):
                continue
            start, end = oh * 60 + om, ch * 60 + cm
            if start == end:
                continue
            for day in selected:
                intervals.append({"day_of_week": day, "opens": f"{oh:02d}:{om:02d}", "closes": f"{ch%24:02d}:{cm:02d}", "end_day_offset": int(end <= start or ch == 24)})
    # If a calendar exception was not understood, do not silently claim a full week.
    return list({json.dumps(row, sort_keys=True): row for row in intervals}.values())


def make_claim(prop, value, quote, *, subject, scope="place", source_part="visible_text", unit=None, condition=None):
    return {"property": prop, "subject": subject, "scope": scope,
            "value_text": value if isinstance(value, str) else None,
            "value_boolean": value if isinstance(value, bool) else None,
            "value_number": value if isinstance(value, (int, float)) and not isinstance(value, bool) else None,
            "unit": unit, "condition_text": condition, "quote": quote, "source_part": source_part}


def deterministic_claims(page, names, categories):
    subject = names[0] if names else page.get("title") or "Источник"
    scope = "brand" if len(names) > 1 else "restaurant" if "restaurant" in categories else "place"
    claims = []
    text = re.split(r"(?im)^\s*(?:отзывы(?: наших гостей| посетителей)?|что говорят о нас)\s*$", page["text"])[0]
    positive_patterns = {
        "children_menu": r"детско[её] меню|меню для детей",
        "play_room": r"детск(?:ая|ой|ую) (?:игровая |игровой |игровую )?(?:комнат[ауы]|зон[ауы])|игров(?:ая|ой|ую) комнат[ауы]",
        "colouring_books": r"раскраск[аиу]|книжки.раскраски",
        "board_games": r"настольны[ех] игр[ыа]",
        "high_chairs": r"детски[ех] стульчик[иа]|стульчик[иа] для кормления",
        "small_portions": r"маленьк(?:ая|ие|ую|ими) порци[яию]|половин(?:а|у|ные) порци[ия]",
    }
    if "restaurant" in categories:
        for prop, pattern in positive_patterns.items():
            m = re.search(pattern, text, re.I)
            if not m:
                continue
            start, end = text.rfind("\n", 0, m.start()) + 1, text.find("\n", m.end())
            end = len(text) if end == -1 else end
            quote = text[start:end]
            if len(quote) > 1500:
                quote = text[max(start, m.start()-120):min(end, m.end()+200)]
            if re.search(r"(?i)отзыв|спасибо|благодар|скоро|планиру", quote):
                continue
            negative = bool(re.search(r"(?i)нет\s+|отсутств|не предусмотр", quote))
            claims.append(make_claim(prop, not negative, quote, subject=subject, scope=scope))
        cuisine = r"(?:русск|грузинск|итальянск|европейск|кавказск|японск|китайск|паназиатск|корейск|турецк|северн|авторск|восточн|современн)[а-я]*(?:\s+и\s+[а-я]+)?\s+кухн[а-я]*"
        for m in list(re.finditer(cuisine, text, re.I))[:12]:
            start, end = text.rfind("\n", 0, m.start()) + 1, text.find("\n", m.end())
            end = len(text) if end == -1 else end
            quote = text[start:end]
            if len(quote) <= 1500 and not re.search(r"(?i)отзыв|спасибо|родился|шеф-повар|менеджер", quote):
                claims.append(make_claim("cuisine", m.group(), quote, subject=subject, scope=scope))
        for line in text.splitlines():
            if re.search(r"(?i)бэби.?ситтер|беби.?ситтер|аниматор|няня|няни",line) and len(line)<800:
                claims.append(make_claim("play_room_staff",line,line,subject="Игровая зона: "+subject,scope="play_room"))
                if simple_hours(line):
                    claims.append(make_claim("play_room_staff_hours_text",line,line,subject="Игровая зона: "+subject,scope="play_room"))
        for link in page.get("links",[]):
            if re.search(r"(?i)меню",link["text"]) and link["url"].startswith(("http://","https://")):
                claims.append(make_claim("menu_url",link["url"],link["url"],subject=subject,scope="kitchen",source_part="html_link"))
    for line in text.splitlines():
        if re.search(r"\d{1,2}[:.]\d{2}\s*(?:-|–|—|до)\s*\d{1,2}[:.]\d{2}", line) and len(line) < 1000 and not re.search(r"(?i)куки|cookie|политик|доставк|вокал|концерт|\b20\d\d\b", line):
            if simple_hours(line):
                prop = "kitchen_hours_text" if re.search(r"(?i)кухн", line) else "opening_hours_text"
                claims.append(make_claim(prop, line, line, subject=subject, scope="kitchen" if prop.startswith("kitchen") else scope))
    def visit(node):
        if isinstance(node, list):
            for item in node:
                yield from visit(item)
        elif isinstance(node, dict):
            yield node
            for item in node.values():
                if isinstance(item, (dict, list)):
                    yield from visit(item)
    for node in visit(page.get("json_ld", [])):
        types = node.get("@type", [])
        types = [types] if isinstance(types, str) else types
        if "MenuItem" in types and isinstance(node.get("name"), str):
            name = node["name"]
            claims.append(make_claim("dish", name, name, subject=name, scope="kitchen", source_part="json_ld"))
            offers = node.get("offers", [])
            offers = [offers] if isinstance(offers, dict) else offers
            for offer in offers:
                try:
                    price = float(str(offer["price"]).replace(",", "."))
                except (KeyError, ValueError, TypeError):
                    continue
                quote = json.dumps(node, ensure_ascii=False)
                if len(quote) <= 2000:
                    claims.append(make_claim("meal_price", price, quote, subject=name, scope="kitchen", source_part="json_ld", unit=offer.get("priceCurrency", "currency_unknown") + " dish"))
        if set(types) & {"Restaurant", "CafeOrCoffeeShop", "FoodEstablishment"}:
            cuisines = node.get("servesCuisine", [])
            cuisines = [cuisines] if isinstance(cuisines, str) else cuisines
            for cuisine in cuisines:
                if isinstance(cuisine, str):
                    claims.append(make_claim("cuisine", cuisine, cuisine, subject=node.get("name", subject), scope=scope, source_part="json_ld"))
            for key in ("menu", "hasMenu"):
                if isinstance(node.get(key), str) and node[key].startswith(("http://", "https://")):
                    claims.append(make_claim("menu_url", node[key], node[key], subject=subject, scope=scope, source_part="json_ld"))
    return claims
