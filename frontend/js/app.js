// Точка входа: нижнее меню и запуск экрана карты.

import { initMap, resizeMap, showPicked } from './map.js';
import { initPick, openPick } from './pick.js';
import { initKid, openKid } from './kid.js';

// Параметры поездки для демо. Формат — TripInput из docs/contracts/openapi.json.
// Пока анкеты нет, семья и день заданы здесь.
const TRIP_INPUT = {
  city_id: 'nizhny_novgorod',
  timezone: 'Europe/Moscow',
  planning_context: 'before_arrival',
  family: {
    children: [{ child_id: 'child-1', age_years: 7, height_cm: null, interest_ids: ['history'] }],
    adult_count: 2,
    adult_interest_ids: ['history'],
  },
  load_limits: { pace: 'relaxed', max_walk_distance_m_per_day: 10000, max_continuous_walk_duration_sec: 3600 },
  days: [{
    date: '2026-11-21',
    start_point: { coordinates: [44.0066, 56.3273], label: 'Площадь Минина и Пожарского' },
    end_point: { coordinates: [44.0066, 56.3273], label: 'Площадь Минина и Пожарского' },
    available_window: { start_at: '2026-11-21T10:00:00+03:00', end_at: '2026-11-21T17:00:00+03:00' },
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

let currentTab = 'map';
function openTab(name) {
  // «Маша» — не вкладка, а детский режим на весь экран поверх приложения
  if (name === 'kid') { openKid(); return; }
  currentTab = name;
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  screens.forEach(s => { s.hidden = s.dataset.tab !== name; });
  if (name === 'map') resizeMap();
}
tabs.forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));

// ---------- Подбор мест (карточки как в Tinder) ----------
initPick({
  onFinish: places => { openTab('map'); showPicked(places); },   // выбранные места → карта и маршрут
  onClose: () => openTab('map'),
});
const startPick = () => { openTab('pick'); openPick(); };
document.getElementById('open-pick').addEventListener('click', startPick);
document.addEventListener('pick:open', startPick);                 // «Подобрать ещё» на карте
document.addEventListener('pick:reset', () => showPicked(null));   // вернуть исходный маршрут дня

// Ребёнок в детском режиме — берём из данных семьи (пока анкеты нет — из TRIP_INPUT)
const kidReady = initKid({
  childName: 'Маша',
  childNameGenitive: 'Маши',
  ageYears: TRIP_INPUT.family.children[0].age_years,
  onExit: () => openTab(currentTab),   // выход — обратно туда, где был родитель
}).catch(err => console.error('Детский режим не загрузился', err));

// Открыть детский режим сразу по ссылке: index.html#kid
if (location.hash === '#kid') kidReady.then(() => openKid());

initMap(TRIP_INPUT).catch(err => {
  console.error(err);
  document.getElementById('sheet-body').innerHTML = `<p class="source warn">Не удалось загрузить карту: ${err.message}</p>`;
});
