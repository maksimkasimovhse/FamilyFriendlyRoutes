// ИИ-чат пожеланий — шаг 2 «Новой поездки», после анкеты и выбора дат.
// Семья пишет словами, что хочет («любим историю и театры, без музеев»); backend разбирает текст
// (parser-service/LLM, без него — по ключевым словам), ранжирует места (model-service) и возвращает
// порядок карточек. Дальше экран «Подбор мест» показывает только подобранные места, лучшие первыми.
// POST /api/v1/wishes/recommendations

import { currentProfile } from './onboarding.js';

const $ = id => document.getElementById(id);
const SUGGESTIONS = ['История и архитектура', 'Спокойная прогулка у воды', 'Театры и музыка', 'Что-нибудь для детей', 'Любим историю, но без музеев'];
const GREETING = 'Привет! Расскажите, что хотите увидеть в Нижнем Новгороде: что интересно вам и ребёнку, какое настроение, чего не хочется. Я подберу места, а вы выберете среди них свайпом.';

let messages = [];      // сообщения семьи — разбираются все вместе, поэтому пожелания можно уточнять
let result = null;      // последний ответ backend
let busy = false;
let bound = false;
let hooks = { onBack() {}, onDone() {} };

export const chatText = () => messages.join('. ');
export function resetChat() {
  messages = []; result = null; busy = false;
  const log = $('chat-log');
  if (log) log.replaceChildren();
}

const childInterests = () => [...new Set((currentProfile()?.family?.children || []).flatMap(c => c.interest_ids || []))];

function bubble(kind, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  $('chat-log').append(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return el;
}

function claimsView(claims) {
  const box = document.createElement('div');
  box.className = 'claims';
  for (const c of claims) {
    const s = document.createElement('span');
    s.className = 'claim ' + c.polarity;
    s.textContent = c.label;
    box.append(s);
  }
  return box;
}

function updateNext() {
  const btn = $('chat-next');
  if (!result) { btn.disabled = true; btn.textContent = 'Расскажите о пожеланиях'; return; }
  btn.disabled = false;
  btn.textContent = `Показать места (${result.ranked.length})`;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $('chat-send').disabled = true;
  $('chat-input').value = '';
  bubble('me', text);
  messages.push(text);
  const wait = bubble('bot typing', 'Подбираю места…');
  try {
    const res = await fetch('/api/v1/wishes/recommendations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chatText().slice(-1400), interests: childInterests() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || 'Ошибка ' + res.status);
    result = data;
    wait.className = 'msg bot';
    wait.textContent = data.reply;
    if (data.claims.length) wait.append(claimsView(data.claims));
  } catch (err) {
    messages.pop();
    wait.className = 'msg bot';
    wait.textContent = 'Не получилось связаться с подбором: ' + err.message + '. Можно пропустить шаг и посмотреть все места.';
  } finally {
    busy = false;
    $('chat-send').disabled = false;
    updateNext();
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
}

function bind() {
  bound = true;
  $('wish-chat-form').onsubmit = e => { e.preventDefault(); send($('chat-input').value); };
  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chat-input').value); }
  });
  $('chat-chips').replaceChildren(...SUGGESTIONS.map(t => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = t;
    b.onclick = () => send(t);
    return b;
  }));
  $('trip-chat').querySelector('[data-back]').onclick = () => { $('trip-chat').hidden = true; hooks.onBack(); };
  $('chat-next').onclick = () => { if (result) { $('trip-chat').hidden = true; hooks.onDone(result.ranked.map(r => r.id)); } };
  $('chat-skip').onclick = () => { $('trip-chat').hidden = true; hooks.onDone(null); };
}

// hooks: { onBack(), onDone(ids | null) } — null: пожеланий нет, показать все места
export function openChat(h) {
  hooks = h;
  if (!bound) bind();
  if (!$('chat-log').children.length) bubble('bot', GREETING);
  updateNext();
  $('trip-chat').hidden = false;
}
