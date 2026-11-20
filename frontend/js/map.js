// Экран «Карта» для родителя: маршрут дня по улицам, остановки, удобства рядом.

import { loadMapStyle } from './map-style.js';
import { onTripChange, today, getSource } from './api.js';
import { loadPlaces, allPlaces, kindOf, cafeBadges, isFamilyCafe, isDemo, walkMinutes } from './places.js';

const CENTER = [44.0066, 56.3273];   // площадь Минина и Пожарского, [долгота, широта]
const NEAR_ROUTE_M = 250;            // удобства показываем только в этой полосе вдоль маршрута
const sheetBody = document.getElementById('sheet-body');
let map = null;
let day = null;
let source = null;
let pins = [];          // маркеры остановок, по порядку
let startPin = null;
let mapReady = false;
let selected = null;    // что открыто в карточке: null — сводка дня
let picked = null;      // выбранные на экране «Подбор мест» (в порядке обхода) или null
let pendingPicked;      // выбор, пришедший до загрузки карты
let pickedPins = [];

// ---------- Форматирование ----------
const fmtDistance = m => m < 1000 ? Math.round(m / 10) * 10 + ' м' : (m / 1000).toFixed(1).replace('.', ',') + ' км';
function fmtDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' мин';
  return Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
}
// plural(3, 'остановка', 'остановки', 'остановок') → «3 остановки»
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return n + ' ' + word;
}
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Расстояние между точками [долгота, широта] в метрах (для коротких расстояний хватает)
function distanceM(a, b) {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * k);
  const y = b[1] - a[1];
  return Math.sqrt(x * x + y * y) * k * 6371000;
}

// ---------- Данные маршрута → GeoJSON ----------
// Бекенд отдаёт координаты как [долгота, широта] — MapLibre ждёт так же, переставлять не нужно.

