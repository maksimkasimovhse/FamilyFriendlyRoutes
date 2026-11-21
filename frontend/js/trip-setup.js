import { selectionReview } from './selection-review.js';
// Новая поездка: экраны 5, 7, 8 (+ шаг 2 — подбор мест из pick.js) — docs/tz-onboarding.md.
// Гость: POST /trips с полным TripInput из локальной анкеты.
// Аккаунт: POST /trips/from-profile с expected_profile_version.
// Дальше: preview generate_plan → предпросмотр → apply («Сохранить маршрут»).

import { createTrip, createTripFromProfile, planDraft, applyPreview, referenceData, planningOptions, previewDraftChange, ApiError } from './api.js';
import { openChat, resetChat, chatText } from './trip-chat.js';
import { openPlanEditor, applyLayout } from './plan-editor.js';
import { manualSelection, pickConfiguration, planningPolicyForSelections } from './recommendation-cards.js';
import { currentProfile, profileVersion } from './onboarding.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_DAYS = 14;
const LATE_HOUR = 20;   // «уже здесь» и позже 20:00 — сегодня гулять поздно, сегодняшний день недоступен

// Старт: «Центр города» — площадь Минина и Пожарского, напротив Кремля (быстро, без GPS) или «Моё местоположение».
// Геокодера адресов в проекте нет. Координаты — из датасета мест кейса.
const CENTER = { coordinates: [44.0066, 56.3273], label: 'Площадь Минина и Пожарского' };
const MY_LOCATION = 'Моё местоположение';
const isAddressStart = () => st.start.label !== CENTER.label && st.start.label !== MY_LOCATION;

// Поиск адреса: публичный Nominatim (OpenStreetMap), только в пределах Нижнего Новгорода.
// По правилам сервиса — не чаще раза в секунду и только по нажатию «Найти» (без подсказок на лету).
// Введённый адрес уходит на их сервер — в проде лучше свой геокодер.
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const CITY_BOX = '43.6,56.43,44.2,56.15';   // запад, север, восток, юг
async function searchAddress(text) {
  const url = `${GEOCODER}?${new URLSearchParams({ format: 'jsonv2', addressdetails: 1, limit: 5, 'accept-language': 'ru', viewbox: CITY_BOX, bounded: 1, q: text })}`;
  let res;
  try { res = await fetch(url); } catch { throw new Error('Не получилось связаться с сервисом поиска адресов'); }
  if (!res.ok) throw new Error('Сервис поиска адресов сейчас недоступен');
  return (await res.json()).map(x => {
    const a = x.address || {};
    const street = a.road || a.pedestrian || a.footway || '';
    const label = street ? street + (a.house_number ? ', ' + a.house_number : '') : x.display_name.split(',').slice(0, 2).join(',').trim();
    return { label, coordinates: [Number(Number(x.lon).toFixed(6)), Number(Number(x.lat).toFixed(6))] };
  }).filter((r, i, all) => all.findIndex(o => o.label === r.label) === i);   // одинаковые адреса — один раз
}
// Граница, где работает построение пеших маршрутов (internal/routing)
const inArea = ([lon, lat]) => lon >= 43.5 && lon <= 44.4 && lat >= 56.05 && lat <= 56.6;

// ---------- Даты по Москве ----------
const mskDate = d => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });        // 2026-11-21
const mskTime = () => new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
const fmtDay = (iso, opts) => new Date(iso + 'T12:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', ...opts });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return n + ' ' + (m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
}
const fmtDistance = m => m < 1000 ? Math.round(m / 10) * 10 + ' м' : (m / 1000).toFixed(1).replace('.', ',') + ' км';
function fmtDuration(sec) {
  const min = Math.round(sec / 60);
  return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
}
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '';

