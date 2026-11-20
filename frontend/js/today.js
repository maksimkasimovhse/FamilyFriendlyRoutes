// Экран «Сегодня» — главный экран родителя (макет «Сегодня и Карта: что сейчас и что рядом»).
// Карточка «Сейчас» + лента со временем. Под каждой точкой — одна «семейная» строка:
// что там у ребёнка (задание / штамп) и что рядом (туалет, кафе для детей).

import { onTripChange, today, getSource, startDay, markVisited, previewRemove, applyPreview, ApiError } from './api.js';
import { nearest, walkMinutes, isFamilyCafe } from './places.js';

const $ = id => document.getElementById(id);
let opt = { childName: 'Маша', childNameGenitive: 'Маши', kidStopInfo: () => null, onOpenKid: () => {}, onNeedNow: () => {} };
let busy = false;
let pendingSkip = null;

// ---------- Форматирование ----------
const fmtDistance = m => m < 1000 ? Math.round(m / 10) * 10 + ' м' : (m / 1000).toFixed(1).replace('.', ',') + ' км';
function fmtDuration(sec) {
  const min = Math.max(0, Math.round(sec / 60));
  if (min < 60) return min + ' мин';
  return Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
}
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '';
const weekday = date => new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const legTo = (day, stop) => [...day.legs].reverse().find(l => l.to.stop_id === stop.stop_id);

// Что у ребёнка на остановке — строка и плашка
function kidLine(stop) {
  const k = opt.kidStopInfo(stop.activity_id);
  if (!k) return null;
  if (stop.progress === 'visited') return k.done ? `пройдено, штамп у ${opt.childNameGenitive}` : `у ${opt.childNameGenitive} ещё не открыто`;
  return `у ${opt.childNameGenitive} задание: ${k.label.toLowerCase()}`;
}
// Что полезного рядом с точкой (до ~5 минут пешком)
function nearbyChips(point) {
  const chips = [];
  const wc = nearest(point, 'toilets', 1)[0];
  if (wc && wc.dist < 350) chips.push({ cls: 'ok', text: `туалет · ${walkMinutes(wc.dist)} мин` });
  const cafe = nearest(point, 'cafe', 1, isFamilyCafe)[0];
  if (cafe && cafe.dist < 350) chips.push({ cls: 'sun', text: `кафе для детей · ${walkMinutes(cafe.dist)} мин` });
  return chips;
}
const chipHtml = c => `<span class="chip-s ${c.cls}">${esc(c.text)}</span>`;

// ---------- Отрисовка ----------
const ICON = {
  window: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>',
  place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m0 0h11l-2 4 2 4H6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
};
const iconFor = (stop, kid) => stop.progress === 'visited' ? ICON.done : kid ? ICON[kid.type] : ICON.place;

function render() {
  const day = today();
  if (!day) return;
  const live = getSource() === 'backend';
  const started = !!day.execution;
  const stops = day.stops.filter(s => s.progress !== 'removed');
  const next = stops.find(s => s.progress === 'planned');
  const doneCount = stops.filter(s => s.progress === 'visited').length;
  const walked = day.execution?.consumed_walk_distance_m || 0;

  $('today-sub').textContent = cap(new Date(day.date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));

  // ----- Шаги дня: кружок на каждую точку -----
  $('today-stats').innerHTML = `
    <div class="bead-row">${stops.map(s => {
      const kid = opt.kidStopInfo(s.activity_id);
      const cls = s.progress === 'visited' ? 'done' : s === next ? 'now' : s.progress === 'skipped' ? 'skip' : '';
      return `<span class="bead ${cls}" title="${esc(s.title)}">${iconFor(s, kid)}</span>`;
    }).join('<i></i>')}</div>
    <p class="bead-text">${doneCount} из ${stops.length} точек · ${fmtDistance(walked)} из ${fmtDistance(day.totals.walk_distance_m)}</p>`;

  // ----- Карточка «Сейчас» -----
  let card = '';
  if (next) {
    const leg = legTo(day, next);
    const time = fmtTime(next.timing.estimated_arrival_at);
    const kid = opt.kidStopInfo(next.activity_id);
    const line = kidLine(next);
    const chips = [...(line ? [{ cls: 'kid', text: line }] : []), ...nearbyChips(next.location.coordinates)];
    card = `
      <article class="now-card">
        ${kid?.photo ? `<div class="now-photo"><img src="${kid.photo}" alt=""><span class="era">${esc(kid.years)}</span></div>` : ''}
        <div class="now-body">
          <div class="now-head">
            <div class="kicker">${started ? 'Сейчас идём' : 'Первая точка'}</div>
            ${started ? '<button class="more" data-act="skip" aria-label="Пропустить эту точку">⋯</button>' : ''}
          </div>
          <h2>${esc(next.title)}</h2>
          <div class="now-meta">
            ${time ? `<span class="big-time">${time}</span>` : ''}
            <span>${leg ? `${fmtDuration(leg.travel_duration_sec)} пешком · ${fmtDistance(leg.distance_m)}<br>` : ''}на месте ~${fmtDuration(next.duration.duration_sec)}</span>
          </div>
          <div class="chips-s">${chips.map(chipHtml).join('')}</div>
          ${started
            ? `<button class="btn main slim" data-act="visited" ${live ? '' : 'disabled'}>Мы на месте ✓</button>`
            : day.date > new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
            ? '<button class="btn main slim" disabled>Начнём завтра</button>'   // вечером план на завтра — стартовать можно только в его день
            : `<button class="btn main slim" data-act="start" ${live ? '' : 'disabled'}>Начинаем прогулку</button>`}
        </div>
      </article>`;
  } else {
    card = `
      <article class="now-card done">
        <div class="now-body">
          <div class="kicker">Готово</div>
          <h2>Все точки пройдены!</h2>
          <p>${fmtDistance(walked)} пешком за день. Фото «тогда и сейчас» — в альбоме.</p>
        </div>
      </article>`;
  }
  $('today-now').innerHTML = card;

  // ----- Лента: вертикальная линия с узлами -----
  const rows = stops.filter(s => s !== next).map(s => {
    const kid = opt.kidStopInfo(s.activity_id);
    const state = s.progress === 'visited' ? 'done' : s.progress === 'skipped' ? 'skipped' : '';
    const line = kidLine(s) || (s.progress === 'visited' ? 'пройдено' : `на месте ~${fmtDuration(s.duration.duration_sec)}`);
    const time = fmtTime(s.progress === 'visited' ? s.timing.estimated_departure_at : s.timing.estimated_arrival_at);
    return `<li class="${state}">
      <span class="node">${iconFor(s, kid)}</span>
      <span class="t">${time || ''}</span>
      <span class="what"><b>${esc(s.title)}</b><small>${esc(line)}</small></span>
      ${kid?.photo ? `<img class="thumb" src="${kid.photo}" alt="">` : ''}
    </li>`;
  });
  // Финиш: время из последнего перехода
  const lastLeg = day.legs[day.legs.length - 1];
  const lastStop = [...stops].reverse().find(s => s.timing.estimated_departure_at);
  const finishAt = lastLeg && lastLeg.to.kind === 'day_end' && lastStop
    ? fmtTime(new Date(new Date(lastStop.timing.estimated_departure_at).getTime() + lastLeg.travel_duration_sec * 1000).toISOString())
    : '';
  rows.push(`<li class="finish"><span class="node">${ICON.flag}</span><span class="t">${finishAt || ''}</span>
    <span class="what"><b>Финиш</b><small>${esc(day.end_point.label || 'конец прогулки')} · ${fmtDuration(day.totals.elapsed_duration_sec)} на весь день</small></span></li>`);
  $('today-list').innerHTML = rows.join('');

  $('today-source').textContent = live ? '' : 'Нет связи с сервером — показан сохранённый план, отметки не работают.';
  bind(next);
}