// Скругление углов линии (алгоритм Чайкина): ломаная по улицам становится плавной.
// Только для красоты — путь остаётся по тем же улицам.
function smooth(coords, rounds = 2) {
  let pts = coords;
  for (let r = 0; r < rounds; r++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function legsGeoJSON(legs) {
  return {
    type: 'FeatureCollection',
    features: legs.filter(l => l.geometry).map(l => ({
      type: 'Feature', properties: { leg_id: l.leg_id },
      geometry: { type: 'LineString', coordinates: smooth(l.geometry.coordinates) },
    })),
  };
}
// После пересчёта у остановки может появиться новый переход — берём последний
const legToStop = stop => [...day.legs].reverse().find(l => l.to.stop_id === stop.stop_id);
const allRouteCoords = () => day.legs.flatMap(l => l.geometry ? l.geometry.coordinates : []);

function boundsOf(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach(c => b.extend(c));
  return b;
}

// Отступы при показе маршрута: справа — кнопки 3D и «где я»
const PADDING = { top: 50, bottom: 40, left: 40, right: 70 };
function showArea(coords) {
  map.resize();   // карточка снизу могла поменять высоту — карта должна это узнать
  map.fitBounds(boundsOf(coords), { padding: PADDING, pitch: map.getPitch(), duration: 600 });
}

// ---------- Значки удобств (рисуем сами, как на макете) ----------
const AMENITIES = {
  toilets:    { label: 'Туалет',           color: '#1F8A4F', shape: 'square' },
  cafe:       { label: 'Еда',              color: '#FFC94A', shape: 'circle' },
  playground: { label: 'Детская площадка', color: '#E8641F', shape: 'circle' },
};

function makeIcon(color, shape) {
  const size = 44;                     // рисуем в 2 раза крупнее — чётко на телефонах
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = 6;
  g.shadowColor = 'rgba(0,0,0,.25)';
  g.shadowBlur = 4;
  g.beginPath();
  if (shape === 'square') g.roundRect(8, 8, 28, 28, 8);
  else g.arc(22, 22, 14, 0, Math.PI * 2);
  g.stroke();
  g.shadowBlur = 0;
  g.fill();
  return g.getImageData(0, 0, size, size);
}

// ---------- Слои на карте ----------
function addKremlin() {
  // Кремль — главный кирпичный акцент Нижнего (контур из OpenStreetMap)
  map.addSource('kremlin', { type: 'geojson', data: 'data/kremlin.geojson' });
  map.addLayer({ id: 'kremlin-fill', type: 'fill', source: 'kremlin',
    paint: { 'fill-color': '#C4553A', 'fill-opacity': 0.55 } }, 'building-3d');
  map.addLayer({ id: 'kremlin-wall', type: 'line', source: 'kremlin',
    paint: { 'line-color': '#B4452C', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2, 17, 6] } }, 'building-3d');
  map.addLayer({ id: 'kremlin-label', type: 'symbol', source: 'kremlin', maxzoom: 16,
    layout: { 'text-field': 'Кремль', 'text-font': ['Noto Sans Bold'], 'text-size': 14 },
    paint: { 'text-color': '#8E2F1C', 'text-halo-color': '#FFFFFF', 'text-halo-width': 2 } });
}

function addRouteLayers() {
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // Мягкая светлая «дорожка» под маршрутом
  map.addLayer({ id: 'route-glow', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 10, 17, 18], 'line-opacity': 0.8, 'line-blur': 3 } });
  // Сам маршрут — крупные круглые точки, как на макетах
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2463D6', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 9], 'line-dasharray': [0.1, 2.2] } });
  // Выделенный переход «Как дойти» — сплошной
  map.addLayer({ id: 'route-active', type: 'line', source: 'route', filter: ['==', ['get', 'leg_id'], ''],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2463D6', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 17, 9] } });
}

function addPins() {
  // Перерисовываем с нуля: после отметок и пропусков список остановок меняется
  pins.forEach(p => p.remove());
  if (startPin) startPin.remove();
  const start = document.createElement('div');
  start.className = 'start-pin';
  start.textContent = 'Старт';
  startPin = new maplibregl.Marker({ element: start, anchor: 'bottom-left' }).setLngLat(day.start_point.coordinates).addTo(map);

  pins = day.stops.map((stop, i) => {
    const el = document.createElement('button');
    const visited = stop.progress === 'visited';
    el.className = 'stop-pin' + (visited ? ' done' : '');
    el.textContent = visited ? '✓' : i + 1;
    el.setAttribute('aria-label', `Остановка ${i + 1}: ${stop.title}`);
    el.addEventListener('click', e => { e.stopPropagation(); showStop(i); });
    return new maplibregl.Marker({ element: el }).setLngLat(stop.location.coordinates).addTo(map);
  });
}

// Удобства: места из /api/v1/map/places — только то, что рядом с маршрутом
function amenitiesNearRoute() {
  const route = allRouteCoords().filter((_, i) => i % 3 === 0);   // каждой 3-й точки достаточно
  if (!route.length) return { type: 'FeatureCollection', features: [] };
  // Места из /api/v1/map/places → точки для карты; у кафе с детскими фактами — флаг family (подпись на карте)
  const near = allPlaces()
    .map(p => ({ p, near_m: Math.round(Math.min(...route.map(r => distanceM(r, p.location.coordinates)))) }))
    .filter(x => x.near_m <= NEAR_ROUTE_M && kindOf(x.p) !== 'other')
    .map(({ p, near_m }) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.location.coordinates },
      properties: { place_id: p.place_id, kind: kindOf(p), name: p.name, near_m, family: isFamilyCafe(p) } }));
  return { type: 'FeatureCollection', features: near };
}

