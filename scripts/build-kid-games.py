"""Готовит картинки для заданий «Тропы Маши» для ВСЕХ мест из db/seed/main.csv (frontend/media/kid/<id места>/).

Вид задания каждому месту назначает scripts/build-frontend-cards.py (поле game в frontend/data/cards.json):
поровну пазл, пиксель-пазл и раскраска. Здесь готовится только то, что нужно этому виду:
  jigsaw — ничего: пазл режется в браузере из карточной картинки (assets/images, размер full)
  quiz   — ничего: вопросы лежат в frontend/data/kid-quiz.json
  pixel  — pixel.png: пиксель-арт 48×36 блоков с ограниченной палитрой, увеличенный без сглаживания до 960×720
  paint  — paint.png + paint.json: карта областей раскраски 480×360 (номер области в каналах R и G)
           и данные: палитра (номер цвета → #rrggbb), области (id, номер цвета, центр cx, cy и радиус r).
           Сложность подбирается автоматически: 14–50 областей на картинку.
Кадрирование везде одно: 4:3 по центру, чуть выше середины (ImageOps.fit, centering 0.5/0.45); так же режет games.js.

Нужны Pillow, numpy, scipy:  pip install pillow numpy scipy
Порядок: python3 scripts/build-frontend-cards.py && python3 scripts/build-kid-games.py [--preview папка]
"""
import json, os, sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageOps, ImageFont
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "media", "kid")

CARDS = json.load(open(os.path.join(ROOT, "frontend/data/cards.json"), encoding="utf-8"))

PHOTO_W, PHOTO_H = 960, 720          # 4:3
PIX_W, PIX_H = 48, 36                # блоки пиксель-арта: делится на 2/3/4 по обеим осям
PIX_COLORS = 22
PAINT_W, PAINT_H = 480, 360
PAINT_COLORS = 10
MIN_AREA = 450                       # область меньше (в px карты) сливается с соседней
MEDIAN = 5                           # сглаживание перед разбиением на цвета


def load_photo(card):
    path = os.path.join(ROOT, "assets/images", card["image"]["full"][len("/media/"):])
    im = Image.open(path).convert("RGB")
    return ImageOps.fit(im, (PHOTO_W, PHOTO_H), Image.LANCZOS, centering=(0.5, 0.45))


