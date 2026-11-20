// Каталог мест для карточек и «Тропы Маши»: frontend/data/cards.json (собирается scripts/build-frontend-cards.py
// из db/seed/main.csv). У каждого места есть фото (image) и вид задания тропы (game: jigsaw | pixel | paint).

let cards = [];
let byId = new Map();
let loading = null;

export function loadCards() {
  loading ??= fetch('data/cards.json')
    .then(r => { if (!r.ok) throw new Error('cards.json: HTTP ' + r.status); return r.json(); })
    .then(list => { cards = list; byId = new Map(list.map(c => [String(c.id), c])); return cards; });
  return loading;
}

export const allCards = () => cards;
export const cardById = id => byId.get(String(id));

// Расстояние между точками [долгота, широта] в метрах (для коротких расстояний хватает)
export function distanceM(a, b) {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * k);
  const y = b[1] - a[1];
  return Math.sqrt(x * x + y * y) * k * 6371000;
}

// Порядок обхода — «ближайший сосед» от точки from. Так места идут и на карте, и на тропе ребёнка.
export function orderByNearest(places, from) {
  const left = [...places];
  const ordered = [];
  let cur = from;
  while (left.length) {
    let best = 0;
    left.forEach((p, i) => { if (distanceM(cur, p.location) < distanceM(cur, left[best].location)) best = i; });
    const [next] = left.splice(best, 1);
    ordered.push(next);
    cur = next.location;
  }
  return ordered;
}
