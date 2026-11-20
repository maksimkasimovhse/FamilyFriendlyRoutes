// Экран «Подбор мест»: карточки как в Tinder.
// Свайп вправо (или ♥) — место попадает в маршрут, влево (или ✕) — не нравится.
// «Завершить подбор мест» отдаёт выбранные места наружу (onFinish) — app.js открывает карту.
// Тексты вставляются только через textContent: описания приходят из данных, а не из нашей разметки.
import { createPlaceEmoji } from './place-display.js';
import { withinCardRadius } from './recommendation-cards.js';

const SWIPE_PX = 100;        // на сколько нужно утянуть карточку, чтобы решение засчиталось
const FLING_SPEED = 0.55;    // быстрый «щелчок» (px/мс) тоже засчитывается, даже если утянули недалеко
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
let busy = false;        // карточка улетает — новые решения пока не принимаем
let onFinish = () => {};
let onClose = () => {};
let loading = null;
let configuration = null;
let currentDate = null;
const choicesToday = () => configuration?.tripLimit != null ? liked.length : liked.filter(c => c.preferred_date === currentDate).length;
const dayLimit = () => configuration?.tripLimit ?? configuration?.days.find(d => d.date === currentDate)?.limit ?? Infinity;
function renderDayTabs() {
  let tabs = $('pick-day-tabs');
  if (!tabs) { tabs = el('div', 'day-tabs'); tabs.id = 'pick-day-tabs'; $('deck').before(tabs); }
  tabs.replaceChildren(); tabs.hidden = !configuration || configuration.tripLimit != null || configuration.days.length<=1;
  if (tabs.hidden) return;
  configuration.days.forEach(d => {
    const b = el('button', null, `${new Date(d.date+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'})} · ${liked.filter(c=>c.preferred_date===d.date).length}/${d.limit}`);
    b.type='button'; b.setAttribute('aria-pressed',String(d.date===currentDate));
    b.onclick=()=>{ if(busy)return;currentDate=d.date;startDeck(false); };
    tabs.append(b);
  });
}

// ---------- Данные ----------
function loadCards() {
  loading ??= fetch('data/cards.json')
    .then(r => { if (!r.ok) throw new Error('cards.json: HTTP ' + r.status); return r.json(); })
    .then(list => { all = list; });
  return loading;
}

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

  const yes = el('div', 'stamp yes', 'В МАРШРУТ');
  const no = el('div', 'stamp no', 'НЕТ');
  root.append(photo, body, yes, no);
  return root;
}

