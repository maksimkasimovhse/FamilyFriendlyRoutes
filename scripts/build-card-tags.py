"""Теги карточек для подбора по пожеланиям: data/card_tags.json (id → теги таксономии models/taxonomy.py).

Теги ставятся детерминированно: категория набора + ключевые основы слов из data/wish_keywords.json
в названии и описании. Те же правила (в Go, internal/wishes) читают текст пожелания пользователя,
поэтому «хотим про историю» и описание памятника сходятся на одном теге interest:history.
Это стартовая разметка: позже её заменит проверенная разметка из parser-service (GigaChat).

Запуск: python3 scripts/build-card-tags.py
"""
import csv, html, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = json.load(open(os.path.join(ROOT, "data/wish_keywords.json"), encoding="utf-8"))["rules"]

BASE = {   # категория набора → базовые теги
    "Музеи и выставочные центры": ["category:museum", "interest:history", "format:educational"],
    "Театры": ["category:event", "interest:theatre", "format:spectacular"],
    "Парки и места отдыха": ["category:park", "interest:nature", "format:calm"],
    "Набережные": ["category:park", "interest:nature", "format:calm"],
    "Памятники": ["category:landmark", "interest:history"],
    "Достопримечательности": ["category:landmark"],
    "Культурно-развлекательные организации": ["category:event"],
}
STRONG = 2     # столько раз основа должна встретиться в тексте, чтобы считаться (в названии — хватит одного)


def plain(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).lower()


def main():
    rows = list(csv.DictReader(open(os.path.join(ROOT, "db/seed/main.csv"), encoding="utf-8")))
    out = {}
    for r in rows:
        title, text = plain(r["title"]), plain(r["description"])
        tags = set(BASE.get(r["category"], []))
        for tag, rule in RULES.items():
            if tag.startswith("category:"):
                continue          # категория — от набора данных, а не от слов в описании
            hits = sum(text.count(s) for s in rule["stems"])
            if any(s in title for s in rule["stems"]) or hits >= STRONG:
                tags.add(tag)
        out[r["id"]] = sorted(tags)
    path = os.path.join(ROOT, "data/card_tags.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=0, sort_keys=True)
    from collections import Counter
    c = Counter(t for tags in out.values() for t in tags)
    print(len(out), "карточек; теги:", dict(sorted(c.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
