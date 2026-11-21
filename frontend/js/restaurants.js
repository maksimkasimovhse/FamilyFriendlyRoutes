import { getTrip, getSource, today, onTripChange, recommendRestaurants, previewAddRestaurant, applyPreview } from './api.js';

const $ = id => document.getElementById(id);
const FILTER_LABELS = {
  high_chairs: 'Детский стульчик',
  children_menu: 'Детское меню',
  play_area: 'Игровая зона',
};
const SWIPE_PX = 45;
const FLING_SPEED = 0.25;
const COMMIT_PX = 110;
const FLY_MS = 280;
let initialized = false;
let mapWidgetRequest = 0;
let mapCandidates = [];
let mapSelectedIndex = 0;
let mapFilters = {};
let restaurantMode = false;
let hooks = {};

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
export function cardSwipeAction(offsetX, velocityX = 0) {
  if (Math.abs(offsetX) > SWIPE_PX || (Math.abs(velocityX) > FLING_SPEED && Math.abs(offsetX) > 14)) return 'skip';
  return null;
}
export function restaurantCardAllowsSwipe(target) {
  return !target?.closest?.('button, .restaurant-map-details');
}
async function loadMapCandidates() {
  const trip = getTrip();
  if (!trip || getSource() !== 'backend') {
    mapCandidates = [];
    if (restaurantMode) renderRestaurantSheet('Для подбора ресторанов нужен сохранённый маршрут.');
    return;
  }
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
    if (restaurantMode) renderRestaurantSheet();
  } catch { if (request === mapWidgetRequest && restaurantMode) renderRestaurantSheet('Не удалось загрузить рестораны.'); }
}
function renderRestaurantSheet(message = '') {
  const container = $('sheet-body');
  const candidate = mapCandidates[mapSelectedIndex];
  if (!candidate) {
    container.innerHTML = `<div class="restaurant-sheet-empty"><b>Где поесть</b><p>${esc(message || 'Ищем рестораны вдоль маршрута…')}</p></div>`;
    hooks.onResize?.();
    return;
  }
  const card = restaurantCardModel(candidate);
  const meta = [card.distance, card.cuisine, card.openingHours].filter(Boolean).join(' · ');
  const shortDescription = card.description || 'Ресторан расположен рядом с маршрутом прогулки.';
  const fullDescription = [card.description, card.address && `Адрес: ${card.address}.`, card.openingHours && `Часы работы: ${card.openingHours}.`].filter(Boolean).join(' ');
  container.innerHTML = `<p class="restaurant-map-progress">${mapSelectedIndex + 1} из ${mapCandidates.length} вдоль маршрута · свайпните, чтобы пропустить</p><article class="restaurant-map-card" data-map-candidate="${mapSelectedIndex}"><div class="restaurant-map-card-head"><img class="restaurant-map-card-icon" src="/assets/category-icons/food.svg" alt=""><div><h3>${esc(card.title)}</h3><p>${esc(card.address || 'Рядом с маршрутом')}</p></div></div>${meta ? `<p>${esc(meta)}</p>` : ''}<p class="restaurant-summary">${esc(shortDescription)}</p><div class="restaurant-badges">${card.badges.map(badge => `<span class="restaurant-badge ${badge.state}">${esc(badge.label)}${badge.state === 'unknown' ? ': нет данных' : ''}</span>`).join('')}</div>${fullDescription ? `<details class="restaurant-map-details"><summary>Полное описание</summary><p>${esc(fullDescription)}</p></details>` : ''}<button type="button" class="restaurant-map-add" data-add-map-candidate="${mapSelectedIndex}">Добавить в маршрут</button></article>`;
  const element = container.querySelector('.restaurant-map-card');
  const skip = (offsetX, offsetY = 0) => {
    const direction = offsetX >= 0 ? 1 : -1;
    element.classList.remove('drag');
    element.classList.add('fly');
    element.style.transform = `translate(${direction * (window.innerWidth + 200)}px, ${offsetY}px) rotate(${direction * 24}deg)`;
    const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : FLY_MS;
    window.setTimeout(() => {
      mapSelectedIndex = (mapSelectedIndex + 1) % mapCandidates.length;
      renderRestaurantSheet();
    }, delay);
  };
  element.querySelector('[data-add-map-candidate]').onclick = event => addRestaurant(event.currentTarget, candidate);
  let startX = 0, startY = 0, offsetX = 0, offsetY = 0, lastX = 0, lastTime = 0, velocityX = 0, dragging = false;
  element.onpointerdown = event => {
    if (event.button > 0 || !restaurantCardAllowsSwipe(event.target)) return;
    dragging = true;
    startX = lastX = event.clientX;
    startY = event.clientY;
    offsetX = offsetY = velocityX = 0;
    lastTime = event.timeStamp;
    try { element.setPointerCapture(event.pointerId); } catch { /* указатель уже не активен */ }
    element.classList.add('drag');
  };
  element.onpointermove = event => {
    if (!dragging) return;
    offsetX = event.clientX - startX;
    offsetY = event.clientY - startY;
    const elapsed = event.timeStamp - lastTime;
    if (elapsed > 0) velocityX = (event.clientX - lastX) / elapsed;
    lastX = event.clientX;
    lastTime = event.timeStamp;
    element.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${offsetX / 18}deg)`;
    if (Math.abs(offsetX) > COMMIT_PX && Math.abs(offsetX) > Math.abs(offsetY) * .7) {
      dragging = false;
      try { element.releasePointerCapture(event.pointerId); } catch { /* захвата не было */ }
      skip(offsetX, offsetY);
    }
  };
  element.onpointerup = event => {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('drag');
    try { element.releasePointerCapture(event.pointerId); } catch { /* захвата не было */ }
    const horizontalGesture = Math.abs(offsetX) > Math.abs(offsetY) * .7;
    if (horizontalGesture && cardSwipeAction(offsetX, velocityX) === 'skip') skip(offsetX, offsetY);
    else element.style.transform = '';
  };
  element.onpointercancel = event => {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('drag');
    try { element.releasePointerCapture(event.pointerId); } catch { /* захвата не было */ }
    element.style.transform = '';
  };
  hooks.onFocus?.(candidate.place);
  hooks.onResize?.();
}
async function addRestaurant(button, candidate) {
  button.disabled = true; button.classList.add('busy'); button.textContent = 'Проверяем маршрут…';
  try {
    const preview = await previewAddRestaurant(candidate, candidate.recommended_date || today()?.date);
    if (!preview.can_apply) throw new Error('Этот ресторан не помещается в маршрут выбранного дня.');
    await applyPreview(preview, preview.required_acknowledgement_codes);
    closeRestaurants();
    await loadMapCandidates();
  } catch (error) {
    const oldError = button.closest('.restaurant-map-card')?.querySelector('.restaurant-map-error');
    oldError?.remove();
    if (button.closest('.restaurant-map-card')) button.insertAdjacentHTML('beforebegin', `<p class="restaurant-map-error">${esc(error.message || 'Не удалось добавить ресторан.')}</p>`);
  } finally {
    button.disabled = false; button.classList.remove('busy'); button.textContent = 'Добавить в маршрут';
  }
}
export function initRestaurants(options = {}) {
  if (initialized) return;
  initialized = true;
  hooks = options;
  onTripChange(loadMapCandidates);
  loadMapCandidates();
}
export function openRestaurants() {
  if (!initialized) return;
  restaurantMode = true;
  mapSelectedIndex = 0;
  renderRestaurantSheet();
  if (!mapCandidates.length) loadMapCandidates();
}
export function closeRestaurants() {
  if (!restaurantMode) return;
  restaurantMode = false;
  hooks.onClear?.();
}
