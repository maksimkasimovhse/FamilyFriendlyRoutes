// Детский режим «Тропа Маши».
// Тропа строится из мест, которые туристы выбрали на экране «Подбор мест» (setKidPlaces); пока выбора нет,
// показывается демо-тропа из data/kid-route.json. На каждой остановке ровно одно задание: игра с картинкой
// объекта (пазл, пиксель-пазл или раскраска по номерам; вид задан полем game у места в data/cards.json —
// поровну на все места) или вопросы (quiz, только у памятника Чкалову, текст в data/kid-quiz.json).
// Решил задание — получил штамп. Озвучки нет. Прогресс — только в этом браузере (localStorage).
//
// Плюс одно «Окно в прошлое» (PAST_ID, первая остановка): старое фото PastVu → встать на место фотографа →
// камера с полупрозрачным старым кадром → «тогда / сейчас», новый наряд оленёнка, сторис.
//
// ?reset=1 — начать тропу заново. ?demo=0 — окно открывается только на месте (по GPS);
// по умолчанию демо: «считаем, что вы на месте».

import { startGame, GAME_LABELS, GAME_HINTS } from './games.js';
import { loadCards, cardById, orderByNearest } from './catalog.js';
import { watchPlace, enableCompass, openCamera, closeCamera } from './camera.js';

const $ = id => document.getElementById(id);
const ICONS = {
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let route = null;
let quiz = {};            // вопросы по id места (data/kid-quiz.json)
let child = { name: 'Маша', ageGroup: '6-8' };
let state = { done: [], outfit: 'base', demo: true, picks: [] };   // picks — id мест, выбранных для маршрута
let current = null;        // открытая остановка
let game = null;           // запущенная игра (promise с { destroy })
let onExit = () => {};
let stopWatch = null;       // слежение за GPS на экране окна
let lastPhoto = null;       // { stop, url } — для «Сохранить сторис»

// Единственное окно в прошлое на тропе — пока одно, на нём доводим вид и сценарий
const PAST_ID = 'win_minin';
const isWindow = s => s.id === PAST_ID;
const pastStop = () => route.demoStops.find(s => s.id === PAST_ID);

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
  const stops = cards.length ? cards.map(placeStop) : [...route.demoStops];
  const w = pastStop();
  // окно — первой остановкой; то же место без окна из тропы убираем
  route.stops = w ? [w, ...stops.filter(s => s.id !== w.id && s.place !== w.place)] : stops;
}
const kindLabel = s => isWindow(s) ? `Окно в прошлое · ${s.years}` : GAME_LABELS[gameOf(s).type];
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
  if (isWindow(n)) return `Идём к остановке «${n.title}». Там откроем окно в прошлое — посмотрим, как здесь было в ${n.years.split('–')[0]} году!`;
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
    const icon = isDone(p.s) ? ICONS.check : isWindow(p.s) ? ICONS.camera : ICONS.star;
    const sub = kindLabel(p.s);
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
  ['game-page', 'stamp-page', 'window-page', 'result-page'].forEach(p => { $(p).hidden = p !== id; });
}
function backToTrail() {
  stopGame();
  if (stopWatch) { stopWatch(); stopWatch = null; }
  closeCamera();
  showPage(null);
  renderTrail();
}

function openStop(s) {
  current = s;
  if (isWindow(s)) openWindow(s); else openGame(s);
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
  $('stamp-icon').innerHTML = isWindow(s) ? ICONS.camera : ICONS.star;
  $('stamp-text').textContent = `Штамп «${s.title}» твой!`;
  $('stamp-row').innerHTML = all.map(x => `<span class="${isDone(x) ? 'on' : ''}"></span>`).join('');
  $('stamp-next').textContent = nextStop() ? 'Дальше по тропе' : 'Тропа пройдена!';
  showPage('stamp-page');
}

// ---------- Окно в прошлое, шаг 1: старое фото и место фотографа ----------
function openWindow(s) {
  stopGame();
  $('win-title').textContent = s.title;
  $('win-years').textContent = s.years;
  $('win-old').src = s.photo.url;
  $('win-old').alt = `Старое фото: ${s.title}, ${s.years}`;
  $('win-attrib').textContent = s.photo.attribution;
  $('win-say').textContent = 'Найдите место, где стоял фотограф, и сфотографируйтесь вместе — окно откроется!';
  showPage('window-page');
  const btn = $('win-camera');
  stopWatch = watchPlace(s, state.demo, st => {
    $('win-place').textContent = st.text;
    $('win-place').classList.toggle('ready', st.ready);
    btn.disabled = !st.ready;
  });
}

// Шаг 2: камера с полупрозрачным старым кадром
async function startCamera() {
  if (stopWatch) { stopWatch(); stopWatch = null; }
  await enableCompass();   // iPhone: разрешение — только по нажатию
  openCamera(current, state.demo, (url, aspect) => showResult(current, url, aspect));
}

