// Экран «Карта» для родителя: маршрут дня по улицам, остановки, удобства рядом.

import { loadMapStyle } from './map-style.js';
import { loadDay } from './api.js';

const CENTER = [44.0066, 56.3273];   // площадь Минина и Пожарского, [долгота, широта]
const NEAR_ROUTE_M = 250;            // удобства показываем только в этой полосе вдоль маршрута
const sheetBody = document.getElementById('sheet-body');
let map = null;
let day = null;
let source = null;
let pins = [];          // маркеры остановок, по порядку
let selected = null;    // что открыто в карточке: null — сводка дня

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
const legToStop = stop => day.legs.find(l => l.to.stop_id === stop.stop_id);
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
  map.addSource('route', { type: 'geojson', data: legsGeoJSON(day.legs) });
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
  const start = document.createElement('div');
  start.className = 'start-pin';
  start.textContent = 'Старт';
  new maplibregl.Marker({ element: start, anchor: 'bottom-left' }).setLngLat(day.start_point.coordinates).addTo(map);

  pins = day.stops.map((stop, i) => {
    const el = document.createElement('button');
    el.className = 'stop-pin';
    el.textContent = i + 1;
    el.setAttribute('aria-label', `Остановка ${i + 1}: ${stop.title}`);
    el.addEventListener('click', e => { e.stopPropagation(); showStop(i); });
    return new maplibregl.Marker({ element: el }).setLngLat(stop.location.coordinates).addTo(map);
  });
}

// Удобства: берём из data/amenities.geojson только то, что рядом с маршрутом
async function addAmenities() {
  const all = await (await fetch('data/amenities.geojson')).json();
  const route = allRouteCoords().filter((_, i) => i % 3 === 0);   // каждой 3-й точки достаточно
  const near = all.features
    .map(f => ({ ...f, properties: { ...f.properties, near_m: Math.round(Math.min(...route.map(p => distanceM(p, f.geometry.coordinates)))) } }))
    .filter(f => f.properties.near_m <= NEAR_ROUTE_M);

  map.addSource('amenities', { type: 'geojson', data: { type: 'FeatureCollection', features: near } });
  for (const [kind, a] of Object.entries(AMENITIES)) {
    map.addImage('icon-' + kind, makeIcon(a.color, a.shape), { pixelRatio: 2 });
    const id = 'amenity-' + kind;
    // minzoom: на общем виде маршрута значки не показываем — иначе каша; появляются при приближении
    map.addLayer({ id, type: 'symbol', source: 'amenities', filter: ['==', ['get', 'kind'], kind], minzoom: 14.5,
      layout: { 'icon-image': 'icon-' + kind, 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 17, 1.2] } });
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

function showSummary() {
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
  sheetBody.querySelector('[data-act="first"]').onclick = () => showStop(0);
  showArea(allRouteCoords());
}

function showStop(i) {
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
  sheetBody.querySelector('[data-act="all"]').onclick = showSummary;
  map.resize();
  map.flyTo({ center: stop.location.coordinates, zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
}

// Карточка удобства — как «Туалет · 3 мин» на макете
function showAmenity(f) {
  selected = 'amenity';
  resetSelection();
  const p = f.properties;
  const a = AMENITIES[p.kind];
  const walkMin = Math.max(1, Math.round(p.near_m / 50));   // ~3 км/ч с детьми
  const details = [
    p.opening_hours && 'Часы: ' + p.opening_hours,
    p.fee === 'no' && 'Бесплатно', p.fee === 'yes' && 'Платно',
    p.changing_table === 'yes' && 'Есть пеленальный стол',
  ].filter(Boolean);
  sheetBody.innerHTML = `
    <div class="card plain">
      <h2><i class="dot ${p.kind}"></i>${escapeHtml(p.name || a.label)} · ~${walkMin} мин от маршрута</h2>
      ${details.length ? `<p>${details.map(escapeHtml).join(' · ')}</p>` : ''}
      <p class="small">По данным OpenStreetMap, на месте не проверено</p>
    </div>
    <button class="btn link" data-act="all">Назад к маршруту</button>`;
  sheetBody.querySelector('[data-act="all"]').onclick = showSummary;
  map.resize();
  map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 16), duration: 500 });
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

// ---------- Кнопки ----------
function bindChips() {
  const chips = [...document.querySelectorAll('.chip')];
  const apply = () => chips.forEach(c => {
    if (c.dataset.layer !== 'all') map.setLayoutProperty('amenity-' + c.dataset.layer, 'visibility', c.getAttribute('aria-pressed') === 'true' ? 'visible' : 'none');
  });
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

// ---------- Запуск ----------
export async function initMap(tripInput) {
  const [style, loaded] = await Promise.all([loadMapStyle(), loadDay(tripInput)]);
  day = loaded.day;
  source = loaded.source;

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
    map.on('click', e => { if (selected !== null && !e.defaultPrevented) showSummary(); });
    addPins();
    bindChips();
    bindMapButtons();
    showSummary();
  });
}

// Когда возвращаемся на вкладку «Карта», карте нужно пересчитать размер
export function resizeMap() { if (map) map.resize(); }
