// Места вокруг маршрута: туалеты, площадки, кафе — по контракту GET /api/v1/map/places.
// Ручка читает PostgreSQL; формат — схема Place из openapi.json.
// Факты у мест: { state: 'known', value: true/false } или { state: 'unknown' } — «нет данных» ≠ «нет».

let places = [];
let evidence = new Map();
let nearbyBenches = [];
let benchEvidence = new Map();
let benchGeneration = 0;
let benchController = null;
export const BENCH_RADIUS_M = 125;
let types = {};
let typesLoading = null;
export function loadPlaceTypes() {
  if (!typesLoading) typesLoading = fetch('data/place-types.json')
    .then(r => { if (!r.ok) throw new Error('place-types unavailable'); return r.json(); })
    .then(value => { types = value; notify(); })
    .catch(() => { types = {}; });
  return typesLoading;
}
const listeners = [];
export const onPlacesChange = fn => listeners.push(fn);
const notify = () => listeners.forEach(fn => fn());
let generation = 0;
let controller = null;
let routeKey = null;

// До появления сохранённого маршрута инфраструктура пуста. Центр GPS не используется.
let loading = null;
export function loadPlaces() {
  return loading || Promise.resolve(places);
}
export function clearRoutePlaces() {
  generation++;
  controller?.abort();
  controller = null; routeKey = null; loading = null;
  places = []; evidence = new Map(); notify();
}
export function loadRoutePlaces(trip, day = trip.days[0]) {
  const key = `${trip.trip_id}:${trip.version}:${day.date}`;
  if (routeKey === key && loading) return loading;
  clearRoutePlaces();
  routeKey = key;
  const requestGeneration = generation;
  controller = new AbortController();
  loading = fetchPlacesAlongRoute({ tripId: trip.trip_id, version: trip.version, date: day.date, categories:['toilet','playground','park','pharmacy','restaurant'], signal: controller.signal })
    .then(data => {
      if (requestGeneration !== generation) return places;
      places = data.items;
      evidence = new Map(data.evidence.map(e => [e.evidence_id, e]));
      notify(); return places;
    }).catch(err => {
      if (requestGeneration !== generation || err.name === 'AbortError') return places;
      routeKey = null; loading = null;
      console.warn('Инфраструктура вдоль маршрута недоступна:', err);
      throw err;
    });
  return loading;
}

export async function fetchPlacesAlongRoute({ tripId, version, date, categories, signal }) {
  const query = new URLSearchParams({ date, expected_version: version, buffer_m: 125, limit: 1000 });
  if (categories) categories.forEach(c => query.append('categories', c));
  const result = { items: [], evidence: [], next_cursor: null, catalog_version: '' };
  const evidenceById = new Map();
  let cursor;
  do {
    if (cursor) query.set('cursor', cursor);
    const res = await fetch(`/api/v1/trips/${encodeURIComponent(tripId)}/map/places?` + query, { signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Инфраструктура: HTTP ' + res.status);
    if (data.route_version !== version || data.route_date !== date) throw new Error('Маршрут изменился во время загрузки инфраструктуры');
    result.items.push(...data.items);
    data.evidence.forEach(e => evidenceById.set(e.evidence_id, e));
    result.catalog_version = data.catalog_version;
    cursor = data.next_cursor;
  } while (cursor);
  result.evidence = [...evidenceById.values()];
  return result;
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
// No distance cutoff: request the closest published objects across the catalog.
export async function fetchNearestPlaces({lon,lat,categories,count=3,accept=()=>true,signal}) {
  const query=new URLSearchParams({lon,lat,nearest:true,limit:count});
  categories.forEach(c=>query.append('categories',c));
  const result={items:[],evidence:[]};
  const seen=new Set(),cursors=new Set();
  do {
    const response=await fetch('/api/v1/map/places?'+query,{signal});
    const data=await response.json();
    if(!response.ok)throw Error(data.error?.message || 'Инфраструктура: HTTP '+response.status);
    for(const place of data.items){if(!seen.has(place.place_id)&&accept(place)){seen.add(place.place_id);result.items.push(place);}}
    result.evidence.push(...data.evidence);
    if(result.items.length>=count || !data.next_cursor || cursors.has(data.next_cursor))break;
    cursors.add(data.next_cursor);
    query.set('cursor',data.next_cursor);
  } while(true);
  result.items=result.items.slice(0,count);return result;
}
// Benches use GPS only: never substitute a route, hotel or map centre.
export const allPlaces = () => [...places.filter(p => !p.categories?.includes('bench')), ...nearbyBenches];
export function clearNearbyBenches() {
  benchGeneration++;
  benchController?.abort();
  nearbyBenches = []; benchEvidence = new Map(); notify();
}
export async function loadNearbyBenches(point) {
  clearNearbyBenches();
  const requestGeneration = benchGeneration;
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return;
  benchController = new AbortController();
  try {
    const data = await fetchPlacesInRadius({lon:point[0],lat:point[1],radiusKm:BENCH_RADIUS_M/1000,categories:['bench'],signal:benchController.signal});
    if (requestGeneration !== benchGeneration) return;
    nearbyBenches = data.items.filter(p => p.categories.includes('bench') && distanceM(point,p.location.coordinates) <= BENCH_RADIUS_M)
      .map(p => ({...p,distance_to_route_m:null,distance_m:distanceM(point,p.location.coordinates)}));
    benchEvidence = new Map(data.evidence.map(e => [e.evidence_id,e]));
    notify(); return nearbyBenches;
  } catch (err) {
    if (requestGeneration !== benchGeneration || err.name === 'AbortError') return;
    throw err;
  }
}

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
  return allPlaces()
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
  const e = ids.map(id => evidence.get(id) || benchEvidence.get(id)).find(Boolean);
  return e ? e.source_kind : null;
}

// Тип заведения, как подпись в Яндекс Картах: «кофейня», «грузинская кухня»…
// place_id из базы — свой номер; связь с OSM — через ссылку-источник (evidence map-source-<id>)
function osmKey(p) {
  const url = (evidence.get('map-source-' + p.place_id) || benchEvidence.get('map-source-' + p.place_id))?.source_url || '';
  const m = url.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/);
  return m ? `osm-${m[1]}-${m[2]}` : p.place_id;
}
export const placeType = p => types[osmKey(p)] || null;
