// Детский режим «Тропа Маши».
// Тропа строится из мест, которые туристы выбрали на экране «Подбор мест» (setKidPlaces); пока выбора нет,
// показывается демо-тропа из data/kid-route.json. На каждой остановке ровно одно задание: игра с картинкой
// объекта (пазл, пиксель-пазл или раскраска по номерам; вид задан полем game у места в data/cards.json —
// поровну на все места) или вопросы (quiz, только у памятника Чкалову, текст в data/kid-quiz.json).
// Решил задание — получил штамп. Озвучки нет. Прогресс — только в этом браузере (localStorage).
//
// ?reset=1 — начать тропу заново.

import { startGame, GAME_LABELS, GAME_HINTS } from './games.js';
import { loadCards, cardById, orderByNearest } from './catalog.js';

const $ = id => document.getElementById(id);
const ICONS = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let route = null;
let quiz = {};            // вопросы по id места (data/kid-quiz.json)
let child = { name: 'Маша', ageGroup: '6-8' };
let state = { done: [], outfit: 'base', demo: false, picks: [] };   // picks — id мест, выбранных для маршрута
let current = null;        // открытая остановка
let game = null;           // запущенная игра (promise с { destroy })
let onExit = () => {};

// ---------- Прогресс ----------
function load() { try { Object.assign(state, JSON.parse(localStorage.getItem('kid-state') || '{}')); } catch { /* приватный режим */ } }
function save() { try { localStorage.setItem('kid-state', JSON.stringify(state)); } catch { /* приватный режим */ } }

// Вид и картинки задания остановки: берутся у места из каталога (data/cards.json)
function gameOf(s) {
  const card = cardById(s.place);
  return { type: card.game, dir: 'media/kid/' + card.id, image: card.image.full, questions: quiz[card.id]?.questions };
}
const placeStop = card => ({ id: 'place_' + card.id, type: 'task', title: card.title, point: card.location, place: card.id });
function applyPicks() {
  const cards = state.picks.map(cardById).filter(Boolean);
  route.stops = cards.length ? cards.map(placeStop) : [...route.demoStops];
}
const isDone = s => state.done.includes(s.id);
const nextStop = () => route.stops.find(s => !isDone(s));
const outfitImg = id => route.outfits[id].img;
const ageGroup = years => years <= 5 ? '3-5' : years <= 8 ? '6-8' : '9-11';
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

// ---------- Оленёнок-персонаж ----------
let bubbleTimer = null;
function fawnSays(text) {
  const b = $('fawn-bubble');
  b.textContent = text;
  b.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.hidden = true; }, 6000);
}
function fawnLine() {
  const n = nextStop();
  if (!n) return `Мы прошли всю тропу! ${child.name}, ты настоящий путешественник!`;
  return `Идём к остановке «${n.title}». Нас ждёт задание: ${GAME_LABELS[gameOf(n).type].toLowerCase()}!`;
}

// ---------- Тропа дня ----------
const ROW = 118, TOP = 86, BOTTOM = 70;

