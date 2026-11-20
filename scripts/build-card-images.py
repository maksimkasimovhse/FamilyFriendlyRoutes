"""Собирает assets/images из исходных фото (data/card_images + db/seed/card_images.csv).

Для каждого оригинала пишет три WebP: thumb (320px), card (800px), full (1280px по ширине,
без увеличения) в assets/images/ab/cd/<sha256>_<size>.webp, где sha256 — хеш файла-оригинала.
Результат: db/seed/card_images.csv (с колонкой sha256) и assets/images/manifest.json.
Нужен Pillow: pip install pillow
"""
import csv, hashlib, json, os, sys
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZES = {"thumb": (320, 70), "card": (800, 80), "full": (1280, 75)}  # ширина, качество
OUT = os.path.join(ROOT, "assets", "images")
CSV = os.path.join(ROOT, "db", "seed", "card_images.csv")

rows = list(csv.DictReader(open(CSV, encoding="utf-8")))
titles = {r["id"]: r["title"] for r in csv.DictReader(open(os.path.join(ROOT, "db/seed/main.csv"), encoding="utf-8"))}
manifest = {}
for r in rows:
    src = os.path.join(ROOT, r["file"])
    data = open(src, "rb").read()
    sha = hashlib.sha256(data).hexdigest()
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    r["sha256"], r["width"], r["height"] = sha, im.width, im.height
    d = os.path.join(OUT, sha[:2], sha[2:4])
    os.makedirs(d, exist_ok=True)
    urls = {}
    for name, (w, q) in SIZES.items():
        v = im if im.width <= w else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        v.save(os.path.join(d, f"{sha}_{name}.webp"), "WEBP", quality=q, method=6)
        urls[name] = f"/media/{sha[:2]}/{sha[2:4]}/{sha}_{name}.webp"
    manifest[r["item_id"]] = {**urls, "alt": titles[r["item_id"]], "width": im.width, "height": im.height}
    print(r["item_id"], file=sys.stderr)

cols = ["item_id", "title", "category", "sha256", "width", "height", "source_url", "file", "query", "alt", "alternatives"]
with open(CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, cols, extrasaction="ignore"); w.writeheader(); w.writerows(rows)
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