// ---------- Состояние поездки ----------
// Шаг и введённое запоминаем в sessionStorage (живёт, пока открыта вкладка): обновление страницы не сбрасывает мастер.
const RESUME_KEY = 'trip-setup-v1';
let st = null;
let step = 'when';
function persist() {
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ step, st })); } catch { /* приватный режим */ }
}
export function clearResume() { try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ничего */ } }
function restore() {
  try { return JSON.parse(sessionStorage.getItem(RESUME_KEY)); } catch { return null; }
}
export function markStep(name) { step = name; persist(); }
let hooks = { authenticated: false, guest: false, onBack() {}, onPick() {}, onBusy() {}, onEditProfile() {}, onLogin() {}, onDone() {} };
let draftTrip = null, preview = null, previewDay = 0;
// Правки из «Изменить план»: раскладка по дням, данные добавленных мест и убранные места. Нужны, чтобы при устаревании
// варианта (на сервере он живёт 10 минут) пересобрать план и наложить правки заново, а не потерять их.
let layout = null, layoutMeta = new Map(), userRemoved = new Set();
// Правки копятся между открытиями окна: убранное и добавленное (с днём). Убрали то, что добавили сами, — запись просто стирается.
function mergeLayout(prev, lay) {
  const removed = new Set(prev?.removed || []);
  const added = [...(prev?.added || [])];
  lay.removed.forEach(id => { const k = added.findIndex(a => a.id === id); if (k >= 0) added.splice(k, 1); else removed.add(id); });
  lay.added.forEach(a => { if (!added.some(x => x.id === a.id && x.date === a.date)) added.push(a); });
  return { removed: [...removed], added };
}
const resetEdits = () => { layout = null; layoutMeta = new Map(); userRemoved = new Set(); };
let capabilities = { free_text: false };

const todayIso = () => mskDate(new Date());
const todayAllowed = (context = st?.context || 'in_city') => !(context === 'in_city' && Number(mskTime().slice(0, 2)) >= LATE_HOUR);
const firstAllowed = context => todayAllowed(context) ? todayIso() : addDays(todayIso(), 1);

function freshState() {
  const first = firstAllowed('in_city');
  return {
    context: 'in_city', from: first, to: first, month: first.slice(0, 7), hours: 5,
    start: CENTER, returnHome: true, picked: [], request: null,
  };
}

// ---------- Экран 5: когда и откуда ----------
function renderWhen() {
  step = 'when';
  document.querySelectorAll('#trip-context button').forEach(b => b.setAttribute('aria-checked', b.dataset.ctx === st.context));
  document.querySelectorAll('#trip-hours button').forEach(b => b.setAttribute('aria-checked', Number(b.dataset.h) === st.hours));
  renderCalendar();
  persist();
  document.querySelectorAll('#start-points button').forEach(b =>
    b.setAttribute('aria-checked', b.dataset.start === 'geo' ? st.start.label === MY_LOCATION
      : b.dataset.start === 'address' ? (isAddressStart() || !!st.addrOpen) : (st.start.label === CENTER.label && !st.addrOpen)));
  $('addr-block').hidden = !(isAddressStart() || st.addrOpen);
  if (isAddressStart() && !$('addr-input').value) $('addr-input').value = st.start.label;
  $('return-home').setAttribute('aria-checked', st.returnHome !== false);
}

