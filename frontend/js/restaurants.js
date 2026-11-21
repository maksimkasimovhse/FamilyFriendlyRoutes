import { getTrip, getSource, today, onTripChange, recommendRestaurants, previewAddRestaurant, applyPreview } from './api.js';
import { loadMapStyle } from './map-style.js';

const $ = id => document.getElementById(id);
const FILTER_LABELS = {
  high_chairs: 'Детский стульчик',
  children_menu: 'Детское меню',
  play_area: 'Игровая зона',
  small_portions: 'Маленькие порции',
  play_area_supervision: 'Есть присмотр',
  toilet: 'Туалет',
};
let initialized = false;
let selectedDate = null;
let loadedKey = null;
let candidates = [];
let requestNumber = 0;
let mapWidgetRequest = 0;
let mapCandidates = [];
let mapSelectedIndex = 0;
let miniMap = null;
let miniMapReady = false;
let mapFilters = {};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const known = fact => fact?.state === 'known';
const facilityFact = (place, key) => key === 'toilet' ? place.toilet : (place.restaurant || {})[key];
export function restaurantBadges(place) {
  return Object.entries(FILTER_LABELS).map(([key, label]) => ({
    key, label, state: !known(facilityFact(place, key)) ? 'unknown' : facilityFact(place, key).value ? 'yes' : 'no',
  }));
}
export function candidateMatchesFilters(candidate, filters) {
  const badges = new Map(restaurantBadges(candidate.place).map(badge => [badge.key, badge.state]));
  return Object.entries(filters).every(([key, required]) => !required || badges.get(key) === 'yes');
}
export function restaurantCardModel(candidate) {
  const place = candidate.place;
  const cuisine = place.restaurant?.cuisine || [];
  return {
    title: place.name || candidate.activity.title,
    address: place.address || place.location?.label || '',
    description: place.description || candidate.reasons?.[0]?.message || '',
    distance: Number.isFinite(place.distance_m) ? `${Math.round(place.distance_m)} м` : '',
    cuisine: cuisine.join(', '),
    openingHours: place.opening_hours_raw || '',
    badges: restaurantBadges(place).filter(badge => badge.state !== 'no'),
  };
}
export function mapRestaurantWidgetModel(candidate) {
  const card = restaurantCardModel(candidate);
  const familyFeature = card.badges.find(badge => badge.state === 'yes');
  return {
    title: card.title,
    detail: [card.distance, familyFeature?.label].filter(Boolean).join(' · ') || 'Подходит для семейного обеда',
  };
}
export function cardSwipeAction(offsetX, threshold = 72) {
  if (Math.abs(offsetX) >= threshold) return 'skip';
  return null;
}
function dateLabel(iso) {
  return new Intl.DateTimeFormat('ru-RU', { weekday:'short', day:'numeric', month:'short', timeZone:'Europe/Moscow' }).format(new Date(iso + 'T12:00:00+03:00'));
}
function activeFilters() {
  return Object.fromEntries([...$('restaurants-filters').querySelectorAll('[aria-pressed="true"]')].map(button => [button.dataset.filter, true]));
}
function renderDays(trip) {
  if (!selectedDate || !trip.days.some(day => day.date === selectedDate)) selectedDate = today()?.date || trip.days[0]?.date;
  $('restaurants-days').innerHTML = trip.days.map(day => `<button type="button" role="tab" data-date="${esc(day.date)}" aria-selected="${day.date === selectedDate}">${esc(dateLabel(day.date))}</button>`).join('');
}
function renderCards() {
  $('restaurants-list').innerHTML = candidates.map((candidate, index) => {
    const card = restaurantCardModel(candidate);
    const meta = [card.distance, card.cuisine, card.openingHours].filter(Boolean).join(' · ');
    return `<article class="restaurant-card">
      <div class="restaurant-card-head"><img class="restaurant-card-icon" src="/assets/category-icons/food.svg" alt=""><div><h2>${esc(card.title)}</h2><p class="meta">${esc(card.address)}</p></div></div>
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      ${card.description ? `<p class="description">${esc(card.description)}</p>` : ''}
      <div class="restaurant-badges">${card.badges.map(badge => `<span class="restaurant-badge ${badge.state}">${esc(badge.label)}${badge.state === 'unknown' ? ': нет данных' : ''}</span>`).join('')}</div>
      <button type="button" class="btn" data-add="${index}">Добавить в маршрут</button>
    </article>`;
  }).join('');
}
function status(message, error = false) {
  $('restaurants-status').textContent = message;
  $('restaurants-status').classList.toggle('error', error);
}
async function loadRestaurants(force = false) {
  const trip = getTrip();
  if (!trip || getSource() !== 'backend') {
    candidates = []; renderCards(); status('Рестораны доступны после загрузки сохранённой поездки с сервера.', true); return;
  }
  renderDays(trip);
  const filters = activeFilters();
  const key = JSON.stringify([trip.trip_id, trip.version, selectedDate, filters]);
  if (!force && key === loadedKey) return;
  const current = ++requestNumber;
  status('Ищем подходящие места…');
  $('restaurants-list').innerHTML = '';
  try {
    const result = await recommendRestaurants({ date:selectedDate, filters });
    if (current !== requestNumber) return;
    candidates = result.candidates || [];
    loadedKey = key;
    renderCards();
    status(candidates.length ? `Найдено: ${candidates.length}` : 'Подходящих ресторанов рядом не найдено. Попробуйте убрать фильтры.');
  } catch (error) {
    if (current !== requestNumber) return;
    candidates = []; renderCards(); status(error.message || 'Не удалось загрузить рестораны.', true);
  }
}
function renderMapWidget() {
  const widget = $('map-restaurant-widget');
  widget.hidden = false;
  widget.onclick = openMapRestaurantDialog;
}
async function loadMapWidget() {
  const trip = getTrip();
  if (!trip || getSource() !== 'backend') { $('map-restaurant-widget').hidden = true; return; }
  renderMapWidget();
  const request = ++mapWidgetRequest;
  try {
    const results = await Promise.all(trip.days.map(async day => ({
      date: day.date,
      result: await recommendRestaurants({ date: day.date, limit: 50 }),
    })));
    if (request !== mapWidgetRequest) return;
    const unique = new Map();
    results.flatMap(({date, result}) => (result.candidates || []).map(candidate => ({ ...candidate, recommended_date:date })))
      .forEach(candidate => { if (!unique.has(candidate.place.place_id)) unique.set(candidate.place.place_id, candidate); });
    mapCandidates = [...unique.values()].filter(candidate => candidateMatchesFilters(candidate, mapFilters)).slice(0, 30);
    mapSelectedIndex = 0;
    renderMapWidget();
    if ($('restaurant-map-dialog').open) { renderMapDialog(); updateMiniMap(); }
  } catch { if (request === mapWidgetRequest && $('restaurant-map-dialog').open) renderMapDialog('Не удалось загрузить рестораны.'); }
}
function routeFeatures() {
  return (getTrip()?.days || []).flatMap(day => (day.legs || []).filter(leg => leg.geometry)
    .map(leg => ({ type:'Feature', properties:{}, geometry:leg.geometry })));
}
function miniMapData() {
  return { type:'FeatureCollection', features:mapCandidates.map((candidate, index) => ({ type:'Feature', properties:{ index, selected:index === mapSelectedIndex }, geometry:{ type:'Point', coordinates:candidate.place.location.coordinates } })) };
}
function fitMiniMap() {
  if (!miniMapReady || !mapCandidates.length) return;
  const coordinates = [...routeFeatures().flatMap(feature => feature.geometry.coordinates), ...mapCandidates.map(candidate => candidate.place.location.coordinates)];
  if (!coordinates.length) return;
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  coordinates.slice(1).forEach(point => bounds.extend(point));
  miniMap.fitBounds(bounds, { padding:{ top:44, right:44, bottom:44, left:44 }, maxZoom:15, duration:250 });
}
function updateMiniMap() {
  if (!miniMapReady) return;
  miniMap.getSource('restaurant-route').setData({ type:'FeatureCollection', features:routeFeatures() });
  miniMap.getSource('restaurant-points').setData(miniMapData());
  fitMiniMap();
}
async function createMiniMap() {
  if (miniMap) { miniMap.resize(); updateMiniMap(); return; }
  const style = await loadMapStyle();
  miniMap = new maplibregl.Map({ container:'restaurant-mini-map', style, center:[44.006,56.327], zoom:14, attributionControl:false });
  miniMap.on('load', () => {
    miniMap.addSource('restaurant-route', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
    miniMap.addLayer({ id:'restaurant-route-line', type:'line', source:'restaurant-route', paint:{ 'line-color':'#2463D6', 'line-width':4, 'line-opacity':.8 } });
    miniMap.addSource('restaurant-points', { type:'geojson', data:{ type:'FeatureCollection', features:[] } });
    miniMap.addLayer({ id:'restaurant-points-circle', type:'circle', source:'restaurant-points', paint:{ 'circle-radius':['case',['get','selected'],9,6], 'circle-color':['case',['get','selected'],'#FF7A0A','#FFC94A'], 'circle-stroke-width':2, 'circle-stroke-color':'#fff' } });
    miniMap.on('click', 'restaurant-points-circle', event => {
      mapSelectedIndex = Number(event.features[0].properties.index);
      renderMapDialog(); updateMiniMap();
    });
    miniMap.on('mouseenter', 'restaurant-points-circle', () => { miniMap.getCanvas().style.cursor = 'pointer'; });
    miniMap.on('mouseleave', 'restaurant-points-circle', () => { miniMap.getCanvas().style.cursor = ''; });
    miniMapReady = true;
    updateMiniMap();
  });
}
function renderMapFilters() {
  $('restaurant-map-filters').innerHTML = Object.entries(FILTER_LABELS).map(([key, label]) => `<button type="button" data-map-filter="${key}" aria-pressed="${Boolean(mapFilters[key])}">${esc(label)}</button>`).join('');
}
function renderMapDialog(message = '') {
  const candidate = mapCandidates[mapSelectedIndex];
  if (!candidate) { $('restaurant-map-cards').innerHTML = `<p class="restaurants-status">${esc(message || 'Нет мест с выбранными удобствами. Уберите один из фильтров.')}</p>`; return; }
  const card = restaurantCardModel(candidate);
  const meta = [card.distance, card.cuisine, card.openingHours].filter(Boolean).join(' · ');
  const shortDescription = card.description || 'Ресторан расположен рядом с маршрутом прогулки.';
  const fullDescription = [card.description, card.address && `Адрес: ${card.address}.`, card.openingHours && `Часы работы: ${card.openingHours}.`].filter(Boolean).join(' ');
  $('restaurant-map-cards').innerHTML = `<p class="restaurant-map-progress">${mapSelectedIndex + 1} из ${mapCandidates.length} вдоль маршрута</p><article class="restaurant-map-card" data-map-candidate="${mapSelectedIndex}"><div class="restaurant-map-card-head"><img class="restaurant-map-card-icon" src="/assets/category-icons/food.svg" alt=""><div><h3>${esc(card.title)}</h3><p>${esc(card.address || 'Рядом с маршрутом')}</p></div></div>${meta ? `<p>${esc(meta)}</p>` : ''}<p class="restaurant-summary">${esc(shortDescription)}</p><div class="restaurant-badges">${card.badges.map(badge => `<span class="restaurant-badge ${badge.state}">${esc(badge.label)}${badge.state === 'unknown' ? ': нет данных' : ''}</span>`).join('')}</div>${fullDescription ? `<details class="restaurant-map-details"><summary>Полное описание</summary><p>${esc(fullDescription)}</p></details>` : ''}<button type="button" class="restaurant-map-add" data-add-map-candidate="${mapSelectedIndex}">Добавить в маршрут</button></article>`;
  const element = $('restaurant-map-cards').querySelector('.restaurant-map-card');
  const skip = () => { mapSelectedIndex = (mapSelectedIndex + 1) % mapCandidates.length; renderMapDialog(); updateMiniMap(); };
  element.querySelector('[data-add-map-candidate]').onclick = event => addRestaurant(event.currentTarget, candidate);
  let startX = null;
  element.onpointerdown = event => { startX = event.clientX; element.setPointerCapture(event.pointerId); };
  element.onpointermove = event => {
    if (startX === null) return;
    const offset = event.clientX - startX;
    element.style.transform = `translateX(${offset}px) rotate(${offset / 24}deg)`;
    element.style.opacity = String(1 - Math.min(Math.abs(offset) / 500, .35));
  };
  element.onpointerup = event => {
    if (startX === null) return;
    const action = cardSwipeAction(event.clientX - startX); startX = null;
    element.style.transform = ''; element.style.opacity = '';
    if (action === 'skip') skip();
  };
  element.onpointercancel = () => { startX = null; element.style.transform = ''; element.style.opacity = ''; };
}
function openMapRestaurantDialog() {
  mapSelectedIndex = 0;
  renderMapFilters();
  renderMapDialog();
  const dialog = $('restaurant-map-dialog');
  if (!dialog.open) dialog.showModal();
  $('map-restaurant-widget').setAttribute('aria-expanded', 'true');
  createMiniMap().catch(() => { $('restaurant-mini-map').textContent = 'Не удалось загрузить карту'; });
}
function closeMapRestaurantDialog() {
  $('restaurant-map-dialog').close();
  $('map-restaurant-widget').setAttribute('aria-expanded', 'false');
}
async function addRestaurant(button, candidate) {
  button.disabled = true; button.classList.add('busy'); button.textContent = 'Проверяем маршрут…';
  try {
    const preview = await previewAddRestaurant(candidate, candidate.recommended_date || selectedDate || today()?.date);
    if (!preview.can_apply) throw new Error('Этот ресторан не помещается в маршрут выбранного дня.');
    const warnings = (preview.warnings || []).filter(warning => preview.required_acknowledgement_codes.includes(warning.code)).map(warning => warning.message);
    if (!await confirmRestaurant(candidate, warnings)) return;
    await applyPreview(preview, preview.required_acknowledgement_codes);
    loadedKey = null;
    if ($('restaurant-map-dialog').open) closeMapRestaurantDialog();
    status('Ресторан добавлен, маршрут пересчитан.');
    await loadRestaurants(true);
  } catch (error) {
    status(error.message || 'Не удалось добавить ресторан.', true);
    const oldError = button.closest('.restaurant-map-card')?.querySelector('.restaurant-map-error');
    oldError?.remove();
    if (button.closest('.restaurant-map-card')) button.insertAdjacentHTML('beforebegin', `<p class="restaurant-map-error">${esc(error.message || 'Не удалось добавить ресторан.')}</p>`);
  } finally {
    button.disabled = false; button.classList.remove('busy'); button.textContent = 'Добавить в маршрут';
  }
}
function confirmRestaurant(candidate, warnings) {
  const dialog = $('restaurant-confirm-dialog');
  $('restaurant-confirm-title').textContent = `Добавить «${candidate.place.name || candidate.activity.title}»?`;
  $('restaurant-confirm-body').innerHTML = `<p>Проверка пройдена. Перестроим маршрут через это место.</p>${warnings.length ? `<ul>${warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}`;
  if (!dialog.open) dialog.showModal();
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      dialog.close();
      resolve(result);
    };
    $('restaurant-confirm-cancel').onclick = () => finish(false);
    $('restaurant-confirm-apply').onclick = () => finish(true);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
  });
}
export function initRestaurants() {
  if (initialized) return;
  initialized = true;
  $('restaurants-days').addEventListener('click', event => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    selectedDate = button.dataset.date; loadedKey = null; loadRestaurants();
  });
  $('restaurants-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
    loadedKey = null; loadRestaurants();
  });
  $('restaurants-list').addEventListener('click', event => {
    const button = event.target.closest('[data-add]');
    if (button) addRestaurant(button, candidates[Number(button.dataset.add)]);
  });
  onTripChange(() => { loadedKey = null; loadMapWidget(); });
  $('restaurant-map-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-map-filter]');
    if (!button) return;
    const key = button.dataset.mapFilter;
    if (mapFilters[key]) delete mapFilters[key]; else mapFilters[key] = true;
    mapCandidates = []; mapSelectedIndex = 0; renderMapFilters(); renderMapDialog('Обновляем подбор…'); updateMiniMap(); loadMapWidget();
  });
  $('restaurant-map-close').onclick = closeMapRestaurantDialog;
  $('restaurant-map-dialog').addEventListener('cancel', event => { event.preventDefault(); closeMapRestaurantDialog(); });
  loadMapWidget();
}
export function openRestaurants() {
  if (!initialized) return;
  loadRestaurants();
}
