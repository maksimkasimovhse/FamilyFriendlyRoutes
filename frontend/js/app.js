// Точка входа: запуск по состоянию сессии (docs/tz-onboarding.md, раздел 2), нижнее меню, профиль.
//
//   GET /session
//   ├─ не вошли и не гость              → «Вход / регистрация»
//   ├─ анкеты нет                        → анкета (3 шага)
//   ├─ есть сохранённая поездка          → основной интерфейс («Сегодня», карта…)
//   └─ иначе                             → «Новая поездка»
//
// ?newtrip=1 — сразу «Новая поездка» (для репетиции демо).

import { onTripChange, loadSavedTrip, loadCachedTrip, listTrips, openTrip, forget, getTrip, getSource, today, planningOptions, previewManualChoices, applyPreview } from './api.js';
import { startSession, isAuthenticated, isGuest, enterGuest, leaveGuest, userEmail, signOut, initAuthScreen, openAuth } from './session.js';
import { loadFamily, syncLocalProfile, seedDemoNames, clearDeviceData, openOnboarding, closeOnboarding, currentProfile, childName, genitive, familySummary } from './onboarding.js';
import { openTripSetup, markStep, clearResume, afterPick, backToWhen, backToChat, backToPreview, closeTripSetup, prepareInitialChoices } from './trip-setup.js';
import { manualSelection, pickConfiguration } from './recommendation-cards.js';
import { loadRoutePlaces, clearRoutePlaces, onPlacesChange, loadPlaceTypes } from './places.js';
import { initMap, resizeMap, focusPlace, focusPlaceOnMap, clearFocusedPlaceOnMap, showRoutePreview, clearRoutePreview, showPicked, refreshMap, setAmenityFilter } from './map.js';
import { initPick, openPick } from './pick.js';
import { initToday, refreshToday, toast } from './today.js';
import { initMapActions, openUrgentWidget } from './map-actions.js';
import { initProfile, renderProfile } from './profile.js';
import { initKid, openKid, kidStopInfo, setKidRoute, clearKidPlaces } from './kid.js';
import { initRestaurants, openRestaurants, closeRestaurants } from './restaurants.js';

const $ = id => document.getElementById(id);
const app = document.querySelector('.app');
const q = new URLSearchParams(location.search);

