// Экран «Подбор мест»: карточки как в Tinder.
// Свайп вправо (или ♥) — место попадает в маршрут, влево (или ✕) — не нравится.
// «Завершить подбор мест» отдаёт выбранные места наружу (onFinish) — app.js открывает карту.
// Тексты вставляются только через textContent: описания приходят из данных, а не из нашей разметки.
import { createPlaceEmoji } from './place-display.js';
import { withinCardRadius } from './recommendation-cards.js';

import { loadCards } from './catalog.js';

const SWIPE_PX = 45;         // на сколько нужно утянуть карточку, чтобы решение засчиталось
const FLING_SPEED = 0.25;    // быстрый «щелчок» (px/мс) тоже засчитывается, даже если утянули недалеко
const COMMIT_PX = 110;       // дальше этого решение принимается на лету, палец можно не отпускать
const FLY_MS = 280;          // сколько летит карточка за экран
const VISIBLE = 3;           // сколько карточек видно стопкой

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let all = [];            // все карточки из data/cards.json
let deck = [];           // порядок показа (перемешан)
let pos = 0;             // индекс верхней карточки
let liked = [];          // выбранные места, в порядке свайпов
let disliked = 0;
let onFinish = () => {};
let onClose = () => {};
let busy = false;
let configuration = null;
let currentDate = null;
const choicesToday = () => configuration?.tripLimit != null ? liked.length : liked.filter(c => c.preferred_date === currentDate).length;
function renderDayTabs() {
  let tabs = $('pick-day-tabs');
  if (!tabs) { tabs = el('div', 'day-tabs'); tabs.id = 'pick-day-tabs'; $('deck').before(tabs); }
  tabs.replaceChildren(); tabs.hidden = !configuration || configuration.tripLimit != null || configuration.days.length<=1;
  if (tabs.hidden) return;
  configuration.days.forEach(d => {
    const b = el('button', null, `${new Date(d.date+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'})} · ${liked.filter(c=>c.preferred_date===d.date).length}`);
    b.type='button'; b.setAttribute('aria-pressed',String(d.date===currentDate));
    b.onclick=()=>{ if(busy)return;currentDate=d.date;startDeck(false); };
    tabs.append(b);
  });
}

// ---------- Данные ----------
const loadAll = () => loadCards().then(list => { all = list; });

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Карточка ----------
function buildCard(card) {
  const root = el('article', 'pcard');
  root.dataset.id = card.id;

  const photo = el('div', 'pcard-photo');
  const img = el('img');
  if (card.image?.card) img.src = card.image.card;
  else { img.hidden = true; photo.append(el('span','pcard-no-photo','Фото пока нет')); }
  img.alt = card.image?.alt || card.title;
  img.draggable = false;
  img.decoding = 'async';
  const category=el('span','pcard-cat');category.append(createPlaceEmoji(card.category_key),document.createTextNode(card.category));
  photo.append(img, category);

  const body = el('div', 'pcard-body');
  body.append(el('h2', null, card.title), el('p', 'pcard-addr', card.address));
  const desc = el('p', 'pcard-desc', card.text.join(' '));
  const more = el('span', 'pcard-more', 'Читать полностью ›');
  body.append(desc, more);

  const yes = el('div', 'pstamp yes', 'В МАРШРУТ');
  const no = el('div', 'pstamp no', 'НЕТ');
  root.append(photo, body, yes, no);
  return root;
}

// Стопка: верхняя карточка тянется пальцем, остальные чуть меньше и ниже.
function layoutStack() {
  const stack = $('deck');
  const cards = [...stack.querySelectorAll('.pcard:not(.gone)')];   // улетающие уже не в стопке
  cards.forEach((c, i) => { c.dataset.pos = i; });
  while (cards.length < VISIBLE && pos + cards.length < deck.length) {
    const c = buildCard(deck[pos + cards.length]);
    c.dataset.pos = cards.length;
    stack.append(c);
    cards.push(c);
  }
  const top = cards[0];
  if (top && !top.dataset.bound) bindDrag(top);
  $('deck-empty').hidden = cards.length > 0;
  updateHud();
}

// Сколько мест нужно выбрать как минимум (по два на день); если карточек в подборке меньше — столько, сколько есть
const minNeeded = () => configuration?.minTotal ? Math.min(configuration.minTotal, configuration.cards?.length ?? configuration.minTotal) : 1;

