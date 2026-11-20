// Места вокруг маршрута: туалеты, площадки, кафе — по контракту GET /api/v1/map/places.
// Ручка читает PostgreSQL; формат — схема Place из openapi.json.
// Факты у мест: { state: 'known', value: true/false } или { state: 'unknown' } — «нет данных» ≠ «нет».

let places = [];
let evidence = new Map();

// Загружаем один раз: и карта, и «Сегодня», и «Помощник» ждут один и тот же запрос
let loading = null;
export function loadPlaces() {
  if (!loading) loading = fetchPlaces();
  return loading;
}
async function fetchPlaces() {
  try {
    const data = await fetchPlacesInRadius({ lon: 44.0066, lat: 56.3273, radiusKm: 5 });
    places = data.items;
    evidence = new Map(data.evidence.map(e => [e.evidence_id, e]));
  } catch (err) {
    console.warn('Места на карте недоступны:', err);
    places = [];
  }
  return places;
}
// Для произвольной точки/радиуса. Загружает все страницы; расстояние в ответе — по геодезической.
// Не подменяет общий набор карты. categories: ['toilet','pharmacy'] либо без фильтра.
export async function fetchPlacesInRadius({ lon, lat, radiusKm, categories, signal }) {
  const query = new URLSearchParams({ lon, lat, radius_km: radiusKm, limit: 1000 });
  if (categories) categories.forEach(c => query.append('categories', c));
  const result = { items: [], evidence: [], next_cursor: null, catalog_version: '' };
  const evidenceById = new Map();
  let cursor;
  do {
    if (cursor) query.set('cursor', cursor);
    const res = await fetch('/api/v1/map/places?' + query, { signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Инфраструктура: HTTP ' + res.status);
    result.items.push(...data.items);
    data.evidence.forEach(e => evidenceById.set(e.evidence_id, e));
    result.catalog_version = data.catalog_version;
    cursor = data.next_cursor;
  } while (cursor);
  result.evidence = [...evidenceById.values()];
  return result;
}
export const allPlaces = () => places;

// ---------- Расстояния ----------
export function distanceM(a, b) {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * k);
  return Math.hypot(x, b[1] - a[1]) * k * 6371000;
}
// Пешком с детьми ~3 км/ч = 50 м/мин; по прямой, поэтому «около»
export const walkMinutes = m => Math.max(1, Math.round(m * 1.3 / 50));

export const kindOf = p => p.categories.includes('toilet') ? 'toilets'
  : p.categories.includes('playground') ? 'playground'
  : p.categories.includes('park') ? 'park'
  : p.categories.includes('bench') ? 'bench'
  : p.categories.includes('pharmacy') ? 'pharmacy'
  : p.categories.includes('restaurant') ? 'cafe' : 'other';

// Ближайшие места нужного вида к точке
export function nearest(point, kind, count = 3, filter = () => true) {
  return places
    .filter(p => kindOf(p) === kind && filter(p))
    .map(p => ({ place: p, dist: distanceM(point, p.location.coordinates) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, count);
}

// ---------- Факты о кафе: плашки «детское меню», «детская зона»… ----------
const FACTS = [
  ['children_menu', 'детское меню'],
  ['play_area', 'детская зона'],
  ['small_portions', 'маленькие порции'],
];

// Список плашек: { text, state: 'yes' | 'no' | 'unknown' }
export function cafeBadges(p) {
  if (!p.restaurant) return [];
  return FACTS.map(([key, text]) => {
    const f = p.restaurant[key];
    return { text, state: f.state !== 'known' ? 'unknown' : f.value ? 'yes' : 'no' };
  });
}
export const isFamilyCafe = p => cafeBadges(p).some(b => b.state === 'yes');

// Данные, пришедшие из демо-заполнения (не проверены) — показываем значок «демо»
export function isDemo(p) {
  const facts = [p.indoor, p.toilet, p.shelter, p.seating, ...(p.restaurant ? Object.values(p.restaurant) : [])];
  return facts.some(f => f.evidence_ids.some(id => id.startsWith('ev-demo')));
}
export function sourceOf(p) {
  const ids = [p.toilet, ...(p.restaurant ? Object.values(p.restaurant) : [])].flatMap(f => f.evidence_ids);
  const e = ids.map(id => evidence.get(id)).find(Boolean);
  return e ? e.source_kind : null;
}
