"""Собирает frontend/data/cards.json из db/seed/main.csv и assets/images/manifest.json.

Описание из HTML превращается в обычный текст (абзацы), поэтому фронт может выводить его
через textContent без риска внедрения разметки. Заодно назначает каждому объекту вид задания тропы (поле game). Запуск: python3 scripts/build-frontend-cards.py
"""
import csv, html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
manifest = json.load(open(os.path.join(ROOT, "assets/images/manifest.json"), encoding="utf-8"))


def paragraphs(src):
    s = re.sub(r"(?i)<\s*br\s*/?>", "\n", src)
    s = re.sub(r"(?i)</\s*p\s*>", "\n\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ")
    out = []
    for block in re.split(r"\n\s*\n|\n", s):
        block = re.sub(r"[ \t]+", " ", block).strip()
        if block:
            out.append(block)
    return out


def point(s):
    m = re.match(r"POINT \(([\d.]+) ([\d.]+)\)", s)
    return [float(m.group(1)), float(m.group(2))]


cards = []
for r in csv.DictReader(open(os.path.join(ROOT, "db/seed/main.csv"), encoding="utf-8")):
    img = manifest.get(r["id"])
    if not img:
        continue
    cards.append({
        "id": r["id"], "title": r["title"].strip(), "category": r["category"],
        "address": re.sub(r"^(г\.\s*)?Нижний Новгород,\s*", "", r["address"].strip()),
        "location": point(r["coordinate"]), "text": paragraphs(r["description"]),
        "image": {"thumb": img["thumb"], "card": img["card"], "full": img["full"], "alt": img["alt"],
                  "width": img["width"], "height": img["height"]},
    })
# Задание для «Тропы Маши»: поровну между всеми объектами. Список упорядочен по (категория, id),
# виды идут по кругу, поэтому и в целом, и внутри каждой категории разница не больше одного места.
GAMES = ["jigsaw", "pixel", "paint"]          # пазл, пиксель-пазл, раскраска по номерам
for i, card in enumerate(sorted(cards, key=lambda c: (c["category"], int(c["id"])))):
    card["game"] = GAMES[i % len(GAMES)]
# Исключение: у этих мест текстовое задание «вопросы» (frontend/data/kid-quiz.json) вместо игры с картинкой.
# Остальным видам игр место не освобождаем: их назначение не сдвигается, картинки готовить заново не нужно.
QUIZ_PLACES = {"131"}                         # Памятник Валерию Чкалову
for card in cards:
    if card["id"] in QUIZ_PLACES:
        card["game"] = "quiz"

out = os.path.join(ROOT, "frontend/data/cards.json")
json.dump(cards, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
from collections import Counter
print(len(cards), "cards,", os.path.getsize(out) // 1024, "KB;", dict(Counter(c["game"] for c in cards)))
