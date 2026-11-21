import { placeEmojiHtml } from './place-display.js';
// Экран «Сегодня» — главный экран родителя (макет «Сегодня и Карта: что сейчас и что рядом»).
// Карточка «Сейчас» + лента со временем. Под каждой точкой — одна «семейная» строка:
// что там у ребёнка (задание / штамп) и что рядом (туалет, кафе для детей).

import { onTripChange, today, getTrip, getSource, startDay, previewStartDay, markVisited, previewRemove, applyPreview, ApiError } from './api.js';
import { nearest, walkMinutes, isFamilyCafe } from './places.js';

import { currentPosition } from './geolocation.js';
import { napDayHtml } from './nap-display.js';

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
const fmtTime = value => value ? new Date(value).toLocaleTimeString('ru-RU', {timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}) : '';
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

// День, который смотрит родитель: по умолчанию сегодняшний, иначе первый. Переключается вкладками дней.
let selDate = null;
const mskToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const tripDays = () => (getTrip()?.days || []);
function currentDay() {
  const days = tripDays();
  if (!days.length) return null;
  return days.find(d => d.date === selDate) || days.find(d => d.date === mskToday()) || days[0];
}
const dayWord = date => {
  const t = mskToday();
  const diff = Math.round((new Date(date + 'T12:00:00Z') - new Date(t + 'T12:00:00Z')) / 86400000);
  return diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : cap(weekday(date));
};
const pluralPts = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'точка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'точки' : 'точек'}`;

function render() {
  const day = currentDay();
  if (!day) return;
  const realToday = mskToday();
  const isToday = day.date === realToday;
  const activeDay = today();                       // день, с которым умеет работать бекенд (отметки, старт)
  const canAct = isToday && activeDay && activeDay.date === day.date;
  const live = getSource() === 'backend';
  const started = !!day.execution;
  const stops = day.stops.filter(s => s.progress !== 'removed');
  const next = stops.find(s => s.progress === 'planned');
  const doneCount = stops.filter(s => s.progress === 'visited').length;
  const walked = day.execution?.consumed_walk_distance_m || 0;

  // ----- Шапка: дата, «Сегодня/Завтра/День недели» -----
  $('today-sub').textContent = cap(new Date(day.date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
  $('today-h1').textContent = dayWord(day.date);

  // ----- Дни поездки (если их больше одного) -----
  const days = tripDays();
  $('today-days').hidden = days.length < 2;
  $('today-days').innerHTML = days.length < 2 ? '' : days.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    return `<button type="button" role="tab" class="td-day${d.date === realToday ? ' now' : ''}" data-date="${d.date}" aria-selected="${d.date === day.date}">
      <small>${esc(dt.toLocaleDateString('ru-RU', { weekday: 'short' }).toUpperCase())}</small><b>${dt.getDate()}</b></button>`;
  }).join('');
  $('today-days').querySelectorAll('[data-date]').forEach(b => { b.onclick = () => { selDate = b.dataset.date; render(); }; });

  // ----- Сводка дня: одна строка и тонкий прогресс -----
  const total = day.totals.walk_distance_m || 0;
  $('today-stats').innerHTML = `
    <div class="td-sum-row">
      <b>${started ? `${doneCount} из ${stops.length} точек` : pluralPts(stops.length)}</b>
      <span>${fmtDistance(started ? walked : total)}${started ? ' из ' + fmtDistance(total) : ''}</span>
      <span>${day.nap ? fmtDuration(day.totals.outing_duration_sec || 0)+' прогулка + '+fmtDuration(day.totals.nap_duration_sec || 0)+' сон' : fmtDuration(day.totals.elapsed_duration_sec)}</span>
    </div>
    ${started ? `<div class="td-prog" aria-hidden="true"><i style="width:${stops.length ? doneCount / stops.length * 100 : 0}%"></i></div>` : ''}`;

  // ----- Карточка «Сейчас» — только для сегодняшнего дня -----
  let card = '';
  if (isToday && next) {
    const leg = legTo(day, next);
    const sleepTime = next.activity_kind==='nap' ? fmtTime(next.timing.fixed_event_interval?.start_at)+'–'+fmtTime(next.timing.fixed_event_interval?.end_at) : '';
    const kid = opt.kidStopInfo(next.activity_id);
    const line = kidLine(next);
    const chips = [...(line ? [{ cls: 'kid', text: line }] : []), ...nearbyChips(next.location.coordinates)];
    const walk = leg && leg.distance_m >= 30;   // старт совпадает с первой точкой — «0 м пешком» не показываем
    const meta = [sleepTime, walk && `${fmtDuration(leg.travel_duration_sec)} пешком`, walk && fmtDistance(leg.distance_m), `на месте ~${fmtDuration(next.duration.duration_sec)}`].filter(Boolean).join(' · ');
    card = `
      <article class="td-now">
        <div class="td-now-top">
          ${kid?.photo ? `<img class="td-now-img" src="${kid.photo}" alt="">` : ''}
          <div class="td-now-main">
            <span class="td-kicker">${started ? 'Сейчас идём' : 'Первая точка'}</span>
            <h2>${placeEmojiHtml(next.category)} ${esc(next.title)}</h2>
            <p>${esc(meta)}</p>
          </div>
          ${started && canAct && !next.mandatory ? '<button class="td-more" data-act="skip" aria-label="Пропустить эту точку">⋯</button>' : ''}
        </div>
        ${chips.length ? `<div class="td-chips">${chips.map(chipHtml).join('')}</div>` : ''}
        ${started
          ? `<button class="btn main slim" data-act="visited" ${live && canAct ? '' : 'disabled'}>${next.activity_kind==='nap'?'Сон закончился':'Мы на месте ✓'}</button>`
          : canAct
          ? `<button class="btn main slim" data-act="start" ${live ? '' : 'disabled'}>Начинаем прогулку</button>`
          : ''}
      </article>`;
  } else if (isToday && stops.length) {
    card = `
      <article class="td-now done">
        <span class="td-kicker">Готово</span>
        <h2>Все точки пройдены!</h2>
        <p>${fmtDistance(walked)} пешком за день. Фото «тогда и сейчас» — в альбоме.</p>
      </article>`;
  }
  $('today-now').innerHTML = napDayHtml(day)+card;

  // ----- Лента дня -----
  const showNextInLine = !(isToday && next);
  const walkText = leg => leg && leg.distance_m >= 30 ? `${fmtDuration(leg.travel_duration_sec)} пешком · ${fmtDistance(leg.distance_m)}` : '';
  const rows = stops.filter(s => showNextInLine || s !== next).map(s => {
    const kid = opt.kidStopInfo(s.activity_id);
    const state = s.progress === 'visited' ? 'done' : s.progress === 'skipped' ? 'skipped' : '';
    // Время старта прогулки заранее неизвестно (человек выходит когда удобно) — показываем, сколько идти от предыдущей точки
    const line = s.progress === 'visited' ? 'пройдено'
      : [s.activity_kind==='nap' ? fmtTime(s.timing.fixed_event_interval?.start_at)+'–'+fmtTime(s.timing.fixed_event_interval?.end_at) : '', walkText(legTo(day, s)), kidLine(s) || `на месте ~${fmtDuration(s.duration.duration_sec)}`].filter(Boolean).join(' · ');
    return `<li class="${state}">
      <span class="td-node">${iconFor(s, kid)}</span>
      <span class="td-what"><b>${placeEmojiHtml(s.category)} ${esc(s.title)}</b><small>${esc(line)}</small></span>
      ${kid?.photo ? `<img class="td-thumb" src="${kid.photo}" alt="">` : ''}
    </li>`;
  });
  const lastLeg = day.legs[day.legs.length - 1];
  rows.push(`<li class="finish"><span class="td-node">${ICON.flag}</span>
    <span class="td-what"><b>Финиш</b><small>${esc([lastLeg && lastLeg.to?.kind === 'day_end' ? walkText(lastLeg) : '', day.end_point.label || 'конец прогулки'].filter(Boolean).join(' · '))}</small></span></li>`);
  $('today-list').innerHTML = rows.join('');

  $('today-source').textContent = live ? '' : 'Нет связи с сервером — показан сохранённый план, отметки не работают.';
  bind(next);
}

