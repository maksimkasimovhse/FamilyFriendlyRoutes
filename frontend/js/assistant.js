// Контекстный помощник. Изменения рассчитывает backend; пользователь применяет preview.
// Изменение маршрута приходит как preview: показываем разницу, сохраняем по «Применить».

import { today, tripId, tripVersion, csrf, applyPreview, onTripChange } from './api.js';
import { cafeBadges, isDemo } from './places.js';
const DEFAULT_SUGGESTIONS = ['Ребёнок устал', 'Нужен туалет', 'Хотим поесть по пути', 'Пошёл дождь', 'Пропусти следующую точку'];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDuration(sec) {
  const min = Math.max(0, Math.round(Math.abs(sec) / 60));
  return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
}

let busy = false;
let currentTripId = null;
let onShowOnMap = () => {};
let greeted = false;

// ---------- Запрос: настоящий сервис или мок ----------
async function ask(message) {
  const res = await fetch(`/api/v1/trips/${tripId()}/assistant/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf(), 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ expected_version: tripVersion(), date: today().date, message, current_position: null, observed_at: new Date().toISOString() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error?.message || 'Помощник временно недоступен');
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

// ---------- Сообщения ----------
function add(html, who) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.innerHTML = html;
  $('chat').append(el);
  $('chat').scrollTop = $('chat').scrollHeight;
  return el;
}

function suggest(list) {
  $('chat-suggest').innerHTML = (list || []).map(s => `<button type="button">${esc(s)}</button>`).join('');
  $('chat-suggest').querySelectorAll('button').forEach(b => { b.onclick = () => send(b.textContent); });
}

// Карточка «Новый план»: что изменится, кнопки «Применить / Не надо»
function previewCard(preview) {
  const titles = new Map(today().stops.map(s => [s.stop_id, s.title]));
  for (const day of preview.proposed_trip.days) for (const stop of day.stops) titles.set(stop.stop_id, stop.title);
  const d = preview.diff;
  const codes = preview.required_acknowledgement_codes || [];
  const warningText = new Map((preview.warnings || []).map(w => [w.code, w.message]));
  const lines = [
    ...d.removed_stop_ids.map(id => `− ${titles.get(id) || 'точка'}`),
    ...d.added_stop_ids.map(id => `+ ${titles.get(id) || 'новая точка'}`),
    d.walk_delta_sec ? `Идти на ${fmtDuration(d.walk_delta_sec)} ${d.walk_delta_sec < 0 ? 'меньше' : 'больше'}` : '',
    d.elapsed_delta_sec ? `Прогулка ${d.elapsed_delta_sec < 0 ? 'короче' : 'длиннее'} на ${fmtDuration(d.elapsed_delta_sec)}` : '',
  ].filter(Boolean);
  const el = add(`
    <div class="plan-card">
      <div class="kicker">Новый план на сегодня</div>
      <ul>${(lines.length ? lines : ['Маршрут пересчитан от текущего момента']).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      ${codes.map(code => `<label class="muted" style="display:block;margin:8px 0"><input type="checkbox" data-ack="${esc(code)}"> ${esc(warningText.get(code) || code)}</label>`).join('')}
      ${preview.can_apply ? '' : '<p class="err-text">Этот вариант нарушает ограничения и не может быть применён.</p>'}
      <div class="row"><button class="btn alt slim" data-no>Не надо</button><button class="btn main slim" data-yes>Применить</button></div>
    </div>`, 'bot card');
  const yes = el.querySelector('[data-yes]');
  const updateApply = () => { yes.disabled = !preview.can_apply || [...el.querySelectorAll('[data-ack]')].some(input => !input.checked); };
  el.querySelectorAll('[data-ack]').forEach(input => input.addEventListener('change', updateApply));
  updateApply();
  el.querySelector('[data-no]').onclick = () => { el.querySelector('.row').innerHTML = '<span class="muted">Оставили как было</span>'; };
  el.querySelector('[data-yes]').onclick = async () => {
    el.querySelector('.row').innerHTML = '<span class="muted">Применяю…</span>';
    try {
      await applyPreview(preview, [...el.querySelectorAll('[data-ack]:checked')].map(input => input.dataset.ack));
      el.querySelector('.row').innerHTML = '<span class="ok-text">✓ Маршрут обновлён — смотрите «Сегодня» и карту</span>';
    } catch (err) {
      if (err.code === 'PREVIEW_EXPIRED' || err.code === 'PREVIEW_STALE' || err.code === 'VERSION_CONFLICT') {
        el.querySelector('.row').innerHTML = '<span class="muted">Вариант устарел. Повторите поиск или опишите изменение заново.</span>';
        suggest(DEFAULT_SUGGESTIONS);
      } else {
        el.querySelector('.row').innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
      }
    }
  };
}

function placesCard(places, options = []) {
  const el = add(places.map((p, i) => {
    const route = options.find(option => option.place_id === p.place_id);
    const walking = route ? `~${Math.ceil(route.walk_duration_sec / 60)} мин пешком · отклонение ~${Math.ceil(route.detour_duration_sec / 60)} мин` : 'Время подхода не рассчитано';
    const badges = cafeBadges(p).filter(b => b.state !== 'unknown')
      .map(b => `<span class="badge ${b.state}">${b.state === 'yes' ? '✓' : '✕'} ${b.text}</span>`);
    if (isDemo(p)) badges.push('<span class="badge demo">демо</span>');
    return `<div class="place-row"><div><b>${esc(p.name)}</b><small>${esc(walking)}</small>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}</div><button class="btn alt slim" data-i="${i}">На карте</button></div>`;
  }).join(''), 'bot card');
  el.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => onShowOnMap(places[+b.dataset.i]); });
}

async function send(text, { silent = false } = {}) {
  text = text.trim();
  if (!text || !today() || busy) return;
  busy = true;
  const requestedTrip = tripId();
  if (!silent) add(esc(text), 'me');
  suggest([]);
  const typing = add('<span class="typing"><i></i><i></i><i></i></span>', 'bot');
  try {
    const answer = await ask(text);
    typing.remove();
    if (tripId() !== requestedTrip) return;
    add(esc(answer.reply), 'bot');
    if (answer.preview) previewCard(answer.preview);
    if (answer.places?.length) placesCard(answer.places, answer.options);
    suggest(answer.suggestions);
  } catch (err) {
    typing.innerHTML = 'Не получилось: ' + esc(err.message);
    suggest(DEFAULT_SUGGESTIONS);
  } finally {
    busy = false;
  }
}

export function openAssistant() {
  if (greeted || !today()) return;
  greeted = true;
  const next = today().stops.find(s => s.progress === 'planned');
  add(`Привет! Я подстрою прогулку, если что-то пошло не по плану.${next ? ` Сейчас по плану — «${esc(next.title)}».` : ''} Напишите, что случилось, или выберите ниже.`, 'bot');
  suggest(DEFAULT_SUGGESTIONS);
}

export function initAssistant(options) {
  currentTripId = tripId();
  onShowOnMap = options.onShowOnMap;
  $('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    if (busy) return;
    const t = $('chat-text').value;
    $('chat-text').value = '';
    send(t);
  });
  onTripChange(() => {
    if (currentTripId !== tripId()) { currentTripId = tripId(); $('chat').replaceChildren(); greeted = false; }
  });
}