function updateHud() {
  const left = deck.length - pos;
  const need = Math.max(0, minNeeded() - liked.length);
  if (configuration?.tripLimit != null) {
    $('pick-count').textContent = need
      ? `Выбрано ${liked.length} · нужно минимум ${minNeeded()} (по 2 на день)`
      : `Выбрано ${liked.length} · можно выбирать сколько угодно`;
  } else if (configuration) {
    $('pick-count').textContent = `Добавлено: ${choicesToday()}`;
  } else {
    $('pick-count').textContent = `Выбрано ${liked.length} · ещё ${left}`;
  }
  const finish = $('pick-finish');
  finish.disabled = liked.length === 0 || need > 0;
  finish.textContent = need > 0 && configuration?.tripLimit != null ? `Выберите ещё ${need}` : liked.length ? `Завершить подбор мест (${liked.length})` : 'Завершить подбор мест';
  renderDayTabs();
}

// ---------- Свайп ----------
function bindDrag(card) {
  card.dataset.bound = '1';
  let startX = 0, startY = 0, dx = 0, dy = 0, lastX = 0, lastT = 0, vx = 0, down = false;

  card.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    down = true;
    startX = lastX = e.clientX; startY = e.clientY; dx = dy = vx = 0; lastT = e.timeStamp;
    try { card.setPointerCapture(e.pointerId); } catch { /* указатель уже не активен — тянем без захвата */ }
    card.classList.add('drag');
  });

  card.addEventListener('pointermove', e => {
    if (!down) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    const dt = e.timeStamp - lastT;
    if (dt > 0) vx = (e.clientX - lastX) / dt;
    lastX = e.clientX; lastT = e.timeStamp;
    setDrag(card, dx, dy);
    // Увели достаточно далеко — решение принято сразу, не дожидаясь, пока отпустят палец
    if (Math.abs(dx) > COMMIT_PX && Math.abs(dx) > Math.abs(dy) * 0.7) {
      down = false;
      card.classList.remove('drag');
      try { card.releasePointerCapture(e.pointerId); } catch { /* захвата не было */ }
      decide(dx > 0 ? 'yes' : 'no', dy, card);
    }
  });

  const end = e => {
    if (!down) return;
    down = false;
    card.classList.remove('drag');
    try { card.releasePointerCapture(e.pointerId); } catch { /* захвата не было */ }
    const moved = Math.hypot(dx, dy);
    if (e.type === 'pointercancel') return reset(card);
    if (moved < 8) { reset(card); openDetails(); return; }   // просто нажатие — читать полностью
    if (Math.abs(dx) > Math.abs(dy) * 0.7 && (Math.abs(dx) > SWIPE_PX || (Math.abs(vx) > FLING_SPEED && Math.abs(dx) > 14))) decide(dx > 0 ? 'yes' : 'no', dy);
    else reset(card);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function setDrag(card, dx, dy) {
  card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
  const k = Math.min(Math.abs(dx) / SWIPE_PX, 1);
  card.querySelector('.pstamp.yes').style.opacity = dx > 0 ? k : 0;
  card.querySelector('.pstamp.no').style.opacity = dx < 0 ? k : 0;
}

function reset(card) {
  card.style.transform = '';
  card.querySelectorAll('.pstamp').forEach(s => { s.style.opacity = 0; });
}

// Решение: карточка улетает за экран, место попадает в «выбрано» или в «не нравится».
function decide(choice, dy = 0, fromCard = null) {
  const top = fromCard || $('deck').querySelector('.pcard:not(.gone)');
  if (!top || top.classList.contains('gone') || pos >= deck.length) return;
  closeDetails(true);
  const card = deck[pos];
  const dir = choice === 'yes' ? 1 : -1;
  top.classList.add('gone', 'fly');          // выбывает из стопки сразу: следующая карточка доступна без ожидания
  top.dataset.pos = 'x';
  top.style.transform = `translate(${dir * (window.innerWidth + 200)}px, ${dy}px) rotate(${dir * 24}deg)`;
  top.querySelector(`.pstamp.${choice}`).style.opacity = 1;
  if (choice === 'yes') liked.push(card); else disliked++;
  pos++;
  if(choice==='yes' && configuration?.days.find(d=>d.date===currentDate)?.anchorOnFirstPick && choicesToday()===1) startDeck(false);
  else layoutStack();
  setTimeout(() => top.remove(), FLY_MS);
}

// ---------- Описание целиком ----------
// Описание целиком. Карточка «разворачивается»: панель открывается от рамки карточки до края экрана (clip-path),
// фото плавно «оседает», заголовок и абзацы выезжают по очереди. Закрытие — то же в обратную сторону, назад в карточку.
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let detailsCard = null, detailsAnim = null;

// Рамка карточки в координатах экрана подбора → clip-path начальной формы панели
function cardClip(card) {
  const sr = $('screen-pick').getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  return `inset(${cr.top - sr.top}px ${sr.right - cr.right}px ${sr.bottom - cr.bottom}px ${cr.left - sr.left}px round 24px)`;
}

// Фото превращается из рамки фото на карточке в верхнюю часть панели и обратно: меняются положение и размеры,
// а обрезка object-fit: cover подстраивается сама, поэтому кадр не «прыгает» и не меняет разрешение.
function cardPhotoRect(card) { return card.querySelector('.pcard-photo')?.getBoundingClientRect() || null; }
// base — где фото лежит в вёрстке панели; from и to — рамки начала и конца (в координатах экрана)
function morphPhoto(img, base, from, to, options) {
  const at = r => ({ transformOrigin: '0 0', transform: `translate(${r.left - base.left}px, ${r.top - base.top}px)`, width: r.width + 'px', height: r.height + 'px' });
  return img.animate([at(from), at(to)], options);
}

function openDetails() {
  const card = deck[pos];
  if (!card) return;
  const sheet = $('pick-sheet');
  const img = $('sheet-img');
  img.hidden = !card.image?.full;
  if (card.image?.full) {
    img.src = card.image.card || card.image.full;               // уже загружена на карточке — без вспышки при раскрытии
    if (card.image.card && card.image.card !== card.image.full) {
      const full = new Image();
      full.onload = () => { if (!sheet.hidden && deck[pos] === card) img.src = full.src; };
      full.src = card.image.full;
    }
  }
  img.alt = card.image?.alt || card.title;
  $('sheet-cat').textContent = card.category;
  $('sheet-title').textContent = card.title;
  $('sheet-addr').textContent = card.address;
  const text = $('sheet-text');
  text.replaceChildren(...card.text.map(p => el('p', null, p)));
  detailsAnim?.cancel();
  const live = $('deck').querySelector('.pcard:not(.gone)');
  const panel = sheet.querySelector('.sheet-panel');
  sheet.hidden = false;
  sheet.querySelector('.sheet-scroll').scrollTop = 0;
  if (!live || calm()) return;
  detailsCard = live;
  live.style.visibility = 'hidden';                    // карточка «превращается» в панель
  const open = { duration: 520, easing: EASE, fill: 'both' };
  detailsAnim = panel.animate([{ clipPath: cardClip(live) }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], open);
  const photo = cardPhotoRect(live), fin = img.getBoundingClientRect();
  if (!img.hidden && photo) morphPhoto(img, fin, photo, fin, open);
  [...sheet.querySelectorAll('.sheet-text > *, #sheet-text > p, .sheet-actions')].forEach((n, i) => {
    n.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 180 + i * 55, easing: EASE, fill: 'backwards' });
  });
  sheet.querySelector('.sheet-close').animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 260, easing: EASE, fill: 'backwards' });
}

