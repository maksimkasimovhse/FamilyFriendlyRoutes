// Детский режим «Тропа Маши».
// Тропа строится из ВСЕХ мест итогового маршрута (setKidRoute: сохранённая поездка, по дням и в порядке маршрута); пока маршрута нет,
// показывается демо-тропа из data/kid-route.json. На каждой остановке ровно одно задание: игра с картинкой
// объекта (пазл, пиксель-пазл или раскраска по номерам; вид задан полем game у места в data/cards.json —
// поровну на все места) или вопросы (quiz, только у памятника Чкалову, текст в data/kid-quiz.json).
// Решил задание — получил штамп. Озвучки нет. Прогресс — только в этом браузере (localStorage).
//
// Плюс два «Окна в прошлое» (PAST_IDS, первые остановки): старое фото PastVu → встать на место фотографа →
// камера с полупрозрачным старым кадром → «тогда / сейчас», новый наряд оленёнка, сторис.
//
// ?reset=1 — начать тропу заново. ?demo=0 — окно открывается только на месте (по GPS);
// по умолчанию демо: «считаем, что вы на месте».

import { startGame, GAME_LABELS, GAME_HINTS } from './games.js';
import { loadCards, cardById, allCards, orderByNearest } from './catalog.js';
import { watchPlace, enableCompass, openCamera, closeCamera, prepareOld } from './camera.js';

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
const PAST_IDS = ['win_minin', 'win_pokrovka'];
const isWindow = s => PAST_IDS.includes(s.id);
const pastStops = () => PAST_IDS.map(id => route.demoStops.find(s => s.id === id)).filter(Boolean);

// ---------- Прогресс ----------
function load() { try { Object.assign(state, JSON.parse(localStorage.getItem('kid-state') || '{}')); } catch { /* приватный режим */ } }
function save() { try { localStorage.setItem('kid-state', JSON.stringify(state)); } catch { /* приватный режим */ } }

// Вид и картинки задания остановки: берутся у места из каталога (data/cards.json)
function gameOf(s) {
  const card = cardById(s.place);
  return { type: card.game, dir: 'media/kid/' + card.id, image: card.image.full, questions: quiz[card.id]?.questions };
}
const placeStop = card => ({ id: 'place_' + card.id, type: 'task', title: card.title, point: card.location, place: card.id });