// Стопка: верхняя карточка тянется пальцем, остальные чуть меньше и ниже.
function layoutStack() {
  const stack = $('deck');
  const cards = [...stack.querySelectorAll('.pcard')];
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

function updateHud() {
  const left = deck.length - pos;
  $('pick-count').textContent = configuration?.tripLimit != null ? `Выбрано ${liked.length} из ${configuration.tripLimit} на поездку` : configuration ? `Можно добавить: ${choicesToday()} из ${dayLimit()}` : `Выбрано ${liked.length} · ещё ${left}`;
  const finish = $('pick-finish');
  finish.disabled = liked.length === 0;
  finish.textContent = liked.length ? `Завершить подбор мест (${liked.length})` : 'Завершить подбор мест';
  $('pick-hint').hidden = liked.length > 0;
  const empty = left === 0;
  $('pick-yes').disabled = $('pick-no').disabled = $('pick-info').disabled = empty;
  if (choicesToday() >= dayLimit()) $('pick-yes').disabled = true;
  renderDayTabs();
}

// ---------- Свайп ----------
function bindDrag(card) {
  card.dataset.bound = '1';
  let startX = 0, startY = 0, dx = 0, dy = 0, lastX = 0, lastT = 0, vx = 0, down = false;

  card.addEventListener('pointerdown', e => {
    if (busy || e.button > 0) return;
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
  });

  const end = e => {
    if (!down) return;
    down = false;
    card.classList.remove('drag');
    try { card.releasePointerCapture(e.pointerId); } catch { /* захвата не было */ }
    const moved = Math.hypot(dx, dy);
    if (e.type === 'pointercancel') return reset(card);
    if (moved < 8) { reset(card); openDetails(); return; }   // просто нажатие — читать полностью
    if (Math.abs(dx) > SWIPE_PX || (Math.abs(vx) > FLING_SPEED && Math.abs(dx) > 30)) decide(dx > 0 ? 'yes' : 'no', dy);
    else reset(card);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function setDrag(card, dx, dy) {
  card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
  const k = Math.min(Math.abs(dx) / SWIPE_PX, 1);
  card.querySelector('.stamp.yes').style.opacity = dx > 0 ? k : 0;
  card.querySelector('.stamp.no').style.opacity = dx < 0 ? k : 0;
}

function reset(card) {
  card.style.transform = '';
  card.querySelectorAll('.stamp').forEach(s => { s.style.opacity = 0; });
}

// Решение: карточка улетает за экран, место попадает в «выбрано» или в «не нравится».
function decide(choice, dy = 0) {
  const stack = $('deck');
  const top = stack.querySelector('.pcard[data-pos="0"]');
  if (!top || busy) return;
  if (choice === 'yes' && choicesToday() >= dayLimit()) { reset(top); return; }
  busy = true;
  closeDetails();
  const card = deck[pos];
  const dir = choice === 'yes' ? 1 : -1;
  top.classList.add('fly');
  top.style.transform = `translate(${dir * (window.innerWidth + 200)}px, ${dy}px) rotate(${dir * 24}deg)`;
  top.querySelector(`.stamp.${choice}`).style.opacity = 1;
  if (choice === 'yes') liked.push(card); else disliked++;
  pos++;
  setTimeout(() => {
    top.remove();
    if(choice==='yes' && configuration?.days.find(d=>d.date===currentDate)?.anchorOnFirstPick && choicesToday()===1) startDeck(false);
    else layoutStack();
    busy = false;
  }, FLY_MS);
  updateHud();
}

// ---------- Описание целиком ----------
function openDetails() {
  const card = deck[pos];
  if (!card) return;
  const sheet = $('pick-sheet');
  const img = $('sheet-img');
  img.hidden = !card.image?.full;
  if (card.image?.full) img.src = card.image.full;
  img.alt = card.image?.alt || card.title;
  $('sheet-cat').textContent = card.category;
  $('sheet-title').textContent = card.title;
  $('sheet-addr').textContent = card.address;
  const text = $('sheet-text');
  text.replaceChildren(...card.text.map(p => el('p', null, p)));
  sheet.hidden = false;
  sheet.querySelector('.sheet-scroll').scrollTop = 0;
}
function closeDetails() { $('pick-sheet').hidden = true; }

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
  $('pick-yes').addEventListener('click', () => decide('yes'));
  $('pick-no').addEventListener('click', () => decide('no'));
  $('pick-info').addEventListener('click', openDetails);
  $('pick-back').addEventListener('click', () => onClose());
  $('pick-finish').addEventListener('click', () => { if (liked.length) onFinish([...liked]); });
  $('pick-restart').addEventListener('click', startDeck);
  $('sheet-close').addEventListener('click', closeDetails);
  $('pick-sheet').addEventListener('click', e => { if (e.target.id === 'pick-sheet') closeDetails(); });
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
      await loadCards();
      const normalize = title => title.trim().toLocaleLowerCase('ru-RU');
      const presentations = new Map();
      all.forEach(card => { const key=normalize(card.title); presentations.set(key,presentations.has(key)?null:card); });
      for (const cards of options.tripLimit != null ? [options.cards] : Object.values(options.cardsByDay)) for (const card of cards) {
        const presentation=presentations.get(normalize(card.title));
        if(presentation) { card.image=presentation.image; if(!card.address)card.address=presentation.address; card.text=[...presentation.text,...card.text]; }
      }
    } catch { /* No presentation data: keep the ranked backend cards without photos. */ }
    configuration = options; currentDate = options.days[0]?.date || null;
    liked = [...(options.selected || [])].filter(c=>options.tripLimit != null ? options.cards.some(x=>x.activity_id===c.activity_id) : options.days.some(d=>d.date===c.preferred_date) && options.cardsByDay[c.preferred_date]?.some(x=>x.activity_id===c.activity_id));
    const note=document.querySelector('.pick-flow-sub');
    if(note)note.textContent=options.tripLimit!=null ? 'Выберите места на всю поездку — распределим их по дням с учётом близости и бюджета.' : 'Дополнительные места рядом с последней активностью маршрута.';
    startDeck(false); return;
  }
  configuration = null;
  try {
    await loadCards();
  } catch (err) {
    console.error(err);
    $('deck-empty').hidden = false;
    $('deck-empty').querySelector('p').textContent = 'Не удалось загрузить карточки: ' + err.message;
    return;
  }
  if (!deck.length) startDeck();
}

export const pickedPlaces = () => [...liked];
