// Точка входа: запуск по состоянию сессии (docs/tz-onboarding.md, раздел 2), нижнее меню, профиль.
//
//   GET /session
//   ├─ не вошли и не гость              → «Вход / регистрация»
//   ├─ анкеты нет                        → анкета (3 шага)
//   ├─ есть сохранённая поездка          → основной интерфейс («Сегодня», карта…)
//   └─ иначе                             → «Новая поездка»
//
// ?newtrip=1 — сразу «Новая поездка» (для репетиции демо).

import { onTripChange, loadSavedTrip, loadCachedTrip, listTrips, openTrip, forget, getTrip, getSource, today } from './api.js';
import { startSession, isAuthenticated, isGuest, userEmail, signOut, initAuthScreen, openAuth } from './session.js';
import { loadFamily, syncLocalProfile, openOnboarding, closeOnboarding, currentProfile, childName, genitive, familySummary } from './onboarding.js';
import { openTripSetup, afterPick, backToWhen, backToWishes, backToPreview, closeTripSetup } from './trip-setup.js';
import { loadRoutePlaces, clearRoutePlaces, onPlacesChange, loadPlaceTypes } from './places.js';
import { initMap, resizeMap, focusPlace, showPicked, refreshMap } from './map.js';
import { initPick, openPick } from './pick.js';
import { initToday, refreshToday } from './today.js';
import { initAssistant, openAssistant } from './assistant.js';
import { initKid, openKid, syncKidOrder, kidStopInfo } from './kid.js';

const $ = id => document.getElementById(id);
const app = document.querySelector('.app');
const q = new URLSearchParams(location.search);

// ---------- Нижнее меню ----------
const tabs = document.querySelectorAll('.tabbar button');
const screens = document.querySelectorAll('.screen');
let currentTab = 'today';
function openTab(name) {
  // «Маша» — не вкладка, а детский режим на весь экран поверх приложения
  if (name === 'kid') { openKid(); return; }
  if (name !== 'pick') currentTab = name;
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  screens.forEach(s => { s.hidden = s.dataset.tab !== name; });
  if (name === 'map') resizeMap();
  if (name === 'helper') openAssistant();
  if (name === 'album') renderProfile();
}
tabs.forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));

// ---------- Загрузка ----------
function loading(text) {
  $('flow-loading-text').textContent = text;
  $('flow-loading').hidden = !text;
}

// ---------- Основной интерфейс (после того как поездка есть) ----------
let mainStarted = false;
let kidReady = Promise.resolve();
function startMain() {
  loading('');
  app.classList.remove('flow-mode');
  if (mainStarted) { refreshToday(); refreshMap(); openTab('today'); return; }
  mainStarted = true;
  // Имя ребёнка — из анкеты на этом устройстве; детский режим пока ведёт первого ребёнка
  const name = childName(0);
  const age = currentProfile()?.family.children[0]?.age_years || 7;
  document.querySelectorAll('.tabbar .kid').forEach(b => { b.lastChild.textContent = name.startsWith('Ребёнок') ? 'Ребёнок' : name; });
  document.querySelectorAll('.kid-badge').forEach(b => { b.textContent = name.charAt(0).toUpperCase(); });

  kidReady = initKid({
    childName: name, childNameGenitive: genitive(name), ageYears: age,
    onExit: () => { openTab(currentTab); refreshToday(); },
  }).catch(err => console.error('Детский режим не загрузился', err));
  if (location.hash === '#kid') kidReady.then(() => openKid());

  initMap({ stopInfo: activityId => kidStopInfo(activityId) }).catch(err => {
    console.error(err);
    $('sheet-body').innerHTML = `<p class="source warn">Не удалось загрузить карту: ${err.message}</p>`;
  });
  initToday({ childName: name, childNameGenitive: genitive(name), kidStopInfo, onOpenKid: () => openKid(), onNeedNow: () => openTab('helper') });
  initAssistant({ onShowOnMap: place => { openTab('map'); focusPlace(place); } });

  // Тропа ребёнка — в порядке маршрута; «Сегодня» — когда подгрузились места рядом
  const syncKid = () => kidReady.then(() => { const day = today(); if (day) syncKidOrder(day.stops.map(s => s.activity_id)); });
  onTripChange(syncKid);
  if (getTrip()) syncKid(getTrip());
  const syncInfrastructure = trip => {
    const day = today();
    if (getSource() === 'backend' && day) loadRoutePlaces(trip, day).catch(err => console.warn(err.message));
    else clearRoutePlaces();
  };
  onTripChange(syncInfrastructure);
  onPlacesChange(() => { refreshToday(); refreshMap(); });
  if (getTrip()) syncInfrastructure(getTrip());
  Promise.all([loadPlaceTypes(), kidReady]).then(() => { refreshToday(); refreshMap(); });
  openTab(location.hash === '#map' ? 'map' : 'today');
}

// ---------- Подбор мест: шаг 2 «Новой поездки» или отдельно с карты ----------
let pickInFlow = false;
function enterPickStep() {
  pickInFlow = true;
  app.classList.add('flow-mode');
  openTab('pick');
  openPick();
  document.querySelector('#screen-pick .pick-top h1').textContent = 'Что точно хотите увидеть?';
}
function leavePickStep() {
  pickInFlow = false;
  document.querySelector('#screen-pick .pick-top h1').textContent = 'Подбор мест';
  $('screen-pick').hidden = true;
}
initPick({
  onFinish: places => {
    if (pickInFlow) { leavePickStep(); afterPick(places); return; }
    openTab('map'); showPicked(places);      // отдельно с карты: выбранные места → карта
  },
  onClose: () => {
    if (pickInFlow) { leavePickStep(); backToWhen(); return; }
    openTab('map');
  },
});
$('pick-skip').onclick = () => { leavePickStep(); afterPick([]); };
document.addEventListener('pick:open', () => { openTab('pick'); openPick(); });   // «Подобрать ещё» на карте
document.addEventListener('pick:reset', () => showPicked(null));