function bind(next) {
  const act = name => $('today-now').querySelector(`[data-act="${name}"]`);
  if (act('start')) act('start').onclick = () => today().nap ? startNapDay() : run(startDay, 'Идём! Время прибытия пересчитано от сейчас.');
  if (act('visited')) act('visited').onclick = () => run(() => markVisited(next.stop_id), `Отметили: ${next.title}`);
  if (act('skip')) act('skip').onclick = () => askSkip(next);
}

async function startNapDay(){
 if(busy)return;busy=true;
 try{
 const coordinates=await currentPosition().catch(()=>null),point=coordinates?{coordinates,label:'Текущая геопозиция'}:today().start_point;
 const preview=await previewStartDay(point),plan=preview.proposed_trip.days.find(d=>d.date===today().date);
 const removed=preview.diff.removed_stop_ids.map(id=>today().stops.find(s=>s.stop_id===id)?.title).filter(Boolean);
 const dialog=$('nap-start-dialog');$('nap-start-content').innerHTML='<p>Старт: '+esc(point.label||'выбранная точка')+(coordinates?'':' (геопозиция недоступна, используем указанную точку старта)')+'</p>'+napDayHtml(plan)+(removed.length?'<p>Чтобы вернуться вовремя, уберём: '+removed.map(esc).join(', ')+'.</p>':'<p>Места распределены до и после сна по фактическому времени старта.</p>')+(!preview.can_apply?'<p class="form-error">Этот план не помещается. Измените места или настройки сна.</p>':'');
 $('nap-start-apply').disabled=!preview.can_apply;$('nap-start-cancel').onclick=()=>dialog.close();
 $('nap-start-apply').onclick=async()=>{$('nap-start-apply').disabled=true;try{await applyPreview(preview);dialog.close();toast('День начат. Возвращение к дневному сну учтено.');}catch(error){dialog.close();toast(error.message,true)}};dialog.showModal();
 }catch(error){toast(error.message,true)}finally{busy=false}
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
  onTripChange(render);
  render();
}