def build_pixel(photo):
    small = photo.resize((PIX_W, PIX_H), Image.BOX)
    lum = np.asarray(small.convert("L")).mean()
    if lum < 110:   # тёмные (ночные) фото подтягиваем, иначе пиксели сливаются
        gamma = 0.55
        small = Image.eval(small, lambda v: int(255 * (v / 255) ** gamma))
    small = ImageOps.autocontrast(small, cutoff=1)
    small = ImageEnhance.Color(small).enhance(1.35)
    small = ImageEnhance.Contrast(small).enhance(1.12)
    q = small.quantize(colors=PIX_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    return q.resize((PHOTO_W, PHOTO_H), Image.NEAREST)


def mode_filter(idx, k, size):
    """Самый частый цвет в окне size×size: убирает «шум» из одиночных пикселей."""
    best = np.zeros(idx.shape, np.float32)
    out = idx.copy()
    for c in range(k):
        score = ndi.uniform_filter((idx == c).astype(np.float32), size)
        mask = score > best
        out[mask] = c
        best[mask] = score[mask]
    return out


def merge_close_colors(idx, k, arr, threshold=26):
    """Почти одинаковые цвета (оттенки неба) сливаем: ребёнку не отличить 6 голубых друг от друга."""
    while True:
        used = [c for c in range(k) if (idx == c).any()]
        means = {c: arr[idx == c].mean(axis=0) for c in used}
        best = None
        for a in used:
            for b in used:
                if a < b:
                    d = float(np.linalg.norm(means[a] - means[b]))
                    if d < threshold and (best is None or d < best[0]):
                        best = (d, a, b)
        if best is None:
            return idx
        _, a, b = best
        if (idx == a).sum() > (idx == b).sum():
            a, b = b, a
        idx[idx == a] = b


def label_regions(idx, k):
    """Связные области одного цвета. Возвращает (карта id начиная с 1, список номеров цвета по id)."""
    labels = np.zeros(idx.shape, np.int32)
    colors = [None]
    n = 0
    for c in range(k):
        lab, cnt = ndi.label(idx == c)
        if cnt:
            labels[lab > 0] = lab[lab > 0] + n
            colors += [c] * cnt
            n += cnt
    return labels, colors


def build_paint(photo, min_area=MIN_AREA):
    small = photo.resize((PAINT_W, PAINT_H), Image.LANCZOS)
    small = ImageEnhance.Color(small).enhance(1.25)
    small = small.filter(ImageFilter.MedianFilter(MEDIAN)).filter(ImageFilter.GaussianBlur(0.8))
    q = small.quantize(colors=PAINT_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    idx = np.array(q).astype(np.int32)
    k = int(idx.max()) + 1
    idx = mode_filter(idx, k, 5)
    idx = merge_close_colors(idx, k, np.array(small).astype(np.float32))

    # Мелкие области отдаём самому частому соседнему цвету. Идём по одной, от самых мелких, и каждый раз
    # смотрим на уже обновлённые цвета: иначе две соседние мелкие области меняются цветами и не сливаются.
    for _ in range(40):
        labels, colors = label_regions(idx, k)
        areas = np.bincount(labels.ravel())
        small_ids = sorted((i for i in range(1, len(areas)) if areas[i] < min_area), key=lambda i: areas[i])
        if not small_ids:
            break
        for i in small_ids:
            mask = labels == i
            ring = ndi.binary_dilation(mask, iterations=2) & ~mask
            around = idx[ring]
            if around.size:
                idx[mask] = np.bincount(around, minlength=k).argmax()
    labels, colors = label_regions(idx, k)

    # Номера цветов: от светлого к тёмному; цвет — среднее по исходному фото.
    arr = np.array(small).astype(np.float32)
    used = sorted({c for c in colors[1:]})
    means = {c: arr[idx == c].mean(axis=0) for c in used}
    order = sorted(used, key=lambda c: -(0.299 * means[c][0] + 0.587 * means[c][1] + 0.114 * means[c][2]))
    number = {c: i + 1 for i, c in enumerate(order)}
    palette = {number[c]: "#%02x%02x%02x" % tuple(int(round(v)) for v in means[c]) for c in used}

    regions = []
    for i, sl in enumerate(ndi.find_objects(labels), start=1):
        if sl is None:
            continue
        mask = np.pad(labels[sl] == i, 1)
        dist = ndi.distance_transform_edt(mask)
        y, x = np.unravel_index(dist.argmax(), dist.shape)
        regions.append({"id": i, "c": number[colors[i]], "cx": int(x - 1 + sl[1].start), "cy": int(y - 1 + sl[0].start), "r": round(float(dist.max()), 1)})

    rgb = np.zeros(labels.shape + (3,), np.uint8)
    rgb[..., 0] = labels & 255
    rgb[..., 1] = labels >> 8
    return Image.fromarray(rgb), {"w": PAINT_W, "h": PAINT_H, "palette": palette, "regions": regions}, labels


def preview(labels, meta, path):
    """Контрольная картинка: чёрно-белая раскраска с номерами, как увидит ребёнок."""
    s = 2
    h, w = labels.shape
    edge = np.zeros(labels.shape, bool)
    edge[:, :-1] |= labels[:, :-1] != labels[:, 1:]
    edge[:-1, :] |= labels[:-1, :] != labels[1:, :]
    img = Image.new("RGB", (w * s, h * s), "white")
    ys, xs = np.nonzero(edge)
    px = img.load()
    for y, x in zip(ys, xs):
        for dy in range(s + 1):
            for dx in range(s + 1):
                if y * s + dy < h * s and x * s + dx < w * s:
                    px[x * s + dx, y * s + dy] = (0, 0, 0)
    d = ImageDraw.Draw(img)
    for r in meta["regions"]:
        size = max(10, min(34, int(r["r"] * s * 0.9)))
        try:
            f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", size)
        except OSError:
            f = ImageFont.load_default()
        d.text((r["cx"] * s, r["cy"] * s), str(r["c"]), fill="black", font=f, anchor="mm")
    img.save(path)


MIN_REGIONS, MAX_REGIONS = 14, 50
AREA_STEPS = [450, 700, 1000, 1500, 2200, 3200, 4500]


def build_paint_tuned(photo):
    """Подбираем минимальный размер области, чтобы раскраска получилась не слишком мелкой и не слишком грубой."""
    best = None
    for area in AREA_STEPS:
        result = build_paint(photo, area)
        n = len(result[1]["regions"])
        if best is None or abs(n - 32) < abs(len(best[1]["regions"]) - 32):
            best = result
        if n <= MAX_REGIONS:
            break
    if len(best[1]["regions"]) < MIN_REGIONS and AREA_STEPS[0] > 150:
        for area in (300, 200):                       # слишком грубо: пробуем мельче
            result = build_paint(photo, area)
            if len(result[1]["regions"]) <= MAX_REGIONS:
                best = result
            if len(best[1]["regions"]) >= MIN_REGIONS:
                break
    return best


def main():
    prev = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
    keep = {c["id"] for c in CARDS}
    for name in os.listdir(OUT) if os.path.isdir(OUT) else []:     # старые папки (прежние остановки) не нужны
        if name not in keep:
            import shutil
            shutil.rmtree(os.path.join(OUT, name))
    counts = {}
    for card in CARDS:
        game = card["game"]
        counts[game] = counts.get(game, 0) + 1
        d = os.path.join(OUT, card["id"])
        if game in ("jigsaw", "quiz"):                # картинок не нужно; убираем то, что осталось от прежнего вида игры
            if os.path.isdir(d):
                import shutil
                shutil.rmtree(d)
            continue
        os.makedirs(d, exist_ok=True)
        photo = load_photo(card)
        if game == "pixel":
            build_pixel(photo).save(os.path.join(d, "pixel.png"), optimize=True)
            info = "pixel"
        else:
            png, meta, labels = build_paint_tuned(photo)
            png.save(os.path.join(d, "paint.png"), optimize=True)
            json.dump(meta, open(os.path.join(d, "paint.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            info = f"paint: областей {len(meta['regions'])}, цветов {len(meta['palette'])}"
            if prev:
                os.makedirs(prev, exist_ok=True)
                preview(labels, meta, os.path.join(prev, card["id"] + "_paint.png"))
        print(f"{card['id']:>4} {card['title'][:38]:38} {info}", flush=True)
    print("по видам:", counts)


if __name__ == "__main__":
    main()