// ---------- Новая поездка ----------
function startTripSetup({ keep = false } = {}) {
  loading('');
  app.classList.add('flow-mode');
  openTripSetup({
    authenticated: isAuthenticated(),
    onBack: () => { if (mainStarted) { closeTripSetup(); startMain(); } else openProfileFlow({ firstTime: false }); },
    onPick: enterPickStep,
    onEditProfile: () => openOnboarding({
      authenticated: isAuthenticated(),
      onDone: () => { closeOnboarding(); backToWishes(); },
      onBack: () => backToWishes(),
    }),
    onLogin: () => openAuthFlow(async () => { await syncLocalProfile(); backToPreview(); }),
    onDone: (trip, picked) => {
      closeTripSetup();
      startMain();
      // Выбранные свайпами места пока не попадают в план (id карточек ≠ id мест ML) —
      // показываем их на карте отдельно, как раньше (ТЗ, открытый вопрос 2)
      if (picked.length) { openTab('map'); showPicked(picked); }
    },
  }, { keep });
}

// ---------- Анкета ----------
function openProfileFlow({ firstTime }) {
  loading('');
  app.classList.add('flow-mode');
  openOnboarding({
    authenticated: isAuthenticated(),
    onDone: () => { closeOnboarding(); startTripSetup(); },
    onBack: () => { if (firstTime && !isAuthenticated()) openAuthFlow(afterAuth); else if (mainStarted) { closeOnboarding(); startMain(); } else openAuthFlow(afterAuth); },
  });
}

// ---------- Вход ----------
let authCallback = null;
function openAuthFlow(callback) {
  loading('');
  app.classList.add('flow-mode');
  authCallback = callback;
  openAuth(isGuest() ? 'login' : 'register');
}
initAuthScreen({
  onDone: async () => { $('onb-auth').hidden = true; await authCallback?.(); },
  onGuest: () => { $('onb-auth').hidden = true; afterAuth(); },
});
// После входа: анкету гостя — в аккаунт (если там пусто), дальше по обычной схеме
async function afterAuth() {
  loading('Загружаем анкету…');
  try {
    if (isAuthenticated()) await syncLocalProfile();
    await continueBoot();
  } catch (err) { showFatal(err); }
}

// ---------- Профиль (вкладка «Альбом») ----------
async function renderProfile() {
  $('prof-who').textContent = isAuthenticated() ? userEmail() : 'Без входа · поездка хранится сутки на этом устройстве';
  $('prof-family').textContent = familySummary() || 'Анкета не заполнена';
  $('prof-auth').textContent = isAuthenticated() ? 'Выйти' : 'Войти или зарегистрироваться';
  const list = $('prof-trips');
  try {
    const { items } = await listTrips();
    const current = getTrip()?.trip_id;
    list.innerHTML = items.length ? '' : '<li class="muted">Поездок пока нет</li>';
    items.forEach(t => {
      const li = document.createElement('li');
      const date = new Date(t.updated_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      li.innerHTML = `<span><b>Поездка от ${date}</b><small>${t.status === 'draft' ? 'черновик' : 'маршрут сохранён'}</small></span>`;
      if (t.trip_id === current) li.insertAdjacentHTML('beforeend', '<span class="cur">открыта</span>');
      else if (t.status !== 'draft') {
        const b = document.createElement('button');
        b.className = 'btn alt slim';
        b.textContent = 'Открыть';
        b.onclick = async () => { await openTrip(t.trip_id); openTab('today'); };
        li.append(b);
      }
      list.append(li);
    });
  } catch {
    list.innerHTML = '<li class="muted">Список поездок сейчас недоступен</li>';
  }
}
$('prof-edit').onclick = () => openOnboarding({
  authenticated: isAuthenticated(),
  onDone: () => location.reload(),          // имя и возраст ребёнка перечитаются везде
  onBack: () => { closeOnboarding(); app.classList.remove('flow-mode'); },
});
$('prof-newtrip').onclick = () => startTripSetup();
$('prof-auth').onclick = async () => {
  if (isAuthenticated()) {
    await signOut();
    forget();
    // Анкету этого аккаунта с устройства убираем: телефоном может пользоваться кто-то ещё
    try { localStorage.removeItem('family-profile-v1'); localStorage.removeItem('child-names-v1'); } catch { /* ничего */ }
    location.reload();
  } else {
    openAuthFlow(async () => { await syncLocalProfile(); location.reload(); });
  }
};

// ---------- Запуск ----------
function showFatal(err) {
  console.error(err);
  loading('');
  $('flow-loading').hidden = false;
  $('flow-loading-text').textContent = 'Не получилось загрузить: ' + err.message;
}

async function continueBoot() {
  const profile = await loadFamily({ authenticated: isAuthenticated() });
  if (!profile) return openProfileFlow({ firstTime: true });
  if (q.has('newtrip')) { forget(); return startTripSetup(); }
  loading('Загружаем поездку…');
  const trip = await loadSavedTrip();
  if (trip) return startMain();
  startTripSetup();
}

async function boot() {
  loading('Загружаем…');
  try {
    await startSession();
  } catch {
    // Бекенд недоступен — запасной вариант для демо: сохранённый маршрут, только просмотр
    await loadFamily({ authenticated: false });
    await loadCachedTrip();
    return startMain();
  }
  if (!isAuthenticated() && !isGuest()) return openAuthFlow(afterAuth);
  try { await continueBoot(); } catch (err) { showFatal(err); }
}
boot();
