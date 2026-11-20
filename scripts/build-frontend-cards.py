"""Собирает frontend/data/cards.json из db/seed/main.csv и assets/images/manifest.json.

Описание из HTML превращается в обычный текст (абзацы), поэтому фронт может выводить его
через textContent без риска внедрения разметки. Запуск: python3 scripts/build-frontend-cards.py
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
out = os.path.join(ROOT, "frontend/data/cards.json")
json.dump(cards, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(cards), "cards,", os.path.getsize(out) // 1024, "KB")