// ---------- Нижнее меню ----------
const tabs = document.querySelectorAll('.tabbar button');
const screens = document.querySelectorAll('.screen');
let currentTab = 'today';
function setMapSheetExpanded(expanded) {
  const button = $('map-sheet-toggle'), panel = $('map-sheet-content');
  panel.hidden = !expanded;
  $('map-sheet').classList.toggle('is-collapsed', !expanded);
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', expanded ? 'Свернуть панель карты' : 'Развернуть панель карты');
  requestAnimationFrame(() => resizeMap());
}
function openTab(name) {
  // «Маша» — не вкладка, а детский режим на весь экран поверх приложения
  if (name === 'kid') { openKid(); return; }
  if (name === 'restaurants') {
    currentTab = 'map';
    tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === 'map'));
    screens.forEach(s => { s.hidden = s.dataset.tab !== 'map'; });
    $('restaurant-map-widget').classList.add('on');
    $('restaurant-map-widget').setAttribute('aria-pressed', 'true');
    $('restaurant-map-widget').setAttribute('aria-label', 'Закрыть подбор ресторанов');
    setMapSheetExpanded(true);
    resizeMap();
    openRestaurants();
    return;
  }
  if (name !== 'pick') currentTab = name;
  closeRestaurants();
  $('restaurant-map-widget').classList.remove('on');
  $('restaurant-map-widget').setAttribute('aria-pressed', 'false');
  $('restaurant-map-widget').setAttribute('aria-label', 'Подобрать ресторан по маршруту');
  tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  screens.forEach(s => { s.hidden = s.dataset.tab !== name; });
  if (name === 'map') resizeMap();
  if (name === 'profile') renderProfile();
}
tabs.forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));
document.addEventListener('restaurants:open', () => openTab('restaurants'));

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

  kidReady = initKid({
    childName: name, childNameGenitive: genitive(name), ageYears: age,
    onExit: () => { openTab(currentTab); refreshToday(); },
  }).catch(err => console.error('Детский режим не загрузился', err));
  if (location.hash === '#kid') kidReady.then(() => openKid());

  initMap({ stopInfo: activityId => kidStopInfo(activityId) }).catch(err => {
    console.error(err);
    $('sheet-body').innerHTML = `<p class="source warn">Не удалось загрузить карту: ${err.message}</p>`;
  });
  initToday({ childName: name, childNameGenitive: genitive(name), kidStopInfo, onOpenKid: () => openKid(), onNeedNow: () => { openTab('map'); openUrgentWidget(); } });
  initMapActions({onFilter:setAmenityFilter,onFocus:focusPlace,onPreview:showRoutePreview,onCancel:clearRoutePreview});
  initRestaurants({ onFocus:focusPlaceOnMap, onClear:clearFocusedPlaceOnMap, onResize:resizeMap });
  $('restaurant-map-widget').onclick=()=>openTab($('restaurant-map-widget').getAttribute('aria-pressed') === 'true' ? 'map' : 'restaurants');
  $('map-kid-mode').onclick=()=>kidReady.then(()=>openKid());
  $('map-sheet-toggle').onclick=()=>setMapSheetExpanded($('map-sheet-content').hidden);

  // Тропа ребёнка — в порядке маршрута; «Сегодня» — когда подгрузились места рядом
  // Детская тропа = все места итогового маршрута (по дням, в порядке маршрута); обновляется при любом изменении поездки
  const syncKid = () => kidReady.then(() => { const t = getTrip(); setKidRoute(t && getSource() === 'backend' ? t : null); });
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
let customPickFinish = null, customPickCancel = null;
async function enterPickStep(chatIds) {
  let configuration;
  loading('Подбираем карточки…');
  try { configuration = await prepareInitialChoices(); }
  catch(err) { loading('');backToWhen();$('when-error').textContent=err.message;$('when-error').hidden=false;return; }
  loading('');customPickFinish=null;customPickCancel=null;
  configuration.rankHint = chatIds || null;     // порядок от ИИ-чата: подходящие по пожеланию места — первыми
  pickInFlow = true;
  markStep('pick');
  app.classList.add('flow-mode');
  openTab('pick');
  openPick(configuration);
  document.querySelector('#screen-pick .pick-top h1').textContent = 'Что хотите увидеть?';
}
function leavePickStep() {
  pickInFlow = false;
  document.querySelector('#screen-pick .pick-top h1').textContent = 'Подбор мест';
  $('screen-pick').hidden = true;
}
initPick({
  onFinish: async places => {
    if (customPickFinish) {
      const done=customPickFinish;
      try { await done(places);customPickFinish=null;customPickCancel=null;$('screen-pick').hidden=true; }
      catch(err) { toast(err.message,true); }
      return;
    }
    if (pickInFlow) { leavePickStep(); afterPick(places); return; }
    openTab('map'); showPicked(places);      // отдельно с карты: выбранные места → карта
  },
  onClose: () => {
    if (customPickCancel) { const cancel=customPickCancel;customPickFinish=null;customPickCancel=null;$('screen-pick').hidden=true;cancel();return; }
    if (pickInFlow) { leavePickStep(); backToChat(); return; }
    openTab('map');
  },
});
$('pick-skip').onclick = () => { if(customPickCancel){const cancel=customPickCancel;customPickFinish=null;customPickCancel=null;$('screen-pick').hidden=true;cancel();return;}leavePickStep(); afterPick([]); };
function supplementPicker(configuration,done,cancel) {
  customPickFinish=done;customPickCancel=cancel;pickInFlow=false;
  openTab('pick');openPick(configuration);
  document.querySelector('#screen-pick .pick-top h1').textContent=configuration.title||'Дополнить короткий день';
}
document.addEventListener('pick:open', async () => {
  const trip=getTrip();if(!trip || getSource()!=='backend')return toast('Сначала сохраните маршрут.',true);
  try {
    const options=await planningOptions(trip);
    const config=pickConfiguration({...options,days:options.days.filter(d=>d.date===today()?.date)},{supplemental:true});
    if(!config.days.length)return toast('Нет подходящих дополнений: день заполнен, начат или два ручных выбора уже использованы.');
    supplementPicker(config,async cards=>{
      // One supplemental day per preview: dates remain explicit and counters apply per day.
      const dates=[...new Set(cards.map(c=>c.preferred_date))];
      if(dates.length!==1)throw new Error('Дополняйте по одному дню за раз.');
      const p=await previewManualChoices(trip,dates[0],cards.map(manualSelection));
      const warnings=p.warnings.filter(w=>p.required_acknowledgement_codes.includes(w.code)).map(w=>w.message);
      if(!confirm(`Добавить ${cards.length} места в маршрут?\n${cards.map(c=>c.title).join('\n')}\n${warnings.join('\n')}`)){openTab('map');return;}
      await applyPreview(p,p.required_acknowledgement_codes);openTab('map');
    },()=>openTab('map'));
  } catch(err) { toast(err.message,true); }
});
document.addEventListener('pick:reset', () => { showPicked(null); kidReady.then(clearKidPlaces); });

