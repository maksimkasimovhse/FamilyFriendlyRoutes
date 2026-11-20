// Новая поездка: экраны 5, 7, 8 (+ шаг 2 — подбор мест из pick.js) — docs/tz-onboarding.md.
// Гость: POST /trips с полным TripInput из локальной анкеты.
// Аккаунт: POST /trips/from-profile с expected_profile_version.
// Дальше: preview generate_plan → предпросмотр → apply («Сохранить маршрут»).

import { createTrip, createTripFromProfile, planDraft, applyPreview, referenceData, planningOptions, previewManualChoices, ApiError } from './api.js';
import { manualSelection, pickConfiguration, planningPolicyForSelections } from './recommendation-cards.js';
import { currentProfile, profileVersion, familySummary, childName } from './onboarding.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_DAYS = 14;
const LATE_HOUR = 20;   // «уже здесь» и позже 20:00 — сегодня гулять поздно, сегодняшний день недоступен

// Готовые точки старта (геокодера адресов в проекте нет). Координаты — из датасета мест кейса.
const PRESETS = [
  { coordinates: [44.0066, 56.3273], label: 'Площадь Минина и Пожарского' },
  { coordinates: [43.998938, 56.320757], label: 'Большая Покровская улица' },
  { coordinates: [43.991344, 56.330481], label: 'Нижне-Волжская набережная' },
  { coordinates: [43.988951, 56.328575], label: 'Улица Рождественская' },
];
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
let hooks = { authenticated: false, guest: false, onBack() {}, onPick() {}, onEditProfile() {}, onLogin() {}, onDone() {} };
let draftTrip = null, preview = null, previewDay = 0;
let completionOptions = null;
let capabilities = { free_text: false };

const todayIso = () => mskDate(new Date());
const todayAllowed = (context = st?.context || 'in_city') => !(context === 'in_city' && Number(mskTime().slice(0, 2)) >= LATE_HOUR);
const firstAllowed = context => todayAllowed(context) ? todayIso() : addDays(todayIso(), 1);

function freshState() {
  const first = firstAllowed('in_city');
  return {
    context: 'in_city', from: first, to: first, month: first.slice(0, 7), hours: 5,
    start: PRESETS[0], returnHome: true, end: PRESETS[0], picked: [], request: null,
  };
}

// ---------- Экран 5: когда и откуда ----------
function renderWhen() {
  step = 'when';
  document.querySelectorAll('#trip-context button').forEach(b => b.setAttribute('aria-checked', b.dataset.ctx === st.context));
  document.querySelectorAll('#trip-hours button').forEach(b => b.setAttribute('aria-checked', Number(b.dataset.h) === st.hours));
  renderCalendar();
  persist();
  renderPoints('start-points', st.start, p => { st.start = p; renderWhen(); });
  renderPoints('end-points', st.end, p => { st.end = p; renderWhen(); });
  $('return-home').setAttribute('aria-checked', st.returnHome);
  $('end-block').hidden = st.returnHome;
}

function renderPoints(id, current, pick) {
  const list = PRESETS.some(p => p.label === current.label) ? PRESETS : [...PRESETS, current];
  $(id).innerHTML = '';
  list.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = p.label;
    b.setAttribute('aria-checked', p.label === current.label);
    b.onclick = () => pick(p);
    $(id).append(b);
  });
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
  $('return-home').onclick = () => { st.returnHome = !st.returnHome; renderWhen(); };
  $('start-geo').onclick = () => {
    if (!navigator.geolocation) { $('start-note').textContent = 'Браузер не умеет определять местоположение'; return; }
    $('start-note').textContent = 'Определяем…';
    navigator.geolocation.getCurrentPosition(pos => {
      const point = [Number(pos.coords.longitude.toFixed(6)), Number(pos.coords.latitude.toFixed(6))];
      if (!inArea(point)) { $('start-note').textContent = 'Вы далеко от Нижнего — выберите точку из списка'; return; }
      st.start = { coordinates: point, label: 'Моё местоположение' };
      $('start-note').textContent = '';
      renderWhen();
    }, e => {
      $('start-note').textContent = 'Не получилось: ' + e.message + (location.protocol !== 'https:' && location.hostname !== 'localhost' ? ' (нужен HTTPS)' : '');
    }, { enableHighAccuracy: true, timeout: 10000 });
  };
  $('when-next').onclick = () => { $('trip-when').hidden = true; hooks.onPick(); };
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
      end_point: st.returnHome ? st.start : st.end,
      available_window: { start_at: `${date}T${startAt}:00+03:00`, end_at: `${date}T${endAt}:00+03:00` },
      duration_budget_sec: Math.max(1800, Math.min(st.hours * 3600, windowSec)),
      meal_window: null,
      rest_budget_sec: 0,
    };
  });
}