// ---------- Тропа из итогового маршрута ----------
// В тропе все места сохранённого маршрута, по дням и в порядке маршрута. У места из нашего каталога (174 карточки)
// задание из его картинки; у места, которого в каталоге нет, — отметка «Мы здесь» и штамп.
let routeStops = null;       // остановки итогового маршрута (null — маршрута ещё нет, показываем демо-тропу)
const norm = t => String(t || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
function cardForStop(stop) {
  const m = /^activity:main:(\d+):/.exec(stop.activity_id || '');       // id места из нашего каталога зашит в activity_id
  if (m && cardById(m[1])) return cardById(m[1]);
  const key = norm(stop.title);
  return allCards().find(c => norm(c.title) === key) || null;           // иначе — по точному названию
}
function stopFromRoute(stop, date) {
  const card = cardForStop(stop);
  const base = { activity: stop.activity_id, date, point: stop.location?.coordinates || card?.location };
  return card
    ? { ...placeStop(card), ...base, point: base.point || card.location }
    : { id: 'stop_' + stop.activity_id, type: 'visit', title: stop.title, ...base };
}
function applyPicks() {
  const cards = state.picks.map(cardById).filter(Boolean);
  const stops = routeStops?.length ? routeStops : cards.length ? cards.map(placeStop) : [...route.demoStops];
  const ws = pastStops();
  // окна — первыми остановками; те же места без окна из тропы убираем
  route.stops = [...ws, ...stops.filter(s => !ws.some(w => w.id === s.id || w.place === s.place))];
}
const kindLabel = s => isWindow(s) ? `Окно в прошлое · ${s.years}` : s.type === 'visit' ? 'Отметиться на месте' : GAME_LABELS[gameOf(s).type];
// В поездке на несколько дней у каждой точки подписан день
const dayWord = iso => { const d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' }).replace(/^./, c => c.toUpperCase()); };
const stopSub = s => kindLabel(s) + (route.stops.some(x => x.date && x.date !== route.stops.find(y => y.date)?.date) && s.date ? ' · ' + dayWord(s.date) : '');
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
const ROW = 118, TOP = 86, BOTTOM = 70;      // ROW — минимальный шаг между точками; при малом числе точек шаг растёт до края экрана

function renderTrail() {
  const total = route.stops.length;
  const opened = route.stops.filter(isDone).length;
  $('kid-title').textContent = 'Тропа ' + child.nameGenitive;
  $('kid-progress').textContent = `★ ${opened}/${total}`;
  $('kid-progress').setAttribute('aria-label', `${opened} из ${total} ${plural(total, 'задания', 'заданий', 'заданий')}`);
  $('fawn-img').src = outfitImg(state.outfit);

  const map = $('trail-map');
  const w = map.clientWidth || 360;
  const n = route.stops.length;
  // Шаг между точками подстраивается под экран: 2–3 точки растягиваются от низа до верха, много точек идут с минимальным
  // шагом, и тропа растёт вверх сколько нужно (длинный маршрут на много дней просто пролистывается).
  const view = $('trail-scroll').clientHeight;
  const step = n > 1 ? Math.max(ROW, (view - TOP - BOTTOM) / (n - 1)) : ROW;
  const h = Math.max(TOP + (n - 1) * step + BOTTOM, view);
  map.style.height = h + 'px';
  // Первая остановка внизу — тропа идёт вверх, к реке
  const pts = route.stops.map((s, i) => ({ s, x: (i % 2 === 0 ? 0.22 : 0.78) * w, y: h - BOTTOM - i * step }));

  let path = `M${pts[0].x} ${pts[0].y + 60}`;
  pts.forEach((p, i) => {
    const prev = i === 0 ? { x: p.x, y: p.y + 60 } : pts[i - 1];
    path += ` C${prev.x} ${prev.y - step * 0.55}, ${p.x} ${p.y + step * 0.55}, ${p.x} ${p.y}`;
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
    const sub = stopSub(p.s);
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
  if (isWindow(s)) openWindow(s); else if (s.type === 'visit') openVisit(s); else openGame(s);
}

// Место без нашей картинки: дойти и отметиться, за это штамп
function openVisit(s) {
  stopGame();
  $('game-title').textContent = s.title;
  $('game-kind').textContent = 'На месте';
  $('game-fawn').src = outfitImg(state.outfit);
  $('game-hint').textContent = 'Дойдите до места, оглядитесь и нажмите «Мы здесь!»';
  $('game-progress').textContent = '';
  const area = $('game-area');
  area.replaceChildren();
  const pic = document.createElement('img');
  pic.src = outfitImg(state.outfit); pic.alt = ''; pic.className = 'visit-fawn';
  area.append(pic);
  const done = $('game-done');
  done.disabled = false;
  done.classList.add('win');
  done.textContent = 'Мы здесь! Забрать штамп';
  done.onclick = () => afterGame(s);
  showPage('game-page');
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
  $('stamp-next').textContent = 'Вернуться на тропу';
  showPage('stamp-page');
}

// ---------- Окно в прошлое, шаг 1: старый кадр и задание ----------
const NOW_YEAR = new Date().getFullYear();
const yearsOf = s => s.years.split(/[–-]/).map(Number);
// «больше 100 лет назад» — по последнему году съёмки, округляя вниз до десятка
function agoText(s) {
  const n = NOW_YEAR - yearsOf(s).pop();
  return n >= 20 ? `Больше ${Math.floor(n / 10) * 10} лет назад` : `${n} ${plural(n, 'год', 'года', 'лет')} назад`;
}

async function openWindow(s) {
  stopGame();
  $('win-title').textContent = s.title;
  $('win-years').textContent = s.years;
  $('win-ago').textContent = `${agoText(s)} здесь стоял фотограф. Найди его место — и посмотри на площадь его глазами.`;
  $('win-old').alt = `Старое фото: ${s.title}, ${s.years}`;
  $('win-old').src = s.photo.url;
  showPage('window-page');
  $('window-page').querySelector('.past-scroll').scrollTop = 0;
  const btn = $('win-camera');
  stopWatch = watchPlace(s, state.demo, st => {
    $('win-place').textContent = st.text;
    $('win-place').classList.toggle('ready', st.ready);
    btn.disabled = !st.ready;
  });
  prepareOld(s).then(a => { if (current === s) $('win-old').src = a.url; }).catch(() => {});
}

// Шаг 2: камера с окном в пропорциях старого кадра
async function startCamera() {
  if (stopWatch) { stopWatch(); stopWatch = null; }
  await enableCompass();   // iPhone: разрешение — только по нажатию
  openCamera(current, state.demo, (url, asset) => showResult(current, url, asset));
}

// Шаг 3: окно открыто — карточка «тогда / сейчас» переворачивается; первый раз — сама, для эффекта
let flipTimer = 0;
function setFlip(now) {
  $('res-tn').classList.toggle('flipped', now);
  $('res-tn').setAttribute('aria-label', now ? 'Сейчас. Нажмите, чтобы увидеть, как было тогда' : 'Тогда. Нажмите, чтобы увидеть, как сейчас');
}

function showResult(s, url, asset) {
  lastPhoto = { stop: s, url, asset };
  $('res-title').textContent = s.title;
  $('res-years').textContent = s.years;
  $('res-now-year').textContent = String(NOW_YEAR);
  $('res-tn').style.aspectRatio = String(asset.aspect);
  clearTimeout(flipTimer);
  setFlip(false);
  $('res-now').src = url;
  $('res-old').src = asset.url;
  $('res-old').alt = `Тогда: ${s.title}, ${s.years}`;
  $('res-attrib').innerHTML = '';
  const a = document.createElement('a');
  a.href = s.photo.sourceUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s.photo.attribution;
  $('res-attrib').append(a);
  const gap = NOW_YEAR - yearsOf(s)[0];
  $('res-gap').innerHTML = `<b>${gap}</b><span>${plural(gap, 'год', 'года', 'лет')} между этими кадрами</span>`;
  $('res-kid').textContent = s.kidText;
  $('res-adult').textContent = s.adultText;
  $('res-source').textContent = 'Источник: ' + s.textSource;
  showPage('result-page');
  $('result-page').querySelector('.past-scroll').scrollTop = 0;
  flipTimer = setTimeout(() => setFlip(true), 1400);

  const firstTime = !isDone(s);
  finishStop(s);
  if (firstTime && s.outfit) setTimeout(() => { if (!$('result-page').hidden) showReward(s.outfit); }, 3000);
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

// «Сторис» 1080×1920: два кадра один над другим — горизонтальные фото так ложатся без обрезки
async function saveStory() {
  if (!lastPhoto) return;
  const { stop: s, url, asset } = lastPhoto;
  await document.fonts.load('400 100px Prata').catch(() => {});
  await document.fonts.load('800 60px Nunito').catch(() => {});
  const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
  const [oldImg, nowImg, fawn] = await Promise.all([loadImg(asset.url), loadImg(url), loadImg(outfitImg(state.outfit)).catch(() => null)]);
  const W = 1080, H = 1920, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1A1612'); bg.addColorStop(.5, '#14182A'); bg.addColorStop(1, '#101626');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, 0, 0, W / 2, 0, 900);
  glow.addColorStop(0, 'rgba(201,146,82,.35)'); glow.addColorStop(1, 'rgba(201,146,82,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, 900);

  const PW = 920, PH = Math.round(PW / asset.aspect), X = (W - PW) / 2;
  const photo = (img, y, rot, tag, tagColor) => {
    g.save(); g.translate(W / 2, y + PH / 2); g.rotate(rot * Math.PI / 180);
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 50; g.shadowOffsetY = 20;
    g.fillStyle = '#F4EBDD'; g.beginPath(); g.roundRect(-PW / 2 - 16, -PH / 2 - 16, PW + 32, PH + 32, 24); g.fill();
    g.shadowColor = 'transparent';
    g.save(); g.beginPath(); g.roundRect(-PW / 2, -PH / 2, PW, PH, 12); g.clip();
    g.drawImage(img, -PW / 2, -PH / 2, PW, PH); g.restore();
    g.font = '800 34px Nunito, sans-serif';
    const tw = g.measureText(tag).width + 48;
    g.fillStyle = tagColor; g.beginPath(); g.roundRect(-PW / 2 + 22, -PH / 2 + 22, tw, 60, 30); g.fill();
    g.fillStyle = '#fff'; g.fillText(tag, -PW / 2 + 46, -PH / 2 + 63);
    g.restore();
  };

  g.font = '800 32px Nunito, sans-serif';
  const kw = g.measureText('ОКНО В ПРОШЛОЕ').width + 68;
  g.fillStyle = 'rgba(244,235,221,.12)'; g.beginPath(); g.roundRect(X, 110, kw, 70, 35); g.fill();
  g.fillStyle = '#E9C79A'; g.fillText('ОКНО В ПРОШЛОЕ', X + 34, 157);
  g.fillStyle = '#fff'; g.font = '800 64px Nunito, sans-serif'; g.fillText(s.title, X, 270, PW);

  const y1 = 340, mid = y1 + PH + 40;
  photo(oldImg, y1, -1.5, s.years, '#8A5A2B');
  const gap = NOW_YEAR - yearsOf(s)[0];
  g.textAlign = 'center';
  g.fillStyle = '#E9C79A'; g.font = '400 120px Prata, Georgia, serif'; g.fillText(String(gap), W / 2, mid + 110);
  g.fillStyle = 'rgba(244,235,221,.75)'; g.font = '700 38px Nunito, sans-serif'; g.fillText(`${plural(gap, 'год', 'года', 'лет')} спустя мы стоим на том же месте`, W / 2, mid + 170);
  g.textAlign = 'left';
  const y2 = mid + 230;
  photo(nowImg, y2, 1.2, `${NOW_YEAR} · мы`, '#2463D6');
  if (fawn) { g.save(); g.translate(W - 170, y2 + PH + 10); g.rotate(8 * Math.PI / 180); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 30; g.drawImage(fawn, -120, -132, 240, 264); g.restore(); }
  g.fillStyle = 'rgba(244,235,221,.5)'; g.font = '600 26px Nunito, sans-serif';
  g.fillText(s.photo.attribution, X, H - 70, PW - 240);

  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
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

function holdToExit(btn, done) {
  const HOLD = 1200;
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    btn.classList.add('holding');
    timer = setTimeout(() => { stop(); done(); }, HOLD);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
  btn.addEventListener('contextmenu', e => e.preventDefault());
  // с клавиатуры (Enter/пробел) выход остаётся обычным — это взрослый с клавиатурой, не ребёнок
  btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done(); } });
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
  // Выход — только удержанием 1,2 с: ребёнок не выйдет случайным касанием
  holdToExit($('kid-exit'), closeKid);
  $('fawn-buddy').onclick = () => fawnSays(fawnLine());
  document.querySelectorAll('.kid-mode [data-back]').forEach(b => b.addEventListener('click', backToTrail));
  $('stamp-next').onclick = backToTrail;
  $('win-camera').onclick = startCamera;
  $('res-tn').onclick = () => { clearTimeout(flipTimer); setFlip(!$('res-tn').classList.contains('flipped')); };
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

// Итоговый маршрут: остановки сохранённой поездки (trip.days[].stops) по дням и в порядке маршрута.
// trip === null — маршрута нет, возвращаемся к демо-тропе. Прогресс (state.done) не сбрасывается: id места тот же.
export function setKidRoute(trip) {
  if (!route) return;
  routeStops = null;
  const seen = new Set();
  const stops = [];
  for (const day of [...(trip?.days || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    for (const stop of day.stops || []) {
      if (stop.progress === 'removed') continue;
      const s = stopFromRoute(stop, day.date);
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      stops.push(s);
    }
  }
  if (stops.length) routeStops = stops;
  applyPicks();
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
  if (!route) return null;
  const mine = route.stops.find(x => x.activity === activityId);
  if (mine) return { type: 'task', label: kindLabel(mine), years: null, done: isDone(mine), photo: null };
  const s = route.demoStops.find(x => x.id === activityId);
  if (!s) return null;
  if (isWindow(s)) return { type: 'window', label: 'Окно в прошлое', years: s.years, done: isDone(s), photo: s.photo.url };
  return { type: 'task', label: GAME_LABELS[gameOf(s).type], years: null, done: isDone(s), photo: null };
}
