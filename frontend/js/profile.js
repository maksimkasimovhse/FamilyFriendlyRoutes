// Профиль: дети и их интересы, «память о поездке» (статистика, фото, достижения), сторис, мои поездки.
// Фото хранятся ТОЛЬКО на этом устройстве (localStorage, уменьшенные копии) — никуда не отправляются.

import { getTrip, listTrips, openTrip, fetchTrip } from './api.js';
import { isAuthenticated, userEmail } from './session.js';
import { currentProfile, childName, ageText, interestLabel, interestChoices, updateInterests, loadFamily } from './onboarding.js';
import { kidProgress } from './kid.js';
import { loadCards, cardById } from './catalog.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let hooks = { onEditProfile() {}, onNewTrip() {}, onSignOut() {}, onSignIn() {}, onOpenTrip() {} };

// ---------- Фото на память (у каждой поездки свои) ----------
const PHOTOS_KEY = 'memory-photos-v1';          // прежнее общее хранилище: достаётся текущей поездке
const photosKey = id => 'memory-photos-v2:' + id;
const MAX_PHOTOS = 8;
const isCurrent = id => id && id === getTrip()?.trip_id;
function readPhotos(id, trip = null) {
  if (trip?.demo) return trip.demoPhotos || [];
  try {
    const own = JSON.parse(localStorage.getItem(photosKey(id)));
    if (own) return own;
    return isCurrent(id) ? JSON.parse(localStorage.getItem(PHOTOS_KEY)) || [] : [];
  } catch { return []; }
}
function writePhotos(id, list) { try { localStorage.setItem(photosKey(id), JSON.stringify(list)); return true; } catch { return false; } }