// instant — без анимации (решение принято прямо в описании: карточка тут же улетает).
// Закрытие зеркально открытию: содержимое по очереди уходит (в обратном порядке), фото чуть растёт,
// панель схлопывается в карточку с той же длительностью и кривой.
function closeDetails(instant = false) {
  const sheet = $('pick-sheet');
  if (sheet.hidden) return;
  const live = detailsCard;
  const parts = [];
  const finish = () => {
    parts.forEach(a => a.cancel());
    sheet.hidden = true;
    detailsAnim = null;
    if (live) live.style.visibility = '';
    detailsCard = null;
  };
  if (instant || !live || calm() || !live.isConnected) { detailsAnim?.cancel(); finish(); return; }
  const panel = sheet.querySelector('.sheet-panel');
  const img = $('sheet-img');
  const kids = [...sheet.querySelectorAll('.sheet-text > *, #sheet-text > p, .sheet-actions')];
  const out = { duration: 520, easing: EASE, fill: 'forwards' };
  detailsAnim?.cancel();
  detailsAnim = panel.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: cardClip(live) }], out);
  const scroller = sheet.querySelector('.sheet-scroll');
  const photo = cardPhotoRect(live);
  if (scroller.scrollTop > 0) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  if (!img.hidden && photo) {
    // положение фото в вёрстке панели при прокрутке в самый верх (описание могли пролистать)
    const pr = panel.getBoundingClientRect();
    const base = scroller.scrollTop > 0 ? { left: pr.left, top: pr.top, width: pr.width, height: img.offsetHeight } : img.getBoundingClientRect();
    parts.push(morphPhoto(img, base, base, photo, out));
  }
  kids.forEach((n, i) => {                       // уходят с конца к началу, быстрее, чем появлялись
    parts.push(n.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(14px)' }], { duration: 260, delay: Math.max(0, (kids.length - 1 - i)) * 25, easing: EASE, fill: 'forwards' }));
  });
  parts.push(sheet.querySelector('.sheet-close').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 220, easing: EASE, fill: 'forwards' }));
  detailsAnim.onfinish = finish;
  detailsAnim.oncancel = finish;
}

