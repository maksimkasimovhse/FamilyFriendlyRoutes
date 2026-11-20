// Детский режим «Тропа Маши».
// Тот же маршрут, что у родителя, только как тропа приключений.
// Остановки: «task» — задание по возрасту (оленёнок читает вслух, ответ — одна кнопка),
// «window» — окно в прошлое: старое фото → встать на место фотографа → камера → тогда / сейчас.
// Прогресс — только в этом браузере (localStorage), фото — только в памяти.
//
// Демо для защиты: index.html?demo=1 — «считаем, что вы на месте»; ?demo=0 — выключить;
// ?reset=1 — начать тропу заново.

import { watchPlace, enableCompass, openCamera, closeCamera } from './camera.js';

const $ = id => document.getElementById(id);
const ICONS = {
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let route = null;
let child = { name: 'Маша', ageGroup: '6-8' };
let state = { done: [], outfit: 'base', demo: false };
let current = null;        // открытая остановка
let stopWatch = null;      // слежение за GPS на экране окна
let lastPhoto = null;      // { stop, url } — для «Сохранить сторис»
let onExit = () => {};

// ---------- Прогресс ----------
function load() { try { Object.assign(state, JSON.parse(localStorage.getItem('kid-state') || '{}')); } catch { /* приватный режим */ } }
function save() { try { localStorage.setItem('kid-state', JSON.stringify(state)); } catch { /* приватный режим */ } }

const windows = () => route.stops.filter(s => s.type === 'window');
const isDone = s => state.done.includes(s.id);
const nextStop = () => route.stops.find(s => !isDone(s));
const outfitImg = id => route.outfits[id].img;
const ageGroup = years => years <= 5 ? '3-5' : years <= 8 ? '6-8' : '9-11';
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

// ---------- Голос: оленёнок читает вслух ----------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  u.rate = 0.95;
  const ru = speechSynthesis.getVoices().find(v => v.lang.startsWith('ru'));
  if (ru) u.voice = ru;
  speechSynthesis.speak(u);
}

// ---------- Оленёнок-персонаж ----------
let bubbleTimer = null;
function fawnSays(text, { voice = false } = {}) {
  const b = $('fawn-bubble');
  b.textContent = text;
  b.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.hidden = true; }, 6000);
  if (voice) speak(text);
}
function fawnLine() {
  const n = nextStop();
  if (!n) return `Мы открыли все окна! ${child.name}, ты настоящий путешественник во времени!`;
  return n.type === 'window'
    ? `Следующее окно в прошлое — «${n.title}». Найдём, где стоял фотограф?`
    : `Идём к остановке «${n.title}». У меня есть задание!`;
}

// ---------- Тропа дня ----------
const ROW = 118, TOP = 86, BOTTOM = 70;

function renderTrail() {
  const total = windows().length;
  const opened = windows().filter(isDone).length;
  $('kid-title').textContent = 'Тропа ' + child.nameGenitive;
  $('kid-progress').textContent = `${opened} из ${total} ${plural(total, 'окна', 'окон', 'окон')}`;
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
    const icon = isDone(p.s) ? ICONS.check : p.s.type === 'window' ? ICONS.camera : ICONS.star;
    const sub = p.s.type === 'window' ? `Окно · ${p.s.years}` : 'Задание';
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
  ['task-page', 'stamp-page', 'window-page', 'result-page'].forEach(p => { $(p).hidden = p !== id; });
}
function backToTrail() {
  window.speechSynthesis?.cancel();
  if (stopWatch) stopWatch();
  stopWatch = null;
  closeCamera();
  showPage(null);
  renderTrail();
}

function openStop(s) {
  current = s;
  if (s.type === 'task') openTask(s); else openWindow(s);
}

// ---------- Задание ----------
function openTask(s) {
  const tasks = route.stops.filter(x => x.type === 'task');
  $('task-title').textContent = s.title;
  $('task-count').textContent = `${tasks.indexOf(s) + 1} из ${tasks.length}`;
  $('task-fawn').src = outfitImg(state.outfit);
  $('task-text').textContent = s.tasks[child.ageGroup];
  $('task-intro').textContent = s.intro;
  showPage('task-page');
  speak(s.intro + ' ' + s.tasks[child.ageGroup]);
}