// request_text: не меняли — null (backend возьмёт пожелания анкеты), очистили — "", иначе текст.
// В demo-режиме backend свободный текст не принимает → всегда "".
function requestText() {
  if (!capabilities.free_text) return '';
  const text = $('trip-request').value.trim();
  const original = (currentProfile()?.wishes || '').trim();
  if (text === original) return null;
  return text;
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

// ---------- Экран 7: пожелания и итог ----------
function renderWishes() {
  step = 'wishes';
  const p = currentProfile();
  if (st.request === null) st.request = p?.wishes || '';
  $('trip-request').value = st.request;
  $('request-hint').textContent = capabilities.free_text
    ? 'Пожелания из анкеты уже здесь. Допишите, что нужно именно сейчас — анкета не изменится.'
    : 'Пожелания пока учитываются не полностью: подбор мест работает в демо-режиме.';
  const n = daysBetween(st.from, st.to) + 1;
  const kids = p.family.children.map((c, i) => `${childName(i)}: ${c.interest_ids.length ? plural(c.interest_ids.length, 'интерес', 'интереса', 'интересов') : 'подберём сами'}`).join('; ');
  const rows = [
    ['Семья', familySummary(p), 'profile'],
    ['Интересы', kids, 'profile'],
    ['Когда', `${$('cal-sum').textContent || plural(n, 'день', 'дня', 'дней')} · до ${st.hours} ч в день`, 'when'],
    ['Старт', st.start.label + (st.returnHome ? ' · возвращаемся сюда' : ` → ${st.end.label}`), 'when'],
    ['Выбрано вручную', st.picked.length ? plural(st.picked.length, 'место', 'места', 'мест') + ' · до двух на день' : 'подберём сами', 'pick'],
  ];
  $('trip-summary').innerHTML = rows.map(([k, v, to]) => `<dt>${k}</dt><dd>${esc(v)}</dd><dd><button type="button" data-to="${to}">Изм.</button></dd>`).join('');
  persist();
  $('trip-summary').querySelectorAll('[data-to]').forEach(b => {
    b.onclick = () => {
      st.request = $('trip-request').value;
      $('trip-wishes').hidden = true;
      if (b.dataset.to === 'when') { renderWhen(); $('trip-when').hidden = false; }
      else if (b.dataset.to === 'pick') hooks.onPick();
      else hooks.onEditProfile();
    };
  });
}

function humanError(e) {
  if (e.code === 'NETWORK') return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  if (e.status === 503) return 'Сервис подбора мест сейчас недоступен. Попробуйте через минуту.';
  if (e.status === 502) return 'Не удалось построить пеший маршрут: сервис маршрутов не ответил.';
  if (e.status === 422) return 'Маршрут с такими параметрами не построить: ' + e.message;
  if (e.status === 401) return 'Сессия истекла — войдите снова.';
  return e.message;
}

async function build() {
  const btn = $('trip-build');
  btn.disabled = true;
  btn.textContent = 'Строим маршрут…';
  $('wishes-error').hidden = true;
  st.request = $('trip-request').value;
  try {
    const req = buildRequest();
    draftTrip = await (hooks.authenticated ? createTripFromProfile(req) : createTrip(req));
    preview = await planDraft(draftTrip);
    completionOptions = null;
    previewDay = 0;
    $('trip-wishes').hidden = true;
    renderPreview();
    $('trip-preview').hidden = false;
    await refreshCompletionOptions();
  } catch (e) {
    $('wishes-error').textContent = humanError(e);
    $('wishes-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Построить маршрут';
  }
}

// ---------- Экран 8: предпросмотр ----------
function renderPreview() {
  const trip = preview.proposed_trip;
  const days = trip.days;
  $('preview-title').textContent = `Маршрут на ${plural(days.length, 'день', 'дня', 'дней')}`;
  $('preview-days').innerHTML = days.length > 1 ? days.map((d, i) =>
    `<button type="button" role="tab" aria-selected="${i === previewDay}" data-i="${i}">${cap(fmtDay(d.date, { weekday: 'short', day: 'numeric' }))}</button>`).join('') : '';
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
  let excluded = $('preview-excluded');
  if (!excluded) { excluded = document.createElement('p'); excluded.id='preview-excluded'; excluded.className='small'; $('preview-list').after(excluded); }
  const missing=trip.input.selections.filter(s=>(s.preferred_date===day.date || (s.preferred_date==null && day===days[0])) && !days.some(d=>d.stops.some(stop=>stop.activity_id===s.activity_id)));
  const names=new Map((trip.recommendation_snapshot?.candidates || []).map(c=>[c.activity.activity_id,c.activity.title]));
  excluded.hidden=!missing.length;
  excluded.textContent=missing.length ? `Не удалось включить выбранные места: ${missing.map(s=>names.get(s.activity_id)||s.activity_id).join(', ')}. Проверьте доступное время, лимит ходьбы и даты.` : '';

  // Предупреждения, которые нужно подтвердить перед сохранением
  const codes = preview.required_acknowledgement_codes || [];
  $('preview-ack').hidden = !codes.length;
  if (codes.length) {
    const msgs = [...new Set(trip.warnings.filter(w => codes.includes(w.code)).map(w => w.message))];
    $('preview-ack-text').textContent = msgs.length ? 'Понимаю: ' + msgs.join(' ').replace(/\.\s*$/, '') + '. Уточню перед выходом.' : 'Часы работы проверены не у всех мест — уточню перед выходом';
  }
  $('preview-ack-box').checked = false;
  $('preview-save').disabled = !preview.can_apply || codes.length > 0;
  $('preview-guest').hidden = hooks.authenticated;
  $('preview-error').hidden = true;
  renderCompletionOffer();
}
function renderCompletionOffer() {
  let panel = $('preview-completion');
  if (!panel) { panel = document.createElement('div'); panel.id = 'preview-completion'; $('preview-list').after(panel); }
  panel.replaceChildren();
  const row = completionOptions?.days.find(d=>d.date===preview.proposed_trip.days[previewDay].date);
  if (!row?.is_short) return;
  const text = document.createElement('p');
  text.className='small';
  text.textContent = `День заполнен на ${Math.round(row.fill_ratio*100)}%. ` + (row.remaining_manual_choices ? row.anchor ? `Можно предложить места в пределах ${completionOptions.policy.supplement_radius_m / 1000} км от последней активности.` : 'День пустой — предложим подходящие места без привязки к старту.' : 'Два ручных выбора на этот день уже использованы.');
  panel.append(text);
  if (!row.remaining_manual_choices || !row.candidates.length) {
    if (row.remaining_manual_choices) text.textContent += ' В текущем пуле нет дополнительных мест, которые помещаются в этот день.';
    return;
  }
  const button = document.createElement('button');button.type='button';button.className='btn alt';button.textContent='Дополнить этот день';
  button.onclick=()=> {
    const options = {...completionOptions,days:[row]};
    $('trip-preview').hidden=true;
    hooks.onSupplement(pickConfiguration(options,{supplemental:true}),async cards=>{
      preview=await previewManualChoices(draftTrip,row.date,cards.map(manualSelection),preview.preview_id);
      completionOptions=null;renderPreview();$('trip-preview').hidden=false;await refreshCompletionOptions();
    },()=>{$('trip-preview').hidden=false;});
  };
  panel.append(button);
}
async function refreshCompletionOptions() {
  const current=preview;
  try { const result=await planningOptions(draftTrip,current.preview_id);if(preview===current){completionOptions=result;renderCompletionOffer();} }
  catch(err) { console.warn('Дополнение маршрута:',err.message); }
}

async function savePreview() {
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
      // Вариант устарел (время ушло вперёд) — пересчитываем и показываем заново
      preview = await planDraft(draftTrip).catch(() => null);
      if (preview) { completionOptions=null;renderPreview();refreshCompletionOptions(); $('preview-error').textContent = 'Время ушло вперёд — мы пересчитали маршрут. Проверьте и сохраните.'; }
      else $('preview-error').textContent = humanError(e);
    } else {
      $('preview-error').textContent = humanError(e);
    }
    $('preview-error').hidden = false;
  } finally {
    btn.textContent = 'Сохранить маршрут';
    if (!$('trip-preview').hidden) btn.disabled = !preview?.can_apply || !$('preview-ack').hidden && !$('preview-ack-box').checked;
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
  } else if (!st || !keep) { st = freshState(); pickingEnd = false; step = 'when'; }
  if (!bound) {
    bound = true;
    bindWhen();
    $('trip-build').onclick = build;
    $('trip-wishes').querySelector('[data-back]').onclick = () => { st.request = $('trip-request').value; $('trip-wishes').hidden = true; hooks.onPick(); };
    $('trip-preview').querySelector('[data-back]').onclick = () => { $('trip-preview').hidden = true; renderWishes(); $('trip-wishes').hidden = false; };
    $('preview-ack-box').onchange = e => { $('preview-save').disabled = !preview?.can_apply || !e.target.checked; };
    $('preview-save').onclick = savePreview;
    $('preview-login').onclick = () => hooks.onLogin();
  }
  // Вернуться туда, где остановились до обновления страницы
  if (saved?.st && step === 'pick') { hooks.onPick(); return; }
  if (saved?.st && step === 'wishes') { renderWishes(); $('trip-wishes').hidden = false; return; }
  renderWhen();
  $('trip-when').hidden = false;
}

// Шаг 2 закончен (места выбраны или пропущены) → шаг 3
export function afterPick(places) {
  st.picked = places || [];
  renderWishes();
  $('trip-wishes').hidden = false;
}
// Вернуться к шагу 1 из подбора мест («‹» на экране карточек)
export function backToWhen() { renderWhen(); $('trip-when').hidden = false; }
// Вернуться на шаг 3 после правки анкеты
export function backToWishes() { renderWishes(); $('trip-wishes').hidden = false; }
// Вернуться к предпросмотру (после входа гостя)
export function backToPreview() { if (preview) { hooks.authenticated = true; renderPreview(); $('trip-preview').hidden = false; } }
export function closeTripSetup() { ['trip-when', 'trip-wishes', 'trip-preview'].forEach(s => { $(s).hidden = true; }); }