async function addAmenities() {
  await loadPlaces();
  map.addSource('amenities', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  for (const [kind, a] of Object.entries(AMENITIES)) {
    map.addImage('icon-' + kind, makeIcon(a.color, a.shape), { pixelRatio: 2 });
    const id = 'amenity-' + kind;
    // minzoom: на общем виде маршрута значки не показываем — иначе каша; появляются при приближении
    map.addLayer({ id, type: 'symbol', source: 'amenities', filter: ['==', ['get', 'kind'], kind], minzoom: 14.5,
      layout: {
        'icon-image': 'icon-' + kind, 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 17, 1.2],
        // Кафе для детей — с названием прямо на карте, чтобы не протыкивать все точки
        'text-field': ['case', ['get', 'family'], ['get', 'name'], ''],
        'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#7A5200', 'text-halo-color': '#FFFFFF', 'text-halo-width': 2 } });
    map.on('click', id, e => { e.preventDefault(); showAmenity(e.features[0]); });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ---------- Нижняя карточка ----------
function resetSelection() {
  pins.forEach(p => p.getElement().classList.remove('sel'));
  map.setFilter('route-active', ['==', ['get', 'leg_id'], '']);
}

function showSummary({ fit = true } = {}) {
  selected = null;
  resetSelection();
  const t = day.totals;
  const notes = [...day.assumptions, ...new Set(day.warnings.map(w => w.message))];
  sheetBody.innerHTML = `
    <button class="card now card-btn" data-act="first">
      <span>
        <span class="kicker">${escapeHtml(fmtDate(day.date))}</span>
        <h2>Маршрут дня</h2>
        <p>${plural(day.stops.length, 'остановка', 'остановки', 'остановок')} · ${fmtDistance(t.walk_distance_m)} · ${fmtDuration(t.elapsed_duration_sec)}</p>
      </span>
      <span class="go" aria-hidden="true">›</span>
    </button>
    <details class="notes">
      <summary>${day.feasibility === 'infeasible' ? '⚠️ Маршрут не помещается в день' : 'Маршрут предварительный — что учтено'}</summary>
      <ul>${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
    </details>
    ${sourceNote()}`;
  // К следующей непройденной остановке
  sheetBody.querySelector('[data-act="first"]').onclick = () => showStop(Math.max(0, day.stops.findIndex(st => st.progress === 'planned')));
  if (fit) showArea(allRouteCoords());
}

function showStop(i, { fly = true } = {}) {
  selected = i;
  resetSelection();
  const stop = day.stops[i];
  const leg = legToStop(stop);
  pins[i].getElement().classList.add('sel');
  sheetBody.innerHTML = `
    <div class="card now">
      <div class="kicker">Остановка ${i + 1} из ${day.stops.length}</div>
      <h2>${escapeHtml(stop.title)}</h2>
      <p>${leg ? `${fmtDuration(leg.travel_duration_sec)} пешком · ${fmtDistance(leg.distance_m)} · ` : ''}на месте ~${fmtDuration(stop.duration.duration_sec)}</p>
    </div>
    <div class="row">
      <button class="btn icon alt" data-act="prev" aria-label="Предыдущая остановка" ${i === 0 ? 'disabled' : ''}>‹</button>
      <button class="btn main" data-act="go">Как дойти</button>
      <button class="btn icon alt" data-act="next" aria-label="Следующая остановка" ${i === day.stops.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <button class="btn link" data-act="all">Весь маршрут</button>`;
  sheetBody.querySelector('[data-act="go"]').onclick = () => showLeg(leg);
  sheetBody.querySelector('[data-act="prev"]').onclick = () => showStop(i - 1);
  sheetBody.querySelector('[data-act="next"]').onclick = () => showStop(i + 1);
  sheetBody.querySelector('[data-act="all"]').onclick = () => showSummary();
  map.resize();
  if (fly) map.flyTo({ center: stop.location.coordinates, zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
}

// Карточка удобства — как «Туалет · 3 мин» на макете
function showAmenity(f) {
  const place = allPlaces().find(p => p.place_id === f.properties.place_id);
  if (place) showPlace(place, f.properties.near_m);
}

// Карточка места: как «Туалет · 3 мин» на макете + детские факты у кафе
function showPlace(place, nearM) {
  selected = 'amenity';
  resetSelection();
  const kind = kindOf(place);
  const badges = cafeBadges(place).map(b =>
    `<span class="badge ${b.state}">${b.state === 'yes' ? '✓ ' : b.state === 'no' ? '✕ ' : ''}${b.text}${b.state === 'unknown' ? ': нет данных' : ''}</span>`);
  if (isDemo(place)) badges.push('<span class="badge demo">демо-данные</span>');
  const label = { toilets: 'Туалет', playground: 'Детская площадка', cafe: 'Кафе' }[kind];
  sheetBody.innerHTML = `
    <div class="card plain">
      <h2><i class="dot ${kind}"></i>${escapeHtml(place.name)}${nearM !== undefined ? ` · ~${walkMinutes(nearM)} мин от маршрута` : ''}</h2>
      ${place.name !== label ? `<p>${label}</p>` : ''}
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      <p class="small">${isDemo(place) ? 'Детские факты — демо-заполнение, не проверены' : 'По данным OpenStreetMap, на месте не проверено'}</p>
    </div>
    <button class="btn link" data-act="all">Назад к маршруту</button>`;
  sheetBody.querySelector('[data-act="all"]').onclick = () => showSummary();
  map.resize();
  map.flyTo({ center: place.location.coordinates, zoom: Math.max(map.getZoom(), 16), duration: 500 });
}

// Открыть место из «Помощника»: включить его слой и показать карточку
export function focusPlace(place) {
  if (!mapReady) return;
  const kind = kindOf(place);
  const chip = document.querySelector(`.chip[data-layer="${kind}"]`);
  if (chip && chip.getAttribute('aria-pressed') !== 'true') chip.click();
  showPlace(place);
}

// «Как дойти»: выделяем путь к остановке и показываем его целиком
function showLeg(leg) {
  if (!leg || !leg.geometry) return;
  map.setFilter('route-active', ['==', ['get', 'leg_id'], leg.leg_id]);
  showArea(leg.geometry.coordinates);
}

// Подписи источников обязательны по лицензиям — даём их текстом
function sourceNote() {
  const credits = 'Карта © OpenFreeMap, OpenMapTiles, участники OpenStreetMap';
  return source === 'backend'
    ? `<p class="source">${credits}</p>`
    : `<p class="source warn">Сервер недоступен — показан сохранённый маршрут. ${credits}</p>`;
}

// ---------- Маршрут из выбранных мест (экран «Подбор мест») ----------
// Порядок обхода — «ближайший сосед» от точки старта. Линии пока прямые: маршрут по улицам
// строит backend, сюда он ещё не подключён.
function orderByNearest(places, from) {
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

const PICKED_LAYERS = ['route-glow', 'route-line', 'route-active'];

// places — массив выбранных карточек; null — вернуть исходный маршрут дня.
export function showPicked(places) {
  pendingPicked = places;
  if (mapReady) applyPicked(places);
}

function applyPicked(places) {
  pendingPicked = undefined;
  pickedPins.forEach(m => m.remove());
  pickedPins = [];
  const hasPicks = !!(places && places.length);
  document.querySelector('.sheet').classList.toggle('picked', hasPicks);
  PICKED_LAYERS.forEach(id => map.setLayoutProperty(id, 'visibility', hasPicks ? 'none' : 'visible'));
  pins.forEach(p => { p.getElement().style.display = hasPicks ? 'none' : ''; });
  if (map.getLayer('picked-line')) {
    map.removeLayer('picked-glow'); map.removeLayer('picked-line'); map.removeSource('picked');
  }
  if (!hasPicks) {
    picked = null;
    applyChips();
    showSummary();
    return;
  }
  const from = day.start_point.coordinates;
  picked = orderByNearest(places, from);
  const path = [from, ...picked.map(p => p.location)];
  map.addSource('picked', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path } } });
  map.addLayer({ id: 'picked-glow', type: 'line', source: 'picked', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 10, 17, 18], 'line-opacity': 0.8, 'line-blur': 3 } });
  map.addLayer({ id: 'picked-line', type: 'line', source: 'picked', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#2463D6', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 7], 'line-dasharray': [1.2, 1.6] } });
  pickedPins = picked.map((place, i) => {
    const pin = document.createElement('button');
    pin.className = 'stop-pin';
    pin.textContent = i + 1;
    pin.setAttribute('aria-label', `Место ${i + 1}: ${place.title}`);
    pin.addEventListener('click', e => { e.stopPropagation(); showPickedPlace(i); });
    return new maplibregl.Marker({ element: pin }).setLngLat(place.location).addTo(map);
  });
  applyChips();
  showPickedSummary();
}

// Расстояния по прямой: от старта к первому месту, дальше от места к месту
function pickedLegs() {
  let cur = day.start_point.coordinates;
  return picked.map(p => { const d = distanceM(cur, p.location); cur = p.location; return d; });
}

function pickedButtons() {
  return `<div class="row">
      <button class="btn main" data-act="more">Подобрать ещё</button>
      <button class="btn alt" data-act="reset">Сбросить</button>
    </div>`;
}
function bindPickedButtons() {
  sheetBody.querySelector('[data-act="more"]').onclick = () => document.dispatchEvent(new Event('pick:open'));
  sheetBody.querySelector('[data-act="reset"]').onclick = () => document.dispatchEvent(new Event('pick:reset'));
}

function showPickedSummary() {
  selected = null;
  pickedPins.forEach(m => m.getElement().classList.remove('sel'));
  const legs = pickedLegs();
  const total = legs.reduce((a, b) => a + b, 0);
  sheetBody.innerHTML = `
    <div class="card now">
      <span class="kicker">Ваш маршрут</span>
      <h2>${plural(picked.length, 'место', 'места', 'мест')} · ≈ ${fmtDistance(total)}</h2>
      <p class="small">Расстояние по прямой. Маршрут по улицам пока не построен.</p>
    </div>
    <ol class="picked-list">${picked.map((p, i) => `
      <li><button data-i="${i}">
        <span class="num">${i + 1}</span>
        <img src="${escapeHtml(p.image.thumb)}" alt="" loading="lazy">
        <span class="t">${escapeHtml(p.title)}<br><span class="d">${fmtDistance(legs[i])} ${i === 0 ? 'от старта' : 'от предыдущего'}</span></span>
      </button></li>`).join('')}
    </ol>
    ${pickedButtons()}
    <p class="source">Карта © OpenFreeMap, OpenMapTiles, участники OpenStreetMap</p>`;
  sheetBody.querySelectorAll('.picked-list button').forEach(b => { b.onclick = () => showPickedPlace(Number(b.dataset.i)); });
  bindPickedButtons();
  showArea([day.start_point.coordinates, ...picked.map(p => p.location)]);
}

function showPickedPlace(i) {
  selected = 'picked';
  pickedPins.forEach((m, k) => m.getElement().classList.toggle('sel', k === i));
  const p = picked[i];
  const d = pickedLegs()[i];
  sheetBody.innerHTML = `
    <img class="picked-photo" src="${escapeHtml(p.image.card)}" alt="${escapeHtml(p.image.alt || p.title)}">
    <div class="card now">
      <div class="kicker">Место ${i + 1} из ${picked.length}</div>
      <h2>${escapeHtml(p.title)}</h2>
      <p>${escapeHtml(p.address)} · ${fmtDistance(d)} по прямой</p>
    </div>
    <div class="row">
      <button class="btn icon alt" data-act="prev" aria-label="Предыдущее место" ${i === 0 ? 'disabled' : ''}>‹</button>
      <button class="btn main" data-act="all">Весь маршрут</button>
      <button class="btn icon alt" data-act="next" aria-label="Следующее место" ${i === picked.length - 1 ? 'disabled' : ''}>›</button>
    </div>`;
  sheetBody.querySelector('[data-act="prev"]').onclick = () => showPickedPlace(i - 1);
  sheetBody.querySelector('[data-act="next"]').onclick = () => showPickedPlace(i + 1);
  sheetBody.querySelector('[data-act="all"]').onclick = showPickedSummary;
  map.resize();
  map.flyTo({ center: p.location, zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
}

// ---------- Кнопки ----------
function applyChips() {
  document.querySelectorAll('.chip').forEach(c => {
    if (c.dataset.layer === 'all') return;
    // Пока показан маршрут из выбранных мест, удобства вдоль старого маршрута не нужны
    const on = !picked && c.getAttribute('aria-pressed') === 'true';
    map.setLayoutProperty('amenity-' + c.dataset.layer, 'visibility', on ? 'visible' : 'none');
  });
}

function bindChips() {
  const chips = [...document.querySelectorAll('.chip')];
  const apply = applyChips;
  chips.forEach(chip => chip.addEventListener('click', () => {
    if (chip.dataset.layer === 'all') {
      // «Всё семейное» включает всё; повторное нажатие — выключает
      const on = chip.getAttribute('aria-pressed') !== 'true';
      chips.forEach(c => c.setAttribute('aria-pressed', on));
    } else {
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
      const allOn = chips.filter(c => c.dataset.layer !== 'all').every(c => c.getAttribute('aria-pressed') === 'true');
      chips.find(c => c.dataset.layer === 'all').setAttribute('aria-pressed', allOn);
    }
    apply();
  }));
  apply();
}

function bindMapButtons() {
  const btn3d = document.getElementById('btn-3d');
  btn3d.classList.add('on');
  btn3d.addEventListener('click', () => {
    const is3d = map.getPitch() > 0;
    map.easeTo({ pitch: is3d ? 0 : 35, duration: 500 });
    btn3d.classList.toggle('on', !is3d);
  });

  let me = null;
  document.getElementById('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Браузер не умеет определять местоположение');
    navigator.geolocation.getCurrentPosition(pos => {
      const here = [pos.coords.longitude, pos.coords.latitude];
      if (!me) {
        const el = document.createElement('div');
        el.className = 'me-pin';
        me = new maplibregl.Marker({ element: el }).setLngLat(here).addTo(map);
      } else me.setLngLat(here);
      map.flyTo({ center: here, zoom: 16 });
    }, err => alert('Не удалось определить местоположение: ' + err.message), { enableHighAccuracy: true, timeout: 10000 });
  });
}

// ---------- Перерисовка при изменении поездки ----------
function render({ fit }) {
  day = today();
  source = getSource();
  if (!day) return;
  // Кнопка дня — по дате поездки (Пт, Сб…), а не зашитая «Сб»
  const dayBtn = document.querySelector('.days button');
  dayBtn.textContent = new Date(day.date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'short' }).replace(/^./, c => c.toUpperCase());
  if (!mapReady) return;
  map.getSource('route').setData(legsGeoJSON(day.legs));
  map.getSource('amenities').setData(amenitiesNearRoute());
  addPins();
  // Пока на карте маршрут из выбранных карточек — обычные точки дня прячем, вид не меняем
  if (picked) { pins.forEach(p => { p.getElement().style.display = 'none'; }); return; }
  // Первый показ — подгоняем карту под маршрут; при отметках камеру не дёргаем
  if (fit || selected === null) showSummary({ fit });
  else if (typeof selected === 'number' && day.stops[selected]) showStop(selected, { fly: false });
}

// ---------- Запуск ----------
export async function initMap() {
  const style = await loadMapStyle();
  map = new maplibregl.Map({
    container: 'map', style, center: CENTER, zoom: 14, pitch: 35,
    attributionControl: false,   // источники подписаны текстом в карточке
  });
  map.on('load', async () => {
    addKremlin();
    addRouteLayers();
    await addAmenities();
    // Нажатие на пустое место карты — назад к сводке. Регистрируем после слоёв удобств,
    // чтобы нажатие на значок (он вызывает preventDefault) сюда не доходило.
    map.on('click', e => { if (selected !== null && !e.defaultPrevented) (picked ? showPickedSummary() : showSummary({ fit: true })); });
    bindChips();
    bindMapButtons();
    mapReady = true;
    render({ fit: true });
    if (pendingPicked !== undefined) applyPicked(pendingPicked);
  });
  onTripChange(() => render({ fit: false }));
}

// Когда возвращаемся на вкладку «Карта», карте нужно пересчитать размер
export function resizeMap() { if (map) map.resize(); }