function finishStop(s) {
  if (!isDone(s)) state.done.push(s.id);
  save();
}

function showStamp(s) {
  const all = route.stops;
  $('stamp-icon').innerHTML = s.type === 'window' ? ICONS.camera : ICONS.star;
  $('stamp-text').textContent = `Штамп «${s.title}» твой!`;
  $('stamp-row').innerHTML = all.map(x => `<span class="${isDone(x) ? 'on' : ''}"></span>`).join('');
  $('stamp-next').textContent = nextStop() ? 'Дальше по тропе' : 'Тропа пройдена!';
  showPage('stamp-page');
  speak(`Штамп «${s.title}» твой!`);
}

// ---------- Окно, шаг 1: старое фото и место фотографа ----------
function openWindow(s) {
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

// Шаг 2: камера
$('win-camera').addEventListener('click', async () => {
  if (stopWatch) stopWatch();
  stopWatch = null;
  await enableCompass();   // iPhone: разрешение — только по нажатию
  openCamera(current, state.demo, (url, aspect) => showResult(current, url, aspect));
});

// Шаг 3: окно открыто
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
  if (firstTime) showReward(s.outfit); else speak(s.kidText);
}

function showReward(outfitId) {
  const o = route.outfits[outfitId];
  $('reward-img').src = o.img;
  $('reward-text').textContent = `Оленёнок теперь — ${o.title.toLowerCase()}!`;
  $('reward').hidden = false;
  speak('Ура, окно открыто! У меня новый наряд!');
  $('reward-ok').onclick = () => {
    $('reward').hidden = true;
    state.outfit = outfitId;
    save();
    $('fawn-img').src = o.img;
    $('fawn-buddy').classList.remove('bounce');
    void $('fawn-buddy').offsetWidth;   // перезапуск анимации
    $('fawn-buddy').classList.add('bounce');
    speak(current.kidText);
  };
}

// «Сохранить сторис»: картинка 1080×1920 — сверху «тогда», снизу «сейчас»
async function saveStory() {
  if (!lastPhoto) return;
  const { stop: s, url } = lastPhoto;
  const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
  const [oldImg, nowImg, fawn] = await Promise.all([loadImg(s.photo.url), loadImg(url), loadImg(outfitImg(s.outfit))]);
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
  route = await (await fetch('data/kid-route.json')).json();
  child = { name: options.childName, nameGenitive: options.childNameGenitive, ageGroup: ageGroup(options.ageYears) };
  onExit = options.onExit;
  load();
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) state.demo = q.get('demo') !== '0';
  if (q.has('reset')) { state.done = []; state.outfit = 'base'; }
  save();

  $('kid-go').onclick = () => { const n = nextStop(); if (n) openStop(n); };
  $('kid-exit').onclick = closeKid;
  $('fawn-buddy').onclick = () => fawnSays(fawnLine(), { voice: true });
  document.querySelectorAll('.kid-mode [data-back]').forEach(b => b.addEventListener('click', backToTrail));
  $('task-speak').onclick = () => speak(current.intro + ' ' + current.tasks[child.ageGroup]);
  $('task-done').onclick = () => { finishStop(current); showStamp(current); };
  $('stamp-next').onclick = backToTrail;
  $('stamp-return').onclick = closeKid;
  $('res-range').oninput = e => $('res-tn').style.setProperty('--cut', e.target.value + '%');
  $('res-next').onclick = () => { window.speechSynthesis?.cancel(); showStamp(current); };
  $('res-save').onclick = () => saveStory().catch(err => alert('Не получилось сохранить: ' + err.message));
  addEventListener('resize', () => { if (!$('kid-mode').hidden) renderTrail(); });
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
  route.stops.sort((a, b) => pos(a.id) - pos(b.id));
  if (!$('kid-mode').hidden) renderTrail();
}

// Что у ребёнка на этой остановке — для строки в ленте «Сегодня»
export function kidStopInfo(activityId) {
  const s = route && route.stops.find(x => x.id === activityId);
  if (!s) return null;
  return { type: s.type, years: s.years || null, done: isDone(s), photo: s.photo ? s.photo.url : null };
}