// Уменьшаем до 900 px по длинной стороне: большие снимки не поместятся в память браузера
function downscale(file) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      ok(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => fail(new Error('Не получилось открыть фото'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Заглушка: уже завершённая поездка ----------
// Показывается в «Моих поездках» всегда, чтобы был виден готовый альбом. На сервере её нет и она ничего не меняет.
const DEMO_ID = 'demo-past';
const DEMO_PLAN = [   // день → места (id карточек из data/cards.json) и пройденные метры
  { back: 22, walked: 4300, places: ['18', '45', '43', '47'] },
  { back: 21, walked: 3200, places: ['131', '5', '45'] },
];
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function demoPastTrip() {
  const days = DEMO_PLAN.map(plan => {
    const d = new Date(); d.setDate(d.getDate() - plan.back);
    return {
      date: iso(d),
      stops: plan.places.map(id => ({ title: cardById(id)?.title || 'Место', progress: 'visited', activity_id: 'demo-' + id })),
      execution: { consumed_walk_distance_m: plan.walked },
    };
  });
  const photoCards = ['47', '45', '18', '131'].map(id => cardById(id)?.image?.card).filter(Boolean);
  return {
    trip_id: DEMO_ID, version: 1, status: 'completed', demo: true, days,
    demoStamps: 6, demoPhotos: photoCards,
    // та же форма, что у строки списка (summary), чтобы карточка рисовалась одним кодом
    summary: { trip_id: DEMO_ID, version: 1, status: 'completed', demo: true, days: days.map(d => ({ date: d.date, stops: d.stops.length, visited: d.stops.length, walked_m: d.execution.consumed_walk_distance_m })) },
  };
}

// ---------- Статистика поездки ----------
// Альбом наполняется только тем, что реально случилось: открытые окна, пройденные км, штампы, фото.
// План поездки нужен лишь для «закрытых окон» и обратного отсчёта.
const DAY = 864e5;
const localDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
function tripStats(trip) {
  const days = trip?.days || [];
  const stops = days.flatMap(d => d.stops.filter(s => s.progress !== 'removed').map(s => ({ ...s, date: d.date })));
  const opened = stops.filter(s => s.progress === 'visited');
  const walkedKm = days.reduce((m, d) => m + (d.execution?.consumed_walk_distance_m || 0), 0) / 1000;
  const kid = kidProgress();
  const current = isCurrent(trip?.trip_id);
  const photoList = trip ? readPhotos(trip.trip_id, trip) : [];
  const photos = photoList.length;
  const stamps = trip?.demo ? trip.demoStamps : current ? kid?.stamps || 0 : 0;      // штампы детского режима ведутся по текущей поездке
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const first = days[0] ? localDate(days[0].date) : null;
  const last = days.length ? localDate(days[days.length - 1].date) : null;
  const daysWithWalk = days.filter(d => d.stops.some(s => s.progress === 'visited') || d.execution?.consumed_walk_distance_m > 0).length;
  return {
    hasTrip: !!trip, trip, current, stops, opened, walkedKm, stamps, photos, photoList, days: days.length, daysWithWalk,
    started: opened.length > 0 || walkedKm > 0.05 || stamps > 0 || photos > 0,
    untilStart: first ? Math.round((first - now) / DAY) : null,
    finished: last ? now > last : false,
    upcoming: first ? now < first : false,
    range: first ? dateRange(first, last) : '',
    fawn: (current && kid?.outfitImg) || 'media/fawn/fawn-base.svg',
  };
}
function dateRange(a, b) {
  const m = d => d.toLocaleDateString('ru-RU', { month: 'long' }).replace(/^./, '');
  const dm = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  if (+a === +b) return dm(a);
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${dm(b)}` : `${dm(a)} – ${dm(b)}`;
}
const fmtKm = km => (km >= 10 ? Math.round(km) : Math.round(km * 10) / 10).toString().replace('.', ',');
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const daysWord = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

// ---------- Достижения (часть — из детского режима) ----------
function achievements(st) {
  const total = st.stops.length;
  return [
    { id: 'step',   icon: '👣', title: 'Первое окно',     got: st.opened.length >= 1 },
    { id: 'stamp1', icon: '⭐', title: 'Первый штамп',    got: st.stamps >= 1 },
    { id: 'photo',  icon: '📷', title: 'Фотограф',        got: st.photos >= 1 },
    { id: 'km3',    icon: '🧭', title: '3 км пешком',     got: st.walkedKm >= 3 },
    { id: 'stamp3', icon: '🏅', title: 'Знаток города',   got: st.stamps >= 3 },
    { id: 'all',    icon: '🏆', title: 'Все окна',        got: total > 0 && st.opened.length >= total },
  ];
}

// ---------- Отрисовка ----------
export async function renderProfile() {
  const p = currentProfile();
  const email = userEmail();
  $('pf-sub').textContent = isAuthenticated() ? email || 'Вы вошли' : 'Гость · поездка хранится сутки на этом устройстве';
  $('prof-auth').textContent = isAuthenticated() ? 'Выйти' : 'Войти';

  // Семья: дети и взрослые — одинаковые строки; справа карандашик: поменять интересы человека
  const row = (ava, avaCls, name, meta, edit) => `
    <div class="pf-member">
      <span class="pf-m-ava ${avaCls}">${esc(ava)}</span>
      <div class="pf-m-main">
        <div class="pf-m-top"><b>${esc(name)}</b>${meta ? `<span>${esc(meta)}</span>` : ''}</div>
      </div>
      <button type="button" class="pf-pencil" data-edit="${esc(edit)}" aria-label="Изменить интересы: ${esc(name)}" title="Изменить интересы">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z M14 7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  const kids = (p?.family.children || []).map((c, i) => {
    const name = childName(i);
    return row(name.replace(/^Ребёнок\s*/, '').charAt(0).toUpperCase() || name.charAt(0), 'kid', name, ageText(c.age_years), 'child:' + i);
  });
  const adults = p ? row(String(p.family.adult_count), 'adult', 'Взрослые', '', 'adult:0') : '';
  $('pf-kids').innerHTML = kids.join('') + adults || '<p class="muted">Анкета ещё не заполнена</p>';
  $('pf-kids').querySelectorAll('[data-edit]').forEach(b => { b.onclick = () => openInterestEditor(...b.dataset.edit.split(':')); });

  renderTrips();
}

function renderMemory() {
  if (!album) return;
  const st = tripStats(album);
  const tid = album.trip_id;
  const total = st.stops.length, opened = st.opened.length;
  const kid = childName(0);

  // Кольцо прогресса: сколько окон открыто
  $('pf-ring').style.setProperty('--p', total ? opened / total : 0);
  $('pf-ring').innerHTML = `<b>${opened}<i>/${total}</i></b><small>${plural(total, 'окно', 'окна', 'окон')}</small>`;
  $('pf-ring').hidden = !total;

  if (!st.started) {
    $('pf-memory').classList.add('empty');
    $('pf-mem-h').textContent = 'Альбом ждёт прогулки';
    const when = st.untilStart == null ? '' : st.untilStart > 0 ? `До прогулки ${daysWord(st.untilStart)}. ` : st.untilStart === 0 ? 'Прогулка уже сегодня! ' : '';
    $('pf-lead').innerHTML = `${esc(when)}Альбом соберётся сам: открывайте окна на точках маршрута, фотографируйте, а ${esc(kid)} будет собирать штампы.`;
    $('pf-stats').innerHTML = '';
  } else {
    $('pf-memory').classList.remove('empty');
    $('pf-mem-h').textContent = 'Наш Нижний';
    $('pf-lead').textContent = `${st.range}${st.days ? ` · гуляли ${daysWord(st.daysWithWalk)} из ${st.days}` : ''}`;
    $('pf-stats').innerHTML = `
      <div class="pf-stat big"><b>${fmtKm(st.walkedKm)}</b><span>км пешком</span></div>
      <div class="pf-stat"><b>${st.stamps}</b><span>${plural(st.stamps, 'штамп', 'штампа', 'штампов')}</span></div>
      <div class="pf-stat"><b>${st.photos}</b><span>фото</span></div>`;
  }

  // Окна маршрута: открытые — цветные, остальные — закрыты до прихода на место
  $('pf-windows').innerHTML = st.stops.length ? `<small class="pf-sub-h">Окна маршрута</small><div class="pf-win-row">${st.stops.map((s, i) => {
    const on = s.progress === 'visited';
    return `<div class="pf-win${on ? ' on' : ''}"><span class="pf-win-ico" aria-hidden="true">${on ? '✓' : i + 1}</span><b>${esc(s.title)}</b><small>${on ? 'открыто' : 'откроется на месте'}</small></div>`;
  }).join('')}</div>` : '';

  // Фото: полароиды + плитка «добавить»
  const ro = !!album.demo;
  const photos = readPhotos(tid, album);
  $('pf-photos').innerHTML = photos.map((src, i) =>
    `<figure class="pf-photo" style="--r:${[-4, 3, -2, 4, -3, 2, -5, 3][i % 8]}deg"><img src="${src}" alt="Фото на память ${i + 1}">${ro ? '' : `<button type="button" data-del="${i}" aria-label="Убрать фото">×</button>`}</figure>`).join('')
    + (!ro && photos.length < MAX_PHOTOS ? `<button type="button" class="pf-add" id="pf-add"><span>+</span>${photos.length ? 'Ещё фото' : 'Первое фото'}</button>` : '');
  $('pf-photos').querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { const l = readPhotos(tid); l.splice(+b.dataset.del, 1); writePhotos(tid, l); renderMemory(); }; });
  const add = $('pf-add'); if (add) add.onclick = () => $('pf-file').click();

  // Достижения
  $('pf-ach').innerHTML = achievements(st).map(a =>
    `<div class="pf-badge${a.got ? ' got' : ''}" title="${esc(a.title)}"><span aria-hidden="true">${a.got ? a.icon : '🔒'}</span><small>${esc(a.title)}</small></div>`).join('');

  // Сторис — только когда есть чем хвастаться
  $('pf-share').disabled = !st.started;
  $('pf-share').textContent = st.started ? '✦ Выложить в сторис' : 'Сторис откроется после первого окна';
}

// ---------- Окно «Интересы» (карандашик) ----------
async function openInterestEditor(kind, indexStr) {
  const p = currentProfile();
  const index = Number(indexStr);
  if (!p) return;
  const who = kind === 'adult' ? 'Взрослые' : childName(index);
  const current = new Set(kind === 'adult' ? p.family.adult_interest_ids : p.family.children[index].interest_ids);
  const chosen = new Set(current);
  let options = [];
  try { options = await interestChoices(kind); } catch { options = []; }
  // Интересы, которых уже нет в списке (из старой анкеты), показываем выбранными, чтобы их можно было снять
  const extra = [...current].filter(id => !options.some(o => o.id === id)).map(id => ({ id, label: interestLabel(id) }));
  // Одинаковые подписи (например, «Техника» в двух справочниках) показываем одной плашкой, id собираем вместе
  const groups = [];
  [...options, ...extra].forEach(o => {
    const g = groups.find(x => x.label === o.label);
    if (g) g.ids.push(o.id); else groups.push({ label: o.label, ids: [o.id] });
  });
  const isOn = g => g.ids.some(id => chosen.has(id));

  const sheet = $('pf-int-sheet') || (() => {
    const el = document.createElement('div');
    el.id = 'pf-int-sheet'; el.className = 'pf-int-sheet';
    $('pf-kids').closest('.screen').append(el);       // внутри экрана профиля, а не на всю страницу
    return el;
  })();
  let busy = false, error = '';
  const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
  const draw = () => {
    sheet.innerHTML = `
      <div class="pf-int-panel" role="dialog" aria-modal="true" aria-labelledby="pf-int-title">
        <div class="pf-int-head"><h2 id="pf-int-title">Интересы: ${esc(who)}</h2><button type="button" class="pf-int-x" aria-label="Закрыть" data-act="close">✕</button></div>
        <div class="pf-int-chips">${groups.map((g, i) => `<button type="button" class="pf-int-chip" aria-pressed="${isOn(g)}" data-g="${i}">${esc(g.label)}</button>`).join('')}</div>
        ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
        <div class="pf-int-foot">
          <button type="button" class="btn flow-main" data-act="save" ${busy ? 'disabled' : ''}>${busy ? 'Сохраняем…' : 'Сохранить'}</button>
          <button type="button" class="btn link" data-act="close">Отмена</button>
        </div>
      </div>`;
    sheet.querySelectorAll('[data-act="close"]').forEach(b => { b.onclick = () => { if (!busy) close(); }; });
    sheet.querySelectorAll('.pf-int-chip').forEach(b => { b.onclick = () => { const g = groups[Number(b.dataset.g)]; if (isOn(g)) g.ids.forEach(id => chosen.delete(id)); else chosen.add(g.ids[0]); draw(); }; });
    sheet.querySelector('[data-act="save"]').onclick = async () => {
      busy = true; error = ''; draw();
      try {
        await updateInterests({ kind, index, ids: groups.filter(isOn).flatMap(g => g.ids.filter(id => chosen.has(id))), authenticated: isAuthenticated() });
        close();
        renderProfile();
      } catch (e) {
        busy = false;
        if (e.code === 'VERSION_CONFLICT') {
          try { await loadFamily({ authenticated: isAuthenticated() }); } catch { /* оставим как есть */ }
          error = 'Анкета изменилась на другом устройстве — мы загрузили новую версию. Закройте окно и повторите.';
        } else error = e.message || 'Не удалось сохранить';
        draw();
      }
    };
  };
  draw();
  sheet.hidden = false;
}

// ---------- Мои поездки: карусель, нажатие открывает альбом ----------
let album = null;               // поездка, чей альбом сейчас открыт
let demoTrip = null;            // заглушка собирается из каталога карточек
let tripsCache = null;          // последний полученный список: при повторном входе в профиль показываем сразу
const fullCache = new Map();    // trip_id@version → поездка целиком (нужна только для открытого альбома)

// Карточка строится из строки списка (даты и счётчики приходят вместе со списком, без запроса каждой поездки)
const item_demo = t => !!t.demo;
function tripCard(t, current) {
  const days = t.days || [];
  const first = days[0] ? localDate(days[0].date) : null, last = days.length ? localDate(days[days.length - 1].date) : null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const total = days.reduce((n, d) => n + d.stops, 0);
  const done = days.reduce((n, d) => n + d.visited, 0);
  const state = item_demo(t) ? ['done', 'Завершённая'] : current ? ['cur', 'Текущая'] : last && now > last ? ['done', 'Завершённая'] : first && now < first ? ['soon', 'Скоро'] : first ? ['going', 'Идёт сейчас'] : ['past', 'Поездка'];
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'trip-card ' + state[0]; b.setAttribute('role', 'listitem');
  b.innerHTML = `
    <span class="tc-top"><span class="tc-chip">${state[1]}</span>
      <span class="tc-go" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span>
    <b class="tc-range">${esc(first ? dateRange(first, last) : 'Без дат')}</b>
    <span class="tc-meta">${daysWord(days.length || 1)} · ${total} ${plural(total, 'место', 'места', 'мест')}</span>
    <span class="tc-bar" aria-hidden="true"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span>
    <small>${done ? `пройдено ${done} из ${total} · ` : ''}<u>Открыть альбом →</u></small>`;
  b.onclick = () => openAlbum(t);
  return b;
}

// Две закреплённые ячейки слева направо:
//  1) динамическая — самая свежая поездка (текущая, а новая сразу занимает это место); если поездок нет — «Создать поездку»;
//  2) закреплённая оранжевая «Завершённая» (заглушка для показа), всегда на втором месте;
//  дальше — остальные поездки от новых к старым.
function newTripCard() {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'trip-card empty'; b.setAttribute('role', 'listitem');
  b.innerHTML = '<span class="tc-plus" aria-hidden="true">+</span><b class="tc-range">Новая поездка</b><small>Подобрать места и маршрут</small>';
  b.onclick = () => hooks.onNewTrip();
  return b;
}
function composeTrips(realCards) {
  const out = [realCards[0] || newTripCard()];
  if (demoTrip) out.push(tripCard(demoTrip.summary, false));
  out.push(...realCards.slice(1));
  return out;
}

function drawTrips(items) {
  const rail = $('prof-trips');
  const current = getTrip()?.trip_id;
  const list = items.filter(t => t.status !== 'draft' && (t.days || []).length).slice(0, 12);
  // Текущая впереди, остальные от новых к старым по первому дню
  list.sort((a, b) => (b.trip_id === current) - (a.trip_id === current) || String(b.days[0].date).localeCompare(String(a.days[0].date)));
  rail.replaceChildren(...composeTrips(list.map(t => tripCard(t, t.trip_id === current))));
}

// Пока список едет с сервера: текущая поездка уже в памяти (рисуем её сразу), заглушка на своём месте и «скелетоны»
function drawTripsPlaceholder() {
  const rail = $('prof-trips');
  const t = getTrip();
  const items = [];
  if (t) items.push({ trip_id: t.trip_id, status: t.status, days: t.days.map(d => ({ date: d.date, stops: d.stops.filter(s => s.progress !== 'removed').length, visited: d.stops.filter(s => s.progress === 'visited').length })) });
  drawTrips(items);
  rail.append(...[0, 1].map(() => Object.assign(document.createElement('div'), { className: 'trip-card skeleton', innerHTML: '<i></i><i></i><i></i>' })));
}

async function renderTrips() {
  const rail = $('prof-trips');
  if (!demoTrip) { try { await loadCards(); demoTrip = demoPastTrip(); } catch { /* без каталога заглушки не будет */ } }
  if (tripsCache) drawTrips(tripsCache); else drawTripsPlaceholder();      // не ждём сервер
  try {
    const { items } = await listTrips();
    tripsCache = items;
    drawTrips(items);
  } catch {
    if (!tripsCache) rail.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Список поездок сейчас недоступен' }));
  }
}

// Альбом открывается сразу; сама поездка (окна маршрута, км) подгружается за это время, текущая — из памяти
async function openAlbum(item) {
  const el = $('pf-album');
  const current = isCurrent(item.trip_id) ? getTrip() : null;
  const key = item.trip_id + '@' + item.version;
  let trip = item.demo ? demoTrip : current || fullCache.get(key) || null;
  album = trip || { trip_id: item.trip_id, days: [], loading: true };
  $('pf-album-title').textContent = item.days?.[0] ? `Поездка · ${dateRange(localDate(item.days[0].date), localDate(item.days[item.days.length - 1].date))}` : 'Альбом поездки';
  $('pf-album-open').hidden = isCurrent(item.trip_id) || !!item.demo;
  el.classList.toggle('loading', !trip);
  renderMemory();
  el.hidden = false;
  el.querySelector('.pf-album-scroll').scrollTop = 0;
  el.animate([{ transform: 'translateX(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  if (!trip) {
    try {
      trip = await fetchTrip(item.trip_id);
      fullCache.set(key, trip);
      if (album?.trip_id === item.trip_id) { album = trip; el.classList.remove('loading'); renderMemory(); }
    } catch {
      el.classList.remove('loading');
      $('pf-lead').textContent = 'Не удалось загрузить поездку. Закройте альбом и попробуйте ещё раз.';
    }
  }
}
function closeAlbum() {
  const el = $('pf-album');
  const done = () => { el.hidden = true; album = null; };
  const a = el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }], { duration: 200, easing: 'ease-in' });
  a.onfinish = done; a.oncancel = done;
}