function renderCalendar() {
  const [y, m] = st.month.split('-').map(Number);
  const first = `${st.month}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;   // неделя с понедельника
  $('cal-month').textContent = cap(fmtDay(first, { month: 'long', year: 'numeric' }));
  $('cal-prev').disabled = st.month <= todayIso().slice(0, 7);
  const minDay = firstAllowed();
  let html = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(d => `<span class="wd">${d}</span>`).join('');
  html += '<span></span>'.repeat(offset);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${st.month}-${String(d).padStart(2, '0')}`;
    const cls = [iso === todayIso() ? 'today' : '', iso >= st.from && iso <= st.to ? 'in' : '', iso === st.from || iso === st.to ? 'edge' : ''].join(' ');
    html += `<button type="button" class="${cls}" data-d="${iso}" ${iso < minDay ? 'disabled' : ''} aria-pressed="${iso >= st.from && iso <= st.to}">${d}</button>`;
  }
  $('cal').innerHTML = html;
  $('cal').querySelectorAll('[data-d]').forEach(b => { b.onclick = () => pickDate(b.dataset.d); });
  const n = daysBetween(st.from, st.to) + 1;
  const a = cap(fmtDay(st.from, { weekday: 'short', day: 'numeric' }));
  const b = cap(fmtDay(st.to, { weekday: 'short', day: 'numeric', month: 'long' }));
  $('cal-sum').textContent = n === 1 ? `${cap(fmtDay(st.from, { weekday: 'short', day: 'numeric', month: 'long' }))} · 1 день` : `${a} — ${b} · ${plural(n, 'день', 'дня', 'дней')}`;
}

let pickingEnd = false;   // второе нажатие выбирает конец диапазона
function pickDate(iso) {
  $('when-error').hidden = true;
  if (!pickingEnd || iso < st.from) { st.from = iso; st.to = iso; pickingEnd = true; }
  else if (daysBetween(st.from, iso) + 1 > MAX_DAYS) { $('when-error').textContent = `Можно спланировать до ${MAX_DAYS} дней подряд`; $('when-error').hidden = false; return; }
  else { st.to = iso; pickingEnd = false; }
  renderCalendar();
}

function bindWhen() {
  document.querySelectorAll('#trip-context button').forEach(b => {
    b.onclick = () => {
      st.context = b.dataset.ctx;
      if (st.from < firstAllowed()) { st.from = firstAllowed(); if (st.to < st.from) st.to = st.from; }
      renderWhen();
    };
  });
  document.querySelectorAll('#trip-hours button').forEach(b => { b.onclick = () => { st.hours = Number(b.dataset.h); renderWhen(); }; });
  $('cal-prev').onclick = () => { st.month = addDays(st.month + '-01', -1).slice(0, 7); renderCalendar(); };
  $('cal-next').onclick = () => { st.month = addDays(st.month + '-28', 5).slice(0, 7); renderCalendar(); };
  $('return-home').onclick = () => { st.returnHome = !(st.returnHome !== false); renderWhen(); };
  $('start-points').querySelector('[data-start="center"]').onclick = () => { st.start = CENTER; st.addrOpen = false; $('start-note').hidden = true; renderWhen(); };
  $('start-points').querySelector('[data-start="address"]').onclick = () => { st.addrOpen = true; $('start-note').hidden = true; renderWhen(); $('addr-input').focus(); };
  $('addr-form').onsubmit = async e => {
    e.preventDefault();
    const text = $('addr-input').value.trim();
    const note = t => { $('start-note').textContent = t; $('start-note').hidden = !t; };
    if (text.length < 3) return note('Введите улицу и дом');
    note('');
    $('addr-go').disabled = true;
    $('addr-results').innerHTML = '';
    try {
      const found = await searchAddress(text);
      if (!found.length) return note('Такого адреса в Нижнем не нашли. Попробуйте иначе: улица и номер дома.');
      found.forEach(r => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = r.label;
        b.onclick = () => { st.start = { coordinates: r.coordinates, label: r.label }; st.addrOpen = true; $('addr-results').innerHTML = ''; renderWhen(); };
        li.append(b);
        $('addr-results').append(li);
      });
    } catch (err) {
      note(err.message);
    } finally {
      $('addr-go').disabled = false;
    }
  };
  $('start-points').querySelector('[data-start="geo"]').onclick = () => {
    const note = text => { $('start-note').textContent = text; $('start-note').hidden = !text; };
    if (!navigator.geolocation) return note('Браузер не умеет определять местоположение');
    note('');
    navigator.geolocation.getCurrentPosition(pos => {
      const point = [Number(pos.coords.longitude.toFixed(6)), Number(pos.coords.latitude.toFixed(6))];
      if (!inArea(point)) return note('Вы далеко от Нижнего — выберите «Центр города»');
      st.start = { coordinates: point, label: MY_LOCATION };
      renderWhen();
    }, e => {
      note('Не получилось определить местоположение: ' + e.message + (location.protocol !== 'https:' && location.hostname !== 'localhost' ? ' (на телефоне нужен HTTPS)' : ''));
    }, { enableHighAccuracy: true, timeout: 10000 });
  };
  $('when-next').onclick = () => { $('trip-when').hidden = true; backToChat(); };
  $('trip-when').querySelector('[data-back]').onclick = () => { $('trip-when').hidden = true; hooks.onBack(); };
}