// Шаг 3: окно открыто — тогда / сейчас
function showResult(s, url, aspect) {
  lastPhoto = { stop: s, url };
  $('res-title').textContent = s.title;
  $('res-years').textContent = s.years;
  const tn = $('res-tn');
  tn.style.aspectRatio = String(aspect);
  tn.style.width = `min(100%, calc(52dvh * ${aspect}))`;
  tn.style.setProperty('--cut', '50%');
  $('res-range').value = 50;
  $('res-now').src = url;
  $('res-old').src = s.photo.url;
  $('res-old').alt = `Тогда: ${s.title}, ${s.years}`;
  $('res-attrib').innerHTML = '';
  const a = document.createElement('a');
  a.href = s.photo.sourceUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s.photo.attribution;
  $('res-attrib').append(a);
  $('res-kid').textContent = s.kidText;
  $('res-adult').textContent = s.adultText;
  $('res-source').textContent = 'Источник: ' + s.textSource;
  showPage('result-page');

  const firstTime = !isDone(s);
  finishStop(s);
  if (firstTime && s.outfit) showReward(s.outfit);
}

function showReward(outfitId) {
  const o = route.outfits[outfitId];
  $('reward-img').src = o.img;
  $('reward-text').textContent = `Оленёнок теперь — ${o.title.toLowerCase()}!`;
  $('reward').hidden = false;
  $('reward-ok').onclick = () => {
    $('reward').hidden = true;
    state.outfit = outfitId;
    save();
    $('fawn-img').src = o.img;
    $('fawn-buddy').classList.remove('bounce');
    void $('fawn-buddy').offsetWidth;   // перезапуск анимации
    $('fawn-buddy').classList.add('bounce');
  };
}

// «Сохранить сторис»: картинка 1080×1920 — сверху «тогда», снизу «сейчас»
async function saveStory() {
  if (!lastPhoto) return;
  const { stop: s, url } = lastPhoto;
  const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
  const [oldImg, nowImg, fawn] = await Promise.all([loadImg(s.photo.url), loadImg(url), loadImg(outfitImg(s.outfit || state.outfit))]);
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1920;
  const g = c.getContext('2d');
  g.fillStyle = '#13223A'; g.fillRect(0, 0, 1080, 1920);
  const cover = (img, x, y, w, h) => {
    const sc = Math.max(w / img.width, h / img.height), sw = w / sc, sh = h / sc;
    g.save(); g.beginPath(); g.roundRect(x, y, w, h, 36); g.clip();
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
    g.restore();
  };
  cover(oldImg, 60, 250, 960, 760);
  cover(nowImg, 60, 1050, 960, 760);
  g.fillStyle = '#F1E7D6';
  g.font = '800 66px Nunito, sans-serif';
  g.fillText('Мы открыли окно в прошлое', 60, 130);
  g.font = '700 40px Nunito, sans-serif';
  g.fillText(`${s.title} · ${s.years}`, 60, 196);
  const label = (t, y, color) => { g.fillStyle = color; g.beginPath(); g.roundRect(90, y, 210, 64, 32); g.fill(); g.fillStyle = '#fff'; g.font = '800 34px Nunito, sans-serif'; g.fillText(t, 118, y + 44); };
  label('ТОГДА', 280, '#8A5A2B');
  label('СЕЙЧАС', 1080, '#2463D6');
  g.drawImage(fawn, 820, 1600, 220, 242);
  g.fillStyle = '#8D97AB'; g.font = '400 26px Nunito, sans-serif';
  g.fillText(s.photo.attribution, 60, 1870);

  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.9));
  const file = new File([blob], `okno-${s.id}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Окно в прошлое' }); return; } catch { /* отменили — скачаем */ }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
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
  $('win-camera').onclick = startCamera;
  $('res-range').oninput = e => $('res-tn').style.setProperty('--cut', e.target.value + '%');
  $('res-next').onclick = () => showStamp(current);
  $('res-save').onclick = () => saveStory().catch(err => alert('Не получилось сохранить: ' + err.message));
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

// Прогресс ребёнка для профиля: штампы за пройденные задания и текущий наряд оленёнка
export function kidProgress() {
  let saved = state;
  try { saved = { ...state, ...JSON.parse(localStorage.getItem('kid-state') || '{}') }; } catch { /* приватный режим */ }
  const outfit = route && route.outfits[saved.outfit] ? route.outfits[saved.outfit].img : 'media/fawn/fawn-base.svg';
  return { stamps: (saved.done || []).length, outfitImg: outfit };
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
  applyPicks();
  if (!$('kid-mode').hidden) renderTrail();
}

// Что у ребёнка на этой остановке — для строки в ленте «Сегодня»
export function kidStopInfo(activityId) {
  const s = route && route.demoStops.find(x => x.id === activityId);
  if (!s) return null;
  if (isWindow(s)) return { type: 'window', label: 'Окно в прошлое', years: s.years, done: isDone(s), photo: s.photo.url };
  return { type: 'task', label: GAME_LABELS[gameOf(s).type], years: null, done: isDone(s), photo: null };
}
