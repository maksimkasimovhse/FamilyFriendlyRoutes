import { getTrip, getSource, today, onTripChange, recommendRestaurants, previewAddRestaurant, applyPreview } from './api.js';

const $ = id => document.getElementById(id);
const FILTER_LABELS = {
  children_menu: 'Детское меню',
  play_area: 'Игровая зона',
  small_portions: 'Маленькие порции',
  play_area_supervision: 'Есть присмотр',
};
let initialized = false;
let selectedDate = null;
let loadedKey = null;
let candidates = [];
let requestNumber = 0;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const known = fact => fact?.state === 'known';
export function restaurantBadges(place) {
  const details = place.restaurant || {};
  return Object.entries(FILTER_LABELS).map(([key, label]) => ({
    key, label, state: !known(details[key]) ? 'unknown' : details[key].value ? 'yes' : 'no',
  }));
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
async function addRestaurant(button, candidate) {
  button.disabled = true; button.classList.add('busy'); button.textContent = 'Проверяем маршрут…';
  try {
    const preview = await previewAddRestaurant(candidate, selectedDate);
    if (!preview.can_apply) throw new Error('Этот ресторан не помещается в маршрут выбранного дня.');
    const warnings = (preview.warnings || []).filter(warning => preview.required_acknowledgement_codes.includes(warning.code)).map(warning => warning.message);
    const prompt = [`Добавить «${candidate.place.name}» в маршрут?`, ...warnings].join('\n\n');
    if (!window.confirm(prompt)) return;
    await applyPreview(preview, preview.required_acknowledgement_codes);
    loadedKey = null;
    status('Ресторан добавлен, маршрут пересчитан.');
    await loadRestaurants(true);
  } catch (error) {
    status(error.message || 'Не удалось добавить ресторан.', true);
  } finally {
    button.disabled = false; button.classList.remove('busy'); button.textContent = 'Добавить в маршрут';
  }
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
  onTripChange(() => { loadedKey = null; });
}
export function openRestaurants() {
  if (!initialized) return;
  loadRestaurants();
}
