// «Помощник» — чат, который перестраивает маршрут на сегодня (ИИ — зона Вильдана).
// Сначала спрашиваем настоящий сервис (контракт: docs/contracts/assistant_draft.md),
// если его ещё нет — отвечает мок на правилах (assistant-mock.js) с пометкой «демо».
// Изменение маршрута приходит как preview: показываем разницу, сохраняем по «Применить».

import { today, tripId, tripVersion, csrf, applyPreview, onTripChange } from './api.js';
import { walkMinutes, distanceM, cafeBadges, isDemo } from './places.js';
import { mockAssistant, DEFAULT_SUGGESTIONS } from './assistant-mock.js';
import { placeEmojiHtml } from './place-display.js';
import { kindOf } from './places.js';
import { urgentKind, runUrgentAction, walkingDirections } from './urgent-actions.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDuration(sec) {
  const min = Math.max(0, Math.round(Math.abs(sec) / 60));
  return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
}

let useMock = false;
let onShowOnMap = () => {};
let lastQuestion = '';
let greeted = false;
let sending = false;

// ---------- Запрос: настоящий сервис или мок ----------
async function ask(message) {
  const kind = urgentKind(message);
  if (kind) return runUrgentAction(kind);
  if (!useMock) {
    try {
      const res = await fetch(`/api/v1/trips/${tripId()}/assistant/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ expected_version: tripVersion(), message, current_position: null, observed_at: new Date().toISOString() }),
      });
      if (res.ok) return await res.json();
      if (res.status !== 404) throw new Error('HTTP ' + res.status);
    } catch (err) {
      if (!(err instanceof TypeError) && !String(err.message).startsWith('HTTP 404')) console.warn('Помощник:', err);
    }
    useMock = true;
    $('chat-mode').hidden = false;
  }
  return mockAssistant(message);
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
  $('chat-suggest').innerHTML = (list || []).map(s => `<button type="button">${urgentKind(s) ? placeEmojiHtml({rest:'bench',toilet:'toilet',food:'restaurant',rain:'landmark',skip:'landmark'}[urgentKind(s)]) : ''}${esc(s)}</button>`).join('');
  $('chat-suggest').querySelectorAll('button').forEach(b => { b.onclick = () => send(b.textContent); });
}

// Карточка «Новый план»: что изменится, кнопки «Применить / Не надо»
function previewCard(preview) {
  const titles = new Map(today().stops.map(s => [s.stop_id, s.title]));
  const d = preview.diff;
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
      ${(preview.warnings || []).map(w=>`<p class="small">${esc(w.message || w.code)}</p>`).join('')}
      ${(preview.required_acknowledgement_codes || []).map(code=>`<label class="small"><input type="checkbox" data-ack="${esc(code)}"> Понятно: ${esc(code)}</label>`).join('')}
      <div class="row"><button class="btn alt slim" data-no>Не надо</button><button class="btn main slim" data-yes>Применить</button></div>
    </div>`, 'bot card');
  el.querySelector('[data-no]').onclick = () => { el.querySelector('.row').innerHTML = '<span class="muted">Оставили как было</span>'; };
  const applyButton = el.querySelector('[data-yes]');
  const acknowledgements = [...el.querySelectorAll('[data-ack]')];
  const updateApply = () => { applyButton.disabled = !preview.can_apply || acknowledgements.some(input=>!input.checked); };
  acknowledgements.forEach(input=>input.onchange=updateApply); updateApply();
  applyButton.onclick = async () => {
    el.querySelector('.row').innerHTML = '<span class="muted">Применяю…</span>';
    try {
      await applyPreview(preview,acknowledgements.filter(input=>input.checked).map(input=>input.dataset.ack));
      el.querySelector('.row').innerHTML = '<span class="ok-text">✓ Маршрут обновлён — смотрите «Сегодня» и карту</span>';
    } catch (err) {
      if (err.code === 'PREVIEW_EXPIRED' || err.code === 'PREVIEW_STALE' || err.code === 'VERSION_CONFLICT') {
        el.querySelector('.row').innerHTML = '<span class="muted">Вариант устарел — пересчитываю…</span>';
        send(lastQuestion, { silent: true });
      } else {
        el.querySelector('.row').innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
      }
    }
  };
}

function placesCard(places) {
  const from = today().execution ? today().execution.current_point.coordinates
    : (today().stops.find(s => s.progress === 'planned') || { location: today().start_point }).location.coordinates;
  const el = add(places.map((p, i) => {
    const badges = cafeBadges(p).filter(b => b.state !== 'unknown')
      .map(b => `<span class="badge ${b.state}">${b.state === 'yes' ? '✓' : '✕'} ${b.text}</span>`);
    if (isDemo(p)) badges.push('<span class="badge demo">демо</span>');
    return `<div class="place-row"><div><b>${placeEmojiHtml(kindOf(p))} ${esc(p.name)}</b><small>~${walkMinutes(p.urgent_distance_m ?? distanceM(from, p.location.coordinates))} мин пешком${p.urgent_origin ? ' от геопозиции · оценка' : ''}</small>
      ${p.urgent_note ? `<small>${esc(p.urgent_note)}</small>` : ''}
      ${p.urgent_origin ? `<a class="btn link slim" target="_blank" rel="noopener noreferrer" href="${esc(walkingDirections(p.urgent_origin,p.location.coordinates))}">Пешком в Яндекс Картах ↗</a>` : ''}
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}</div><button class="btn alt slim" data-i="${i}">На карте</button></div>`;
  }).join(''), 'bot card');
  el.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => onShowOnMap(places[+b.dataset.i]); });
}

async function send(text, { silent = false } = {}) {
  text = text.trim();
  if (!text || !today() || sending) return;
  sending = true;
  lastQuestion = text;
  if (!silent) add(esc(text), 'me');
  suggest([]);
  const typing = add('<span class="typing"><i></i><i></i><i></i></span>', 'bot');
  try {
    const answer = await ask(text);
    typing.remove();
    add(esc(answer.reply), 'bot');
    if (answer.preview) previewCard(answer.preview);
    if (answer.places?.length) placesCard(answer.places);
    suggest(answer.suggestions);
  } catch (err) {
    typing.innerHTML = 'Не получилось: ' + esc(err.message);
    suggest(DEFAULT_SUGGESTIONS);
  } finally {
    sending = false;
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
  onShowOnMap = options.onShowOnMap;
  $('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const t = $('chat-text').value;
    $('chat-text').value = '';
    send(t);
  });
  onTripChange(() => { if (!$('chat').children.length) greeted = false; });
}