// ---------- Сборка запроса ----------
function dayInputs() {
  const n = daysBetween(st.from, st.to) + 1;
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(st.from, i);
    // «Уже здесь» и сегодня — с текущей минуты до 21:00; иначе 10:00–20:00 [Предложение, согласовать с Максимом]
    const isNow = st.context === 'in_city' && date === todayIso();
    const startAt = isNow ? mskTime() : '10:00';
    const endAt = isNow ? '21:00' : '20:00';
    const windowSec = (Number(endAt.slice(0, 2)) * 60 - (Number(startAt.slice(0, 2)) * 60 + Number(startAt.slice(3)))) * 60;
    return {
      date,
      start_point: st.start,
      end_point: st.start,   // день заканчиваем там же, где начали
      available_window: { start_at: `${date}T${startAt}:00+03:00`, end_at: `${date}T${endAt}:00+03:00` },
      duration_budget_sec: Math.max(1800, Math.min(st.hours * 3600, windowSec)),
      meal_window: null,
      rest_budget_sec: 0,
    };
  });
}

// request_text: пожелания анкеты + то, что семья написала в ИИ-чате. Ничего не писали — null (backend возьмёт пожелания анкеты).
// В demo-режиме backend свободный текст не принимает → всегда "".
function requestText() {
  if (!capabilities.free_text) return '';
  const chat = chatText().trim();
  if (!chat) return null;
  return [(currentProfile()?.wishes || '').trim(), chat].filter(Boolean).join('\n');
}

function buildRequest() {
  const days = dayInputs();
  const selections = st.picked.filter(c=>c.preferred_date==null || days.some(d=>d.date===c.preferred_date)).map(manualSelection);
  const base = { city_id: 'nizhny_novgorod', timezone: 'Europe/Moscow', planning_context: st.context, days, planning_policy:planningPolicyForSelections(selections), selections, request_text: requestText() };
  if (hooks.authenticated) return { ...base, expected_profile_version: profileVersion() };
  const p = currentProfile();
  return { ...base, family: p.family, load_limits: p.load_limits };
}
export async function prepareInitialChoices() {
  const req = buildRequest(); req.selections = [];
  const t = await (hooks.authenticated ? createTripFromProfile(req) : createTrip(req));
  const options = await planningOptions(t);
  return pickConfiguration(options,{selected:st.picked});
}

function humanError(e) {
  if (e.code === 'NETWORK') return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  if (e.status === 503) return 'Сервис подбора мест сейчас недоступен. Попробуйте через минуту.';
  if (e.status === 502) return 'Не удалось построить пеший маршрут: сервис маршрутов не ответил.';
  if (e.status === 422) return 'Маршрут с такими параметрами не построить: ' + e.message;
  if (e.status === 401) return 'Сессия истекла — войдите снова.';
  return e.message;
}

// После подбора мест маршрут строится сразу (раньше был отдельный шаг «Что-то особенное»; пожелания теперь пишут в ИИ-чате)
async function build() {
  hooks.onBusy('Строим маршрут…');
  try {
    const req = buildRequest();
    draftTrip = await (hooks.authenticated ? createTripFromProfile(req) : createTrip(req));
    preview = await planDraft(draftTrip);
    resetEdits();
    previewDay = 0;
    hooks.onBusy('');
    renderPreview();
    $('trip-preview').hidden = false;
  } catch (e) {
    hooks.onBusy('');
    backToWhen();
    $('when-error').textContent = humanError(e);
    $('when-error').hidden = false;
  }
}