function renderTrail() {
  const total = route.stops.length;
  const opened = route.stops.filter(isDone).length;
  $('kid-title').textContent = 'Тропа ' + child.nameGenitive;
  $('kid-progress').textContent = `${opened} из ${total} ${plural(total, 'задания', 'заданий', 'заданий')}`;
  $('fawn-img').src = outfitImg(state.outfit);

  const map = $('trail-map');
  const w = map.clientWidth || 360;
  const n = route.stops.length;
  const h = TOP + (n - 1) * ROW + BOTTOM;
  map.style.height = h + 'px';
  // Первая остановка внизу — тропа идёт вверх, к реке
  const pts = route.stops.map((s, i) => ({ s, x: (i % 2 === 0 ? 0.22 : 0.78) * w, y: h - BOTTOM - i * ROW }));

  let path = `M${pts[0].x} ${pts[0].y + 60}`;
  pts.forEach((p, i) => {
    const prev = i === 0 ? { x: p.x, y: p.y + 60 } : pts[i - 1];
    path += ` C${prev.x} ${prev.y - ROW * 0.55}, ${p.x} ${p.y + ROW * 0.55}, ${p.x} ${p.y}`;
  });
  const trees = pts.map((p, i) => `<circle cx="${i % 2 ? 0.1 * w : 0.9 * w}" cy="${p.y + 30}" r="${11 + (i % 3) * 3}" fill="#7DBE6E"/>`).join('');
  const doneUpTo = route.stops.findIndex(s => !isDone(s));
  map.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="M0 0H${w}V44C${w * 0.75} 64 ${w * 0.5} 30 ${w * 0.25} 48S0 40 0 52Z" fill="#BFDDF6"/>
      ${trees}
      <path d="${path}" fill="none" stroke="#F0A673" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 12"/>
    </svg>`;

  pts.forEach((p, i) => {
    const b = document.createElement('button');
    const status = isDone(p.s) ? 'done' : i === doneUpTo ? 'now' : '';
    b.className = `trail-stop ${status} ${p.x > w / 2 ? 'left' : ''}`;
    // кружок (56px) центрируем на точке; справа от центра подпись уходит влево
    if (p.x > w / 2) b.style.right = (w - p.x - 28) + 'px'; else b.style.left = (p.x - 28) + 'px';
    b.style.top = p.y + 'px';
    const icon = isDone(p.s) ? ICONS.check : ICONS.star;
    const sub = GAME_LABELS[gameOf(p.s).type];
    b.innerHTML = `<span class="pt">${icon}</span><span class="lbl"></span>`;
    b.querySelector('.lbl').textContent = p.s.title;
    b.querySelector('.lbl').insertAdjacentHTML('beforeend', `<small>${sub}</small>`);
    b.setAttribute('aria-label', `${p.s.title}, ${sub}${isDone(p.s) ? ', пройдено' : ''}`);
    b.onclick = () => openStop(p.s);
    map.append(b);
  });

  const next = nextStop();
  $('kid-go').textContent = next ? 'Начать: ' + next.title : 'Тропа пройдена!';
  $('kid-go').disabled = !next;
  // Прокрутить к текущей точке
  const target = pts[doneUpTo === -1 ? n - 1 : doneUpTo];
  $('trail-scroll').scrollTop = Math.max(0, target.y - $('trail-scroll').clientHeight / 2);
}

// ---------- Переходы между страницами режима ----------
function showPage(id) {
  ['game-page', 'stamp-page'].forEach(p => { $(p).hidden = p !== id; });
}
function backToTrail() {
  stopGame();
  showPage(null);
  renderTrail();
}

function openStop(s) {
  current = s;
  openGame(s);
}

// ---------- Задание: игра с картинкой объекта ----------
function stopGame() {
  const g = game;
  game = null;
  if (g) g.then(x => x.destroy());
}

function openGame(s) {
  stopGame();
  const game_ = gameOf(s);
  const type = game_.type;
  $('game-title').textContent = s.title;
  $('game-kind').textContent = GAME_LABELS[type];
  $('game-fawn').src = outfitImg(state.outfit);
  $('game-hint').textContent = GAME_HINTS[type];
  $('game-progress').textContent = '';
  const done = $('game-done');
  done.disabled = true;
  done.classList.remove('win');
  done.textContent = 'Реши задание';
  done.onclick = null;
  showPage('game-page');

  game = Promise.resolve(startGame($('game-area'), game_, child.ageGroup, {
    onProgress: (n, total) => {
      $('game-progress').textContent = type === 'paint' ? `Закрашено ${n} из ${total}`
        : type === 'quiz' ? `Верных ответов ${n} из ${total}` : `Собрано ${n} из ${total}`;
    },
    onSolved: () => {
      $('game-hint').textContent = s.intro || 'Получилось! Ты молодец!';
      done.disabled = false;
      done.classList.add('win');
      done.textContent = 'Забрать штамп';
      done.onclick = () => afterGame(s);
    },
  }));
}

// Задание решено — штамп. Одно задание на остановку: ничего больше после него не ждёт.
function afterGame(s) {
  stopGame();
  finishStop(s);
  showStamp(s);
}

function finishStop(s) {
  if (!isDone(s)) state.done.push(s.id);
  save();
}

function showStamp(s) {
  const all = route.stops;
  $('stamp-icon').innerHTML = ICONS.star;
  $('stamp-text').textContent = `Штамп «${s.title}» твой!`;
  $('stamp-row').innerHTML = all.map(x => `<span class="${isDone(x) ? 'on' : ''}"></span>`).join('');
  $('stamp-next').textContent = nextStop() ? 'Дальше по тропе' : 'Тропа пройдена!';
  showPage('stamp-page');
}

// ---------- Вход и выход из режима ----------
export function openKid() {
  $('kid-mode').hidden = false;
  showPage(null);
  renderTrail();
  setTimeout(() => fawnSays(fawnLine()), 400);
}
function closeKid() {
  backToTrail();
  $('kid-mode').hidden = true;
  onExit();
}

// options: { childName, childNameGenitive, ageYears, onExit }
export async function initKid(options) {
  let loaded;
  [route, loaded] = await Promise.all([fetch('data/kid-route.json').then(r => r.json()), fetch('data/kid-quiz.json').then(r => r.json()), loadCards()]);
  quiz = loaded;
  route.demoStops = [...route.stops];
  child = { name: options.childName, nameGenitive: options.childNameGenitive, ageGroup: ageGroup(options.ageYears) };
  onExit = options.onExit;
  load();
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) state.demo = q.get('demo') !== '0';
  if (q.has('reset')) { state.done = []; state.outfit = 'base'; state.picks = []; }
  if (!Array.isArray(state.picks)) state.picks = [];
  applyPicks();
  save();

  $('kid-go').onclick = () => { const n = nextStop(); if (n) openStop(n); };
  $('kid-exit').onclick = closeKid;
  $('fawn-buddy').onclick = () => fawnSays(fawnLine());
  document.querySelectorAll('.kid-mode [data-back]').forEach(b => b.addEventListener('click', backToTrail));
  $('stamp-next').onclick = backToTrail;
  $('stamp-return').onclick = closeKid;
  addEventListener('resize', () => { if (!$('kid-mode').hidden) renderTrail(); });
}

// Тропа из мест, выбранных туристами на экране «Подбор мест». places — карточки из catalog.js;
// порядок тот же, что у маршрута на карте (ближайший сосед от точки старта).
export function setKidPlaces(places, from) {
  if (!route) return;
  state.picks = orderByNearest(places, from).map(p => String(p.id));
  applyPicks();
  save();
  if (!$('kid-mode').hidden) renderTrail();
}
// Выбор сброшен: возвращаемся к демо-тропе
export function clearKidPlaces() {
  if (!route) return;
  state.picks = [];
  applyPicks();
  save();
  if (!$('kid-mode').hidden) renderTrail();
}

// Сводка для экрана родителя «Сегодня»: сколько точек и окон осталось на тропе ребёнка
export function kidSummary() {
  if (!route) return null;
  const left = route.stops.filter(s => !isDone(s));
  return { left: left.length, windowsLeft: left.filter(s => s.type === 'window').length };
}

// Тропа ребёнка идёт в том же порядке, что маршрут родителя с бекенда.
// activityIds — activity_id остановок дня (совпадают с id в kid-route.json).
export function syncKidOrder(activityIds) {
  if (!route) return;
  const pos = id => { const i = activityIds.indexOf(id); return i === -1 ? 999 : i; };
  route.demoStops.sort((a, b) => pos(a.id) - pos(b.id));
  if (state.picks.length) return;          // тропа из выбранных мест идёт в порядке выбора, а не демо-маршрута
  route.stops = [...route.demoStops];
  if (!$('kid-mode').hidden) renderTrail();
}

// Что у ребёнка на этой остановке — для строки в ленте «Сегодня»
export function kidStopInfo(activityId) {
  const s = route && route.demoStops.find(x => x.id === activityId);
  if (!s) return null;
  return { type: 'task', label: GAME_LABELS[gameOf(s).type], years: null, done: isDone(s), photo: null };
}
