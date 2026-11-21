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
import { openTripSetup, markStep, clearResume, afterPick, backToWhen, backToChat, backToWishes, backToPreview, closeTripSetup, prepareInitialChoices } from './trip-setup.js';
import { manualSelection, pickConfiguration } from './recommendation-cards.js';
import { loadRoutePlaces, clearRoutePlaces, onPlacesChange, loadPlaceTypes } from './places.js';
import { initMap, resizeMap, focusPlace, showRoutePreview, clearRoutePreview, showPicked, refreshMap } from './map.js';
import { initPick, openPick } from './pick.js';
import { initToday, refreshToday, toast } from './today.js';
import { initWeatherSky } from './weather-sky.js';
import { initMapActions, openUrgentWidget } from './map-actions.js';
import { initKid, openKid, syncKidOrder, kidStopInfo, setKidPlaces, clearKidPlaces } from './kid.js';

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
  initToday({ childName: name, childNameGenitive: genitive(name), kidStopInfo, onOpenKid: () => openKid(), onNeedNow: () => { openTab('map'); openUrgentWidget(); } });
  initMapActions({onFocus:focusPlace,onPreview:showRoutePreview,onCancel:clearRoutePreview});

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
initWeatherSky($('map-sky'));
initPick({
  onFinish: async places => {
    if (customPickFinish) {
      const done=customPickFinish;
      try { await done(places);customPickFinish=null;customPickCancel=null;$('screen-pick').hidden=true; }
      catch(err) { toast(err.message,true); }
      return;
    }
    kidReady.then(() => setKidPlaces(places.map(p=>p.presentation_id ? {...p,id:p.presentation_id}:p), today()?.start_point?.coordinates || [44.0066,56.3273]));
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
  document.querySelector('#screen-pick .pick-top h1').textContent='Дополнить короткий день';
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
    onSupplement: supplementPicker,
    onEditProfile: () => openOnboarding({
      authenticated: isAuthenticated(),
      onDone: () => { closeOnboarding(); backToWishes(); },
      onBack: () => backToWishes(),
    }),
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
$('ld-guest').onclick = () => { $('landing').hidden = true; guestEnter(); };
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
$('prof-newtrip').onclick = () => { clearResume(); startTripSetup(); };
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