// ---------- Новая поездка ----------
function startTripSetup({ keep = false, resume = false } = {}) {
  loading('');
  app.classList.add('flow-mode');
  openTripSetup({
    authenticated: isAuthenticated(),
    onBack: () => { closeTripSetup(); if (mainStarted) startMain(); else { app.classList.remove('flow-mode'); showLanding(); } },
    onPick: enterPickStep,
    onBusy: text => loading(text),
    onSupplement: supplementPicker,
    onLogin: () => openAuthFlow(async () => { await syncLocalProfile(); backToPreview(); }),
    onDone: (trip, picked) => {
      closeTripSetup();
      startMain();
    },
  }, { keep, resume });
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

// ---------- Лендинг и вход ----------
// Не вошедшему показываем лендинг; кнопки на нём ведут на экран входа / регистрации.
let authCallback = null;
function showLanding() {
  loading('');
  const login = document.querySelector('.ld-login');
  login.textContent = isAuthenticated() ? 'Выйти' : 'Войти';
  login.title = isAuthenticated() ? 'Вы вошли как ' + userEmail() : '';
  $('onb-auth').hidden = true;
  $('landing').hidden = false;
  $('landing').scrollTop = 0;
}
function openAuthFlow(callback, mode) {
  loading('');
  $('landing').hidden = true;
  app.classList.add('flow-mode');
  authCallback = callback;
  openAuth(mode || (isGuest() ? 'login' : 'register'));
}
// Якорные ссылки лендинга («Как это работает», логотип) только прокручивают — адрес страницы не меняем
document.querySelectorAll('#landing a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const target = a.getAttribute('href') === '#top' ? $('landing') : $(a.getAttribute('href').slice(1));
    if (target === $('landing')) $('landing').scrollTo({ top: 0, behavior: 'smooth' });
    else target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
document.querySelectorAll('#landing [data-auth]').forEach(b => {
  b.onclick = async () => {
    if (b.classList.contains('ld-login') && isAuthenticated()) {   // «Выйти» на лендинге
      await signOut(); forget(); clearDeviceData(); clearResume(); showLanding(); return;
    }
    if (isAuthenticated()) { $('landing').hidden = true; afterAuth(); return; }   // уже вошли — сразу к поездке
    openAuthFlow(afterAuth, b.dataset.auth);
  };
});
document.querySelectorAll('#landing [data-guest]').forEach(b => { b.onclick = () => { $('landing').hidden = true; guestEnter(); }; });
$('auth-back').onclick = () => { $('onb-auth').hidden = true; if (mainStarted) { app.classList.remove('flow-mode'); } else showLanding(); };
initAuthScreen({
  onDone: async () => { $('onb-auth').hidden = true; await authCallback?.(); },
  onGuest: () => { $('onb-auth').hidden = true; guestEnter(); },
});
// Гость всегда начинает с чистого листа: анкета и поездка заполняются с нуля
async function guestEnter() {
  if (isAuthenticated()) await signOut();   // был в аккаунте — выходим, иначе подтянется его анкета
  enterGuest(); clearDeviceData(); clearResume(); forget();
  afterAuth();
}
// После входа: анкету гостя — в аккаунт (если там пусто), дальше по обычной схеме
async function afterAuth() {
  loading('Загружаем анкету…');
  try {
    if (isAuthenticated()) await syncLocalProfile();
    await continueBoot();
  } catch (err) { showFatal(err); }
}

// ---------- Профиль ----------
initProfile({
  onEditProfile: () => openOnboarding({
    authenticated: isAuthenticated(),
    onDone: () => location.reload(),          // имя и возраст ребёнка перечитаются везде
    onBack: () => { closeOnboarding(); app.classList.remove('flow-mode'); },
  }),
  onNewTrip: () => { clearResume(); startTripSetup(); },
  onOpenTrip: () => openTab('today'),
  onSignOut: async () => {
    await signOut();
    forget();
    // Анкету этого аккаунта с устройства убираем: телефоном может пользоваться кто-то ещё
    try { localStorage.removeItem('family-profile-v1'); localStorage.removeItem('child-names-v1'); } catch { /* ничего */ }
    location.reload();
  },
  onSignIn: () => openAuthFlow(async () => { await syncLocalProfile(); location.reload(); }),
});

// ---------- Запуск ----------
function showFatal(err) {
  console.error(err);
  loading('');
  $('flow-loading').hidden = false;
  $('flow-loading-text').textContent = 'Не получилось загрузить: ' + err.message;
}

async function continueBoot() {
  const profile = await loadFamily({ authenticated: isAuthenticated() });
  seedDemoNames(userEmail());
  if (!profile) return openProfileFlow({ firstTime: true });
  if (q.has('newtrip')) {
    // Разовая команда: сразу убираем её из адреса, иначе каждое обновление страницы начинало бы поездку заново
    history.replaceState(null, '', location.pathname + location.hash);
    q.delete('newtrip');
    forget();
    clearResume();
    return startTripSetup();
  }
  loading('Загружаем поездку…');
  const trip = await loadSavedTrip();
  if (trip) return startMain();
  startTripSetup({ resume: true });   // после обновления страницы возвращаемся на тот же шаг
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
  // Правило входа на страницу: есть сохранённый маршрут — открываем его; иначе ВСЕГДА лендинг
  // (и для аккаунта, и для гостя). ?newtrip=1 — сразу «Новая поездка» (для репетиции, только если уже вошли).
  if ((isAuthenticated() || isGuest()) && q.has('newtrip')) { try { return await continueBoot(); } catch (err) { return showFatal(err); } }
  if (isAuthenticated() || isGuest()) {
    if (await loadSavedTrip()) { try { return await continueBoot(); } catch (err) { return showFatal(err); } }
    if (isGuest()) { leaveGuest(); clearDeviceData(); }   // гость без маршрута — начнёт с чистого листа
  }
  clearResume(); forget();
  showLanding();
}
boot();