function bind(next) {
  const act = name => $('today-now').querySelector(`[data-act="${name}"]`);
  if (act('start')) act('start').onclick = () => run(startDay, 'Идём! Время прибытия пересчитано от сейчас.');
  if (act('visited')) act('visited').onclick = () => run(() => markVisited(next.stop_id), `Отметили: ${next.title}`);
  if (act('skip')) act('skip').onclick = () => askSkip(next);
}

async function run(action, okText) {
  if (busy) return;
  busy = true;
  $('today-now').querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await action();
    toast(okText);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Не получилось: ' + err.message, true);
    render();
  } finally {
    busy = false;
  }
}

// «⋯» → пропустить: сначала показываем, что изменится, сохраняем по подтверждению
async function askSkip(stop) {
  if (busy) return;
  busy = true;
  try {
    pendingSkip = await previewRemove(stop.stop_id);
    const d = pendingSkip.diff;
    const lines = [];
    if (d.walk_delta_sec) lines.push(`Идти на ${fmtDuration(Math.abs(d.walk_delta_sec))} ${d.walk_delta_sec < 0 ? 'меньше' : 'больше'}`);
    if (d.elapsed_delta_sec) lines.push(`Прогулка ${d.elapsed_delta_sec < 0 ? 'короче' : 'длиннее'} на ${fmtDuration(Math.abs(d.elapsed_delta_sec))}`);
    const kid = opt.kidStopInfo(stop.activity_id);
    if (kid && !kid.done) lines.push(`У ${opt.childNameGenitive} пропадёт задание на этой точке`);
    $('skip-title').textContent = `Пропустить «${stop.title}»?`;
    $('skip-diff').innerHTML = lines.map(l => `<li>${esc(l)}</li>`).join('');
    $('skip-confirm').hidden = false;
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy = false;
  }
}

$('skip-cancel').onclick = () => { $('skip-confirm').hidden = true; pendingSkip = null; };
$('skip-ok').onclick = async () => {
  $('skip-confirm').hidden = true;
  const p = pendingSkip;
  pendingSkip = null;
  // Вариант пропуска живёт ~30 секунд; если устарел — пересчитаем и сохраним заново
  await run(async () => {
    try { await applyPreview(p); }
    catch (err) {
      if (err.code !== 'PREVIEW_EXPIRED' && err.code !== 'PREVIEW_STALE') throw err;
      const stop = today().stops.find(s => s.progress === 'planned');
      await applyPreview(await previewRemove(stop.stop_id));
    }
  }, 'Пропустили, маршрут пересчитан');
};

let toastTimer = null;
export function toast(text, error = false) {
  const t = $('today-toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Перерисовать (например, когда загрузились места или ребёнок открыл окно)
export const refreshToday = () => render();

export function initToday(options) {
  opt = { ...opt, ...options };
  $('need-now').onclick = opt.onNeedNow;
  onTripChange(render);
  render();
}