// ---------- Экран 8: предпросмотр ----------
function renderPreview() {
  const trip = preview.proposed_trip;
  const days = trip.days;
  $('preview-title').textContent = `Маршрут на ${plural(days.length, 'день', 'дня', 'дней')}`;
  $('preview-days').innerHTML = days.length > 1 ? days.map((d, i) =>
    `<button type="button" role="tab" aria-selected="${i === previewDay}" data-i="${i}" ${d.feasibility === 'infeasible' ? 'data-warn' : ''}>${cap(fmtDay(d.date, { weekday: 'short', day: 'numeric' }))}</button>`).join('') : '';
  $('preview-days').querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { previewDay = Number(b.dataset.i); renderPreview(); }; });

  const day = days[previewDay];
  const t = day.totals;
  $('preview-line').textContent = `${cap(fmtDay(day.date, { weekday: 'long', day: 'numeric', month: 'long' }))} · около ${fmtDuration(t.elapsed_duration_sec || 0)} · ${fmtDistance(t.walk_distance_m || 0)} пешком`;
  const stops = day.stops.map((s, i) => {
    const time = fmtTime(s.timing?.estimated_arrival_at);
    return `<li><span class="n">${i + 1}</span><span><b>${esc(s.title)}</b><small>${time ? time + ' · ' : ''}на месте ~${fmtDuration(s.duration.duration_sec)}</small></span></li>`;
  }).join('');
  $('preview-list').innerHTML = `
    <li><span class="n end">▶</span><span><b>Старт</b><small>${esc(day.start_point.label || 'точка старта')}</small></span></li>
    ${stops || '<li><span><small>На этот день мест не нашлось — попробуйте больше часов или другие даты</small></span></li>'}
    <li><span class="n end">■</span><span><b>Финиш</b><small>${esc(day.end_point.label || 'точка финиша')}</small></span></li>`;
  renderSelectionReview();
  let minimumPanel=$('preview-auto-minimum');
  if(!minimumPanel){minimumPanel=document.createElement('p');minimumPanel.id='preview-auto-minimum';minimumPanel.className='selection-overflow';minimumPanel.setAttribute('role','alert');$('preview-line').after(minimumPanel);}
  const minimumWarnings=trip.warnings.filter(w=>w.code==='AUTO_DAY_BELOW_MINIMUM');
  minimumPanel.hidden=!minimumWarnings.length;minimumPanel.textContent=minimumWarnings.map(w=>w.message).join(' ');

  // Предупреждения бекенда о данных пользователю не показываем (подтверждаем при сохранении). Перегрузку и пустые дни — показываем.
  const overloaded = days.filter(d => d.feasibility === 'infeasible');
  const total = days.reduce((n, d) => n + d.stops.length, 0);
  const lowDays = days.filter(d => d.stops.length < 2);
  const dayName = d => cap(fmtDay(d.date, { weekday: 'short', day: 'numeric' }));
  const overload = $('preview-overload');
  if (overloaded.length && preview.can_apply) {
    overload.textContent = `${overloaded.length > 1 ? 'В днях' : 'В день'} ${overloaded.map(dayName).join(', ')} не хватает времени или сил на ходьбу. Можно убрать часть мест через «Изменить план» или сохранить как есть: маршрут сохранится с вашими местами.`;
    overload.hidden = false;
  } else if (!preview.can_apply) {
    overload.textContent = total ? 'Этот вариант сохранить нельзя. Откройте «Изменить план» и уберите или перенесите места.' : 'В плане нет ни одного места. Откройте «Изменить план» и добавьте места карточками.';
    overload.hidden = false;
  } else { overload.hidden = true; }
  const low = $('preview-lowcount');
  low.hidden = !(total && lowDays.length);
  low.textContent = lowDays.length ? `${lowDays.length > 1 ? 'В днях' : 'В день'} ${lowDays.map(dayName).join(', ')} меньше двух мест — добавьте ещё через «Изменить план».` : '';
  $('preview-save').disabled = !preview.can_apply;
  $('preview-save').textContent = overloaded.length && preview.can_apply ? 'Сохранить всё равно' : 'Сохранить маршрут';
  $('preview-error').hidden = true;
  renderCompletionOffer();
}

