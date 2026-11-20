// Точка входа: параметры поездки, нижнее меню, запуск экранов.

import { loadTrip, resetTrip, onTripChange } from './api.js';
import { loadPlaces } from './places.js';
import { initMap, resizeMap, focusPlace, showPicked } from './map.js';
import { initPick, openPick } from './pick.js';
import { initToday, refreshToday } from './today.js';
import { initAssistant, openAssistant } from './assistant.js';
import { initKid, openKid, syncKidOrder, kidStopInfo } from './kid.js';

// ---------- Параметры поездки ----------
// Формат — TripInput из docs/contracts/openapi.json. Пока анкеты нет, семья задана здесь.
// День — сегодняшний (по Москве): бекенд разрешает «начать день» только в его дату и окно времени.
// Режим in_city и окно «с текущей минуты» — чтобы время прибытия было видно сразу, ещё до старта.
const FAMILY = { childName: 'Маша', childNameGenitive: 'Маши', childAge: 7 };
const todayMsk = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });   // 2026-11-20
const nowMsk = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const START = { coordinates: [44.0066, 56.3273], label: 'Площадь Минина и Пожарского' };

const TRIP_INPUT = {
  city_id: 'nizhny_novgorod',
  timezone: 'Europe/Moscow',
  planning_context: 'in_city',
  family: {
    children: [{ child_id: 'child-1', age_years: FAMILY.childAge, height_cm: null, interest_ids: ['history'] }],
    adult_count: 2,
    adult_interest_ids: ['history'],
  },
  load_limits: { pace: 'relaxed', max_walk_distance_m_per_day: 10000, max_continuous_walk_duration_sec: 3600, restaurant_walk_reserve_m_per_day: 0 },
  days: [{
    date: todayMsk,
    start_point: START,
    end_point: START,
    available_window: { start_at: `${todayMsk}T${nowMsk}:00+03:00`, end_at: todayMsk + 'T23:30:00+03:00' },
    duration_budget_sec: 6 * 3600,
    meal_window: null,
    rest_budget_sec: 0,
  }],
  selections: [],
  request_text: null,
};

// ---------- Нижнее меню ----------
const tabs = document.querySelectorAll('.tabbar button');
const screens = document.querySelectorAll('.screen');

let currentTab = 'today';
function openTab(name) {
  // «Маша» — не вкладка, а детский режим на весь экран поверх приложения
  if (name === 'kid') { openKid(); return; }
  currentTab = name;
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  screens.forEach(s => { s.hidden = s.dataset.tab !== name; });
  if (name === 'map') resizeMap();
  if (name === 'helper') openAssistant();
}
tabs.forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));
openTab(location.hash === '#map' ? 'map' : 'today');

// ---------- Запуск экранов ----------
const kidReady = initKid({
  childName: FAMILY.childName,
  childNameGenitive: FAMILY.childNameGenitive,
  ageYears: FAMILY.childAge,
  onExit: () => { openTab(currentTab); refreshToday(); },   // выход — обратно к родителю
}).catch(err => console.error('Детский режим не загрузился', err));
if (location.hash === '#kid') kidReady.then(() => openKid());

initMap().catch(err => {
  console.error(err);
  document.getElementById('sheet-body').innerHTML = `<p class="source warn">Не удалось загрузить карту: ${err.message}</p>`;
});

initToday({
  childName: FAMILY.childName,
  childNameGenitive: FAMILY.childNameGenitive,
  kidStopInfo,
  onOpenKid: () => openKid(),
  onNeedNow: () => openTab('helper'),
});
initAssistant({ onShowOnMap: place => { openTab('map'); focusPlace(place); } });

// ---------- Подбор мест (карточки как в Tinder, экран Максима) ----------
initPick({
  onFinish: places => { openTab('map'); showPicked(places); },   // выбранные места → карта и маршрут
  onClose: () => openTab('map'),
});
const startPick = () => { openTab('pick'); openPick(); };
document.getElementById('open-pick').addEventListener('click', startPick);
document.addEventListener('pick:open', startPick);                 // «Подобрать ещё» на карте
document.addEventListener('pick:reset', () => showPicked(null));   // вернуть исходный маршрут дня

// Тропа ребёнка — в порядке маршрута с бекенда; «Сегодня» — когда подгрузились места рядом
onTripChange(trip => kidReady.then(() => syncKidOrder(trip.days[0].stops.map(s => s.activity_id))));
Promise.all([loadPlaces(), kidReady]).then(refreshToday);

// ?newtrip=1 — начать поездку заново (для репетиции демо)
const q = new URLSearchParams(location.search);
(q.has('newtrip') ? resetTrip(TRIP_INPUT) : loadTrip(TRIP_INPUT));