// ---------- Сторис: картинка 1080×1920 ----------
const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
const FALLBACK_OLD = ['media/windows/kremlin-old.jpg', 'media/windows/pokrovka-old.jpg', 'media/windows/minin-old.jpg'];

async function buildStory() {
  await document.fonts.load('800 100px Nunito').catch(() => {});
  const st = tripStats(album);
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px Nunito, system-ui, sans-serif`;

  // Фон: глубокий синий с цветными «конфетти»
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0F1628'); bg.addColorStop(0.55, '#16306E'); bg.addColorStop(1, '#2463D6');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
  glow(930, 230, 430, 'rgba(232,100,31,.55)'); glow(120, 1380, 520, 'rgba(255,201,74,.30)'); glow(900, 1750, 420, 'rgba(36,99,214,.55)');
  [[120, 330, 14, '#FFC94A'], [980, 560, 10, '#fff'], [60, 820, 9, '#E8641F'], [1010, 940, 14, '#FFC94A'], [170, 1100, 8, '#fff'], [960, 1500, 11, '#E8641F']]
    .forEach(([x, y, r, col]) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); });

  // Верх: метка и заголовок
  g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(72, 90, 560, 76, 38); g.fill();
  g.fillStyle = '#fff'; g.font = font(800, 34); g.fillText('ОКНО В ПРОШЛОЕ · НИЖНИЙ', 106, 140);
  if (st.range) { g.fillStyle = '#C9D2E3'; g.font = font(700, 34); g.fillText(st.range, 664, 140); }
  g.fillStyle = '#fff'; g.font = font(800, 104); const byKm = st.walkedKm >= 0.1;
  g.fillText(byKm ? 'Мы прошли' : 'Мы открыли', 72, 330);

  // Гигантское число с градиентом
  const km = byKm ? fmtKm(st.walkedKm) : String(st.opened.length);
  g.font = font(800, 400);
  const numW = g.measureText(km).width;
  const ng = g.createLinearGradient(72, 380, 72 + numW, 700);
  ng.addColorStop(0, '#FFC94A'); ng.addColorStop(1, '#E8641F');
  g.fillStyle = ng; g.fillText(km, 66, 700);
  g.fillStyle = '#fff'; g.font = font(800, 130); g.fillText(byKm ? 'км' : plural(st.opened.length, 'окно', 'окна', 'окон'), 90 + numW, 700);
  g.fillStyle = '#C9D2E3'; g.font = font(700, 58); g.fillText(byKm ? 'вместе по Нижнему' : 'в прошлое Нижнего', 76, 790);

  // Три плашки статистики
  const tiles = [[st.opened.length, plural(st.opened.length, 'окно', 'окна', 'окон')], [st.stamps, plural(st.stamps, 'штамп', 'штампа', 'штампов')], [st.daysWithWalk || 1, plural(st.daysWithWalk || 1, 'день', 'дня', 'дней')]];
  tiles.forEach(([n, label], i) => {
    const x = 72 + i * 322;
    g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(x, 850, 300, 200, 40); g.fill();
    g.fillStyle = '#fff'; g.font = font(800, 92); g.fillText(String(n), x + 34, 960);
    g.fillStyle = '#C9D2E3'; g.font = font(700, 36); g.fillText(label, x + 34, 1018);
  });

  // Полароиды: свои фото, а если их нет — старые снимки города («тогда»)
  const own = readPhotos(album.trip_id, album).slice(0, 3);
  const polaroids = [...own.map(src => ({ src, tag: null })), ...FALLBACK_OLD.map(src => ({ src, tag: 'ТОГДА' }))].slice(0, 3);
  const rot = [-7, 4, -3];
  for (let i = 0; i < polaroids.length; i++) {
    const { src, tag } = polaroids[i];
    const img = await loadImg(src).catch(() => null);
    if (!img) continue;
    const pw = 330, ph = 400, x = 80 + i * 300, y = 1110 + (i % 2) * 34;
    g.save(); g.translate(x + pw / 2, y + ph / 2); g.rotate(rot[i] * Math.PI / 180);
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 36; g.shadowOffsetY = 14;
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(-pw / 2, -ph / 2, pw, ph, 18); g.fill();
    g.shadowColor = 'transparent';
    const iw = pw - 32, ih = ph - 96, sc = Math.max(iw / img.width, ih / img.height);
    g.save(); g.beginPath(); g.roundRect(-iw / 2, -ph / 2 + 16, iw, ih, 10); g.clip();
    g.drawImage(img, (img.width - iw / sc) / 2, (img.height - ih / sc) / 2, iw / sc, ih / sc, -iw / 2, -ph / 2 + 16, iw, ih); g.restore();
    if (tag) { g.fillStyle = '#8A5A2B'; g.beginPath(); g.roundRect(-iw / 2 + 12, ph / 2 - 120, 120, 46, 23); g.fill(); g.fillStyle = '#fff'; g.font = font(800, 28); g.fillText(tag, -iw / 2 + 32, ph / 2 - 88); }
    g.restore();
  }

  // Оленёнок в наряде — наклейка
  const fawn = await loadImg(st.fawn).catch(() => null);
  if (fawn) { g.save(); g.translate(915, 1690); g.rotate(6 * Math.PI / 180); g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 30; g.drawImage(fawn, -120, -132, 240, 264); g.restore(); }

  // Достижения
  const got = achievements(st).filter(a => a.got).slice(0, 5);
  if (got.length) {
    g.fillStyle = '#C9D2E3'; g.font = font(700, 36); g.fillText('Наши достижения', 80, 1700);
    got.forEach((a, i) => {
      const cx = 130 + i * 130, cy = 1775;
      g.fillStyle = '#FFC94A'; g.beginPath(); g.arc(cx, cy, 54, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 44, 0, Math.PI * 2); g.fill();
      g.font = font(400, 50); g.textAlign = 'center'; g.fillStyle = '#000'; g.fillText(a.icon, cx, cy + 18); g.textAlign = 'left';
    });
  }
  g.fillStyle = '#fff'; g.font = font(800, 40); g.textAlign = 'right'; g.fillText('Открой своё окно →', W - 72, 1858); g.textAlign = 'left';
  g.fillStyle = 'rgba(201,210,227,.7)'; g.font = font(600, 24); g.fillText('Старые фото: PastVu', 80, 1895);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
}

async function shareStory() {
  const btn = $('pf-share');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Рисуем сторис…';
  try {
    const blob = await buildStory();
    const file = new File([blob], 'okno-v-proshloe-story.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Наша прогулка по Нижнему' }); return; } catch { /* отменили — скачаем */ }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) { alert('Не получилось нарисовать сторис: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// hooks: { onEditProfile, onNewTrip, onSignOut, onSignIn, onOpenTrip }
export function initProfile(h) {
  hooks = { ...hooks, ...h };
  $('prof-edit').onclick = () => hooks.onEditProfile();
  $('prof-newtrip').onclick = () => hooks.onNewTrip();
  $('prof-auth').onclick = () => (isAuthenticated() ? hooks.onSignOut() : hooks.onSignIn());
  $('pf-share').onclick = shareStory;
  $('pf-album-back').onclick = closeAlbum;
  $('pf-album-open').onclick = async () => { if (!album) return; await openTrip(album.trip_id); closeAlbum(); hooks.onOpenTrip(); };
  $('pf-file').onchange = async e => {
    if (!album) return;
    const list = readPhotos(album.trip_id);
    for (const f of [...e.target.files].slice(0, MAX_PHOTOS - list.length)) {
      try { list.push(await downscale(f)); } catch { /* пропускаем битый файл */ }
    }
    if (!writePhotos(album.trip_id, list)) alert('Не хватило места в браузере — удалите одно из фото');
    e.target.value = '';
    renderMemory();
  };
}