// Выбранные места, которые не вошли в план. То, что человек убрал сам в «Изменить план», сюда не попадает.
function reviewOf(trip) {
  const cards = selectionReview(trip).cards.filter(card => !userRemoved.has(card.activityId));
  return { cards, excludedCount: cards.filter(card => card.missing).length };
}
let selectionBusy=false;
// Список «Выбранные места» убран. Остался только короткий текст, если часть выбранных мест не вошла в план.
function renderSelectionReview() {
  let panel = $('preview-selection-review');
  if (!panel) { panel = document.createElement('section'); panel.id = 'preview-selection-review'; panel.className = 'selection-review'; $('preview-list').after(panel); }
  const { excludedCount } = reviewOf(preview.proposed_trip);
  panel.hidden = !excludedCount;
  panel.innerHTML = excludedCount
    ? `<p class="selection-overflow" role="alert"><b>${plural(excludedCount, 'выбранное место не вошло', 'выбранных места не вошли', 'выбранных мест не вошли')} в маршрут.</b> Не хватает времени или сил на ходьбу, либо место недоступно в выбранные даты. Добавьте его через «Изменить план» или сохраните как есть.</p>`
    : '';
}

function renderCompletionOffer() {
  let panel = $('preview-completion');
  if (!panel) { panel = document.createElement('div'); panel.id = 'preview-completion'; $('preview-list').after(panel); }
  panel.replaceChildren();
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn alt'; button.textContent = 'Изменить план';
  button.onclick = () => {
    const change = (command, baseId) => previewDraftChange(draftTrip, command, baseId);
    const idsOf = pv => new Set(pv.proposed_trip.days.flatMap(d => d.stops.map(x => x.activity_id)));
    openPlanEditor({
      preview,
      change,
      // Вариант устарел: строим план заново и накладываем прежние правки
      refresh: async () => {
        const fresh = await planDraft(draftTrip);
        return layout ? applyLayout({ preview: fresh, layout, change, meta: layoutMeta }) : fresh;
      },
      // Экран подбора мест поверх окна: выбранные карточки возвращаются в редактор
      pickCards: (date, cards, title) => new Promise(resolve => {
        $('trip-preview').hidden = true;
        hooks.onSupplement({ days: [{ date, limit: Infinity, anchorOnFirstPick: false, radiusM: 0 }], cardsByDay: { [date]: cards }, selected: [], title },
          async chosen => { $('trip-preview').hidden = false; resolve(chosen); },
          () => { $('trip-preview').hidden = false; resolve(null); });
      }),
      onDone: (next, lay, meta) => {
        const before = idsOf(preview), after = idsOf(next);
        before.forEach(id => { if (!after.has(id)) userRemoved.add(id); });
        after.forEach(id => userRemoved.delete(id));
        meta.forEach((v, k) => layoutMeta.set(k, v));
        layout = mergeLayout(layout, lay); preview = next; renderPreview();
      },
    });
  };
  panel.append(button);
}

function renderPreviewSaveButton() {
  const overloaded = preview?.proposed_trip.days.some(d => d.feasibility === 'infeasible');
  $('preview-save').textContent = overloaded && preview.can_apply ? 'Сохранить всё равно' : 'Сохранить маршрут';
  $('preview-save').disabled = selectionBusy || !preview?.can_apply;
}