// ---------- Запуск ----------
function startDeck(resetChoices = true) {
  if (resetChoices) liked = [];
  deck = configuration ? (configuration.tripLimit != null ? configuration.cards : configuration.cardsByDay[currentDate] || []).filter(c=>!liked.some(x=>x.activity_id===c.activity_id)) : shuffled(all);
  const day=configuration?.days.find(d=>d.date===currentDate);
  const first=liked.find(c=>c.preferred_date===currentDate);
  if(day?.anchorOnFirstPick && first) deck=deck.filter(c=>withinCardRadius(first.location,c.location,day.radiusM));
  pos = 0; disliked = 0; busy = false;
  $('deck').querySelectorAll('.pcard').forEach(c => c.remove());
  layoutStack();
}

export function initPick(handlers) {
  onFinish = handlers.onFinish;
  onClose = handlers.onClose;
  $('pick-back').addEventListener('click', () => onClose());
  $('pick-finish').addEventListener('click', () => { if (liked.length) onFinish([...liked]); });
  $('pick-restart').addEventListener('click', startDeck);
  $('sheet-close').addEventListener('click', () => closeDetails());
  
  $('sheet-yes').addEventListener('click', () => decide('yes'));
  $('sheet-no').addEventListener('click', () => decide('no'));
  document.addEventListener('keydown', e => {
    if ($('screen-pick').hidden) return;
    if (e.key === 'ArrowRight') decide('yes');
    else if (e.key === 'ArrowLeft') decide('no');
    else if (e.key === 'Escape') closeDetails();
  });
}

// Открыть экран. Колода собирается при первом открытии; потом продолжаем с того же места.
export async function openPick(options = null) {
  if (options) {
    // Reuse photographs only for an unambiguous exact title match. ML IDs,
    // ranking, day and eligibility always come from the backend pool.
    try {
      await loadAll();
      const normalize = title => title.trim().toLocaleLowerCase('ru-RU');
      const presentations = new Map();
      all.forEach(card => { const key=normalize(card.title); presentations.set(key,presentations.has(key)?null:card); });
      for (const cards of options.tripLimit != null ? [options.cards] : Object.values(options.cardsByDay)) for (const card of cards) {
        const presentation=presentations.get(normalize(card.title));
        if(presentation) { card.presentation_id=presentation.id;card.image=presentation.image; if(!card.address)card.address=presentation.address; card.text=[...presentation.text,...card.text]; }
      }
    } catch { /* No presentation data: keep the ranked backend cards without photos. */ }
    // Подсказка ИИ-чата: места, подходящие по пожеланию, показываем первыми (состав карточек решает backend/ML)
    if (options.rankHint && options.tripLimit != null) {
      const rank = new Map(options.rankHint.map((id, i) => [String(id), i]));
      options.cards = [...options.cards].sort((a, b) => (rank.get(String(a.presentation_id)) ?? 1e9) - (rank.get(String(b.presentation_id)) ?? 1e9));
    }
    configuration = options; currentDate = options.days[0]?.date || null;
    liked = [...(options.selected || [])].filter(c=>options.tripLimit != null ? options.cards.some(x=>x.activity_id===c.activity_id) : options.days.some(d=>d.date===c.preferred_date) && options.cardsByDay[c.preferred_date]?.some(x=>x.activity_id===c.activity_id));
    const note=document.querySelector('.pick-flow-sub');
    if(note)note.textContent=options.tripLimit!=null ? 'Выберите места на всю поездку — распределим их по дням с учётом близости и бюджета.' : (options.title || 'Дополнительные места рядом с последней активностью маршрута.');
    startDeck(false); return;
  }
  configuration = null;
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    $('deck-empty').hidden = false;
    $('deck-empty').querySelector('p').textContent = 'Не удалось загрузить карточки: ' + err.message;
    return;
  }
  const key = ids === undefined ? orderKey : ids ? ids.join(',') : '';
  if (!deck.length || key !== orderKey) {
    orderKey = key;
    order = ids === undefined ? order : ids;
    startDeck();
  }
}

export const pickedPlaces = () => [...liked];