async function savePreview() {
  if (selectionBusy) return;
  const btn = $('preview-save');
  btn.disabled = true;
  btn.textContent = 'Сохраняем…';
  try {
    const trip = await applyPreview(preview, preview.required_acknowledgement_codes || []);
    $('trip-preview').hidden = true;
    clearResume();
    hooks.onDone(trip, st.picked);
  } catch (e) {
    if (e.code === 'PREVIEW_EXPIRED' || e.code === 'PREVIEW_STALE') {
      // Вариант устарел (на сервере он живёт 10 минут): строим план заново и накладываем ваши правки
      try {
        const fresh = await planDraft(draftTrip);
        const change = (command, baseId) => previewDraftChange(draftTrip, command, baseId);
        preview = layout ? await applyLayout({ preview: fresh, layout, change, meta: layoutMeta }) : fresh;
        renderPreview();
        $('preview-error').textContent = layout ? 'Время ушло вперёд — мы пересчитали маршрут с вашими правками. Проверьте и сохраните.' : 'Время ушло вперёд — мы пересчитали маршрут. Проверьте и сохраните.';
      } catch (e2) { $('preview-error').textContent = humanError(e2); }
    } else {
      $('preview-error').textContent = humanError(e);
    }
    $('preview-error').hidden = false;
  } finally {
    if (!$('trip-preview').hidden) { renderPreviewSaveButton(); }
  }
}

// ---------- Вход в поток ----------
let bound = false;
// hooks: { authenticated, guest, onBack(), onPick(), onEditProfile(), onLogin(), onDone(trip, picked) }
export async function openTripSetup(h, { keep = false, resume = false } = {}) {
  hooks = { ...hooks, ...h };
  try { capabilities = (await referenceData()).capabilities || capabilities; } catch { /* оставляем demo */ }
  const saved = resume ? restore() : null;
  if (saved?.st) {
    st = saved.st;
    // Даты в прошлом (вчерашняя вкладка) не оставляем
    if (st.from < firstAllowed(st.context)) { st.from = st.to = firstAllowed(st.context); st.month = st.from.slice(0, 7); }
    step = saved.step;
  } else if (!st || !keep) { st = freshState(); pickingEnd = false; step = 'when'; resetChat(); }
  if (!bound) {
    bound = true;
    bindWhen();
    $('trip-preview').querySelector('[data-back]').onclick = () => {
      if (layout && !confirm('Правки плана ещё не сохранены. Вернуться к подбору мест и потерять их?')) return;
      $('trip-preview').hidden = true; goPick();
    };
    $('preview-save').onclick = savePreview;
  }
  // Вернуться туда, где остановились до обновления страницы
  if (saved?.st && step === 'chat') { backToChat(); return; }
  if (saved?.st && step === 'pick') { goPick(); return; }
  if (saved?.st && (step === 'wishes' || step === 'preview')) { goPick(); return; }
  renderWhen();
  $('trip-when').hidden = false;
}

// Подбор мест закончен (выбраны или пропущены) → маршрут строится сразу.
export function afterPick(places) {
  st.picked = places || [];
  build();
}
// Шаг 2 — ИИ-чат: пожелания словами → подобранные карточки для шага 3
export function backToChat() {
  step = 'chat'; persist();
  openChat({
    onBack: () => { renderWhen(); $('trip-when').hidden = false; },
    onDone: ids => { st.chatIds = ids; goPick(); },
  });
}
// Шаг 3: подбор мест; порядок карточек подсказывает чат
const goPick = () => hooks.onPick(st.chatIds || null);
// Вернуться к шагу 1 («‹» на экране чата или после ошибки)
export function backToWhen() { renderWhen(); $('trip-when').hidden = false; }
// Вернуться к предпросмотру (после входа гостя)
export function backToPreview() { if (preview) { hooks.authenticated = true; renderPreview(); $('trip-preview').hidden = false; } }
export function closeTripSetup() { ['trip-when', 'trip-chat', 'trip-preview'].forEach(s => { $(s).hidden = true; }); }
