// Профиль: дети и их интересы, «память о поездке» (статистика, фото, достижения), сторис, мои поездки.
// Фото хранятся ТОЛЬКО на этом устройстве (localStorage, уменьшенные копии) — никуда не отправляются.

import { getTrip, listTrips, openTrip } from './api.js';
import { isAuthenticated, userEmail } from './session.js';
import { currentProfile, childName, ageText, interestLabel, adultInterestLabels } from './onboarding.js';
import { kidProgress } from './kid.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let hooks = { onEditProfile() {}, onNewTrip() {}, onSignOut() {}, onSignIn() {}, onOpenTrip() {} };

// ---------- Фото на память ----------
const PHOTOS_KEY = 'memory-photos-v1';
const MAX_PHOTOS = 8;
const readPhotos = () => { try { return JSON.parse(localStorage.getItem(PHOTOS_KEY)) || []; } catch { return []; } };
function writePhotos(list) { try { localStorage.setItem(PHOTOS_KEY, JSON.stringify(list)); return true; } catch { return false; } }

// Уменьшаем до 900 px по длинной стороне: большие снимки не поместятся в память браузера
function downscale(file) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      ok(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => fail(new Error('Не получилось открыть фото'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Статистика поездки ----------
// Считаем по сохранённой поездке: что пройдено, а если прогулка ещё не началась — что в плане.
function tripStats() {
  const trip = getTrip();
  const days = trip?.days || [];
  const stops = days.flatMap(d => d.stops.filter(s => s.progress !== 'removed'));
  const visited = stops.filter(s => s.progress === 'visited');
  const walked = days.reduce((m, d) => m + (d.execution?.consumed_walk_distance_m || 0), 0);
  const planned = days.reduce((m, d) => m + (d.totals?.walk_distance_m || 0), 0);
  const started = walked > 0 || visited.length > 0;
  const kid = kidProgress();
  return {
    started, days: days.length,
    km: (started ? walked : planned) / 1000,
    kmLabel: started ? 'км пройдено' : 'км в планах',
    places: started ? visited.length : stops.length,
    placesLabel: started ? 'мест увидели' : 'мест в планах',
    seenTitles: (started ? visited : stops).map(s => s.title),
    seenLabel: started ? 'Что увидели' : 'Что в планах',
    stamps: kid?.stamps || 0, fawn: kid?.outfitImg || 'media/fawn/fawn-base.svg',
    photos: readPhotos().length,
  };
}
const fmtKm = km => (km >= 10 ? Math.round(km) : Math.round(km * 10) / 10).toString().replace('.', ',');

// ---------- Достижения (часть — из детского режима) ----------
function achievements(st) {
  return [
    { id: 'step',   icon: '👣', title: 'Первый шаг',       got: st.started },
    { id: 'km2',    icon: '🧭', title: 'Исследователь',    got: st.started && st.km >= 2 },
    { id: 'stamp1', icon: '⭐', title: 'Первый штамп',     got: st.stamps >= 1 },
    { id: 'stamp3', icon: '🏅', title: 'Знаток города',    got: st.stamps >= 3 },
    { id: 'photo',  icon: '📷', title: 'Фотограф',         got: st.photos >= 1 },
    { id: 'days',   icon: '🗺️', title: 'Путешественник',   got: st.days >= 2 },
  ];
}

// ---------- Отрисовка ----------
export async function renderProfile() {
  const p = currentProfile();
  const email = userEmail();
  $('pf-ava').textContent = (email || 'Г').charAt(0).toUpperCase();
  $('pf-name').textContent = email || 'Гость';
  $('pf-sub').textContent = isAuthenticated() ? 'Аккаунт' : 'Без входа · поездка хранится сутки на этом устройстве';
  $('prof-auth').textContent = isAuthenticated() ? 'Выйти' : 'Войти';

  // Дети: имя, возраст, интересы
  $('pf-kids').innerHTML = '';
  (p?.family.children || []).forEach((c, i) => {
    const name = childName(i);
    const card = document.createElement('div');
    card.className = 'pf-kid';
    card.innerHTML = `
      <span class="pf-kid-ava"></span>
      <div class="pf-kid-main">
        <div class="pf-kid-top"><b></b><span class="pf-age">${esc(ageText(c.age_years))}</span></div>
        <div class="pf-tags">${c.interest_ids.length ? c.interest_ids.map(id => `<span>${esc(interestLabel(id))}</span>`).join('') : '<span class="muted-tag">пока не выбрали</span>'}</div>
      </div>`;
    card.querySelector('b').textContent = name;
    card.querySelector('.pf-kid-ava').textContent = name.replace(/^Ребёнок\s*/, '').charAt(0).toUpperCase() || name.charAt(0).toUpperCase();
    $('pf-kids').append(card);
  });
  const adults = p ? adultInterestLabels(p.family.adult_interest_ids) : [];
  $('pf-adults').textContent = p ? `Взрослых: ${p.family.adult_count}${adults.length ? ' · ' + adults.join(', ') : ''}` : '';

  renderMemory();
  renderTrips();
}

function renderMemory() {
  const st = tripStats();
  $('pf-stats').innerHTML = `
    <div class="pf-stat big"><b>${fmtKm(st.km)}</b><span>${st.kmLabel}</span></div>
    <div class="pf-stat"><b>${st.places}</b><span>${st.placesLabel}</span></div>
    <div class="pf-stat"><b>${st.stamps}</b><span>штампов</span></div>`;
  $('pf-seen').innerHTML = st.seenTitles.length
    ? `<small>${st.seenLabel}</small><div class="pf-chips">${st.seenTitles.slice(0, 4).map(t => `<span>${esc(t)}</span>`).join('')}${st.seenTitles.length > 4 ? `<span>+${st.seenTitles.length - 4}</span>` : ''}</div>` : '';

  // Фото: полароиды + плитка «добавить»
  const photos = readPhotos();
  $('pf-photos').innerHTML = photos.map((src, i) =>
    `<figure class="pf-photo" style="--r:${[-4, 3, -2, 4, -3, 2, -5, 3][i % 8]}deg"><img src="${src}" alt="Фото на память ${i + 1}"><button type="button" data-del="${i}" aria-label="Убрать фото">×</button></figure>`).join('')
    + (photos.length < MAX_PHOTOS ? `<button type="button" class="pf-add" id="pf-add"><span>+</span>Фото</button>` : '');
  $('pf-photos').querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { const l = readPhotos(); l.splice(+b.dataset.del, 1); writePhotos(l); renderMemory(); }; });
  const add = $('pf-add'); if (add) add.onclick = () => $('pf-file').click();

  // Достижения
  $('pf-ach').innerHTML = achievements(st).map(a =>
    `<div class="pf-badge${a.got ? ' got' : ''}" title="${esc(a.title)}"><span aria-hidden="true">${a.icon}</span><small>${esc(a.title)}</small></div>`).join('');
}

async function renderTrips() {
  const list = $('prof-trips');
  try {
    const { items } = await listTrips();
    const current = getTrip()?.trip_id;
    list.innerHTML = items.length ? '' : '<li class="muted">Поездок пока нет</li>';
    items.filter(t => t.status !== 'draft').slice(0, 6).forEach(t => {
      const li = document.createElement('li');
      const date = new Date(t.updated_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      li.innerHTML = `<span><b>Поездка от ${date}</b><small>маршрут сохранён</small></span>`;
      if (t.trip_id === current) li.insertAdjacentHTML('beforeend', '<span class="cur">открыта</span>');
      else {
        const b = document.createElement('button');
        b.className = 'btn alt slim';
        b.textContent = 'Открыть';
        b.onclick = async () => { await openTrip(t.trip_id); hooks.onOpenTrip(); };
        li.append(b);
      }
      list.append(li);
    });
    if (!list.children.length) list.innerHTML = '<li class="muted">Сохранённых поездок пока нет</li>';
  } catch {
    list.innerHTML = '<li class="muted">Список поездок сейчас недоступен</li>';
  }
}

// ---------- Сторис: картинка 1080×1920 ----------
const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
const FALLBACK_OLD = ['media/windows/kremlin-old.jpg', 'media/windows/pokrovka-old.jpg', 'media/windows/minin-old.jpg'];

async function buildStory() {
  await document.fonts.load('800 100px Nunito').catch(() => {});
  const st = tripStats();
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px Nunito, system-ui, sans-serif`;

  // Фон: глубокий синий с цветными «конфетти»
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0F1628'); bg.addColorStop(0.55, '#16306E'); bg.addColorStop(1, '#2463D6');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
  glow(930, 230, 430, 'rgba(232,100,31,.55)'); glow(120, 1380, 520, 'rgba(255,201,74,.30)'); glow(900, 1750, 420, 'rgba(36,99,214,.55)');
  [[120, 330, 14, '#FFC94A'], [980, 560, 10, '#fff'], [60, 820, 9, '#E8641F'], [1010, 940, 14, '#FFC94A'], [170, 1100, 8, '#fff'], [960, 1500, 11, '#E8641F']]
    .forEach(([x, y, r, col]) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); });

  // Верх: метка и заголовок
  g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(72, 90, 560, 76, 38); g.fill();
  g.fillStyle = '#fff'; g.font = font(800, 34); g.fillText('ОКНО В ПРОШЛОЕ · НИЖНИЙ', 106, 140);
  g.fillStyle = '#fff'; g.font = font(800, 104); g.fillText(st.started ? 'Мы прошли' : 'Мы пройдём', 72, 330);

  // Гигантское число с градиентом
  const km = fmtKm(st.km);
  g.font = font(800, 400);
  const numW = g.measureText(km).width;
  const ng = g.createLinearGradient(72, 380, 72 + numW, 700);
  ng.addColorStop(0, '#FFC94A'); ng.addColorStop(1, '#E8641F');
  g.fillStyle = ng; g.fillText(km, 66, 700);
  g.fillStyle = '#fff'; g.font = font(800, 130); g.fillText('км', 90 + numW, 700);
  g.fillStyle = '#C9D2E3'; g.font = font(700, 58); g.fillText(st.started ? 'вместе по Нижнему' : 'ждут нас в Нижнем', 76, 790);

  // Три плашки статистики
  const tiles = [[st.places, st.placesLabel.replace('мест ', '')], [st.stamps, 'штампов'], [st.days, st.days === 1 ? 'день' : 'дня']];
  tiles.forEach(([n, label], i) => {
    const x = 72 + i * 322;
    g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(x, 850, 300, 200, 40); g.fill();
    g.fillStyle = '#fff'; g.font = font(800, 92); g.fillText(String(n), x + 34, 960);
    g.fillStyle = '#C9D2E3'; g.font = font(700, 36); g.fillText(label, x + 34, 1018);
  });

  // Полароиды: свои фото, а если их нет — старые снимки города («тогда»)
  const own = readPhotos().slice(0, 3);
  const polaroids = own.length ? own.map(src => ({ src, tag: null })) : FALLBACK_OLD.map(src => ({ src, tag: 'ТОГДА' }));
  const rot = [-7, 4, -3];
  for (let i = 0; i < polaroids.length; i++) {
    const { src, tag } = polaroids[i];
    const img = await loadImg(src).catch(() => null);
    if (!img) continue;
    const pw = 330, ph = 400, x = 80 + i * 300, y = 1110 + (i % 2) * 34;
    g.save(); g.translate(x + pw / 2, y + ph / 2); g.rotate(rot[i] * Math.PI / 180);
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 36; g.shadowOffsetY = 14;
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(-pw / 2, -ph / 2, pw, ph, 18); g.fill();
    g.shadowColor = 'transparent';
    const iw = pw - 32, ih = ph - 96, sc = Math.max(iw / img.width, ih / img.height);
    g.save(); g.beginPath(); g.roundRect(-iw / 2, -ph / 2 + 16, iw, ih, 10); g.clip();
    g.drawImage(img, (img.width - iw / sc) / 2, (img.height - ih / sc) / 2, iw / sc, ih / sc, -iw / 2, -ph / 2 + 16, iw, ih); g.restore();
    if (tag) { g.fillStyle = '#8A5A2B'; g.beginPath(); g.roundRect(-iw / 2 + 12, ph / 2 - 120, 120, 46, 23); g.fill(); g.fillStyle = '#fff'; g.font = font(800, 28); g.fillText(tag, -iw / 2 + 32, ph / 2 - 88); }
    g.restore();
  }

  // Оленёнок в наряде — наклейка
  const fawn = await loadImg(st.fawn).catch(() => null);
  if (fawn) { g.save(); g.translate(880, 1480); g.rotate(6 * Math.PI / 180); g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 30; g.drawImage(fawn, -150, -165, 300, 330); g.restore(); }

  // Достижения
  const got = achievements(st).filter(a => a.got).slice(0, 5);
  if (got.length) {
    g.fillStyle = '#C9D2E3'; g.font = font(700, 36); g.fillText('Наши достижения', 80, 1700);
    got.forEach((a, i) => {
      const cx = 130 + i * 130, cy = 1775;
      g.fillStyle = '#FFC94A'; g.beginPath(); g.arc(cx, cy, 54, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 44, 0, Math.PI * 2); g.fill();
      g.font = font(400, 50); g.textAlign = 'center'; g.fillStyle = '#000'; g.fillText(a.icon, cx, cy + 18); g.textAlign = 'left';
    });
  }
  g.fillStyle = '#fff'; g.font = font(800, 40); g.textAlign = 'right'; g.fillText('Открой своё окно →', W - 72, 1858); g.textAlign = 'left';
  g.fillStyle = 'rgba(201,210,227,.7)'; g.font = font(600, 24); g.fillText('Старые фото: PastVu', 80, 1895);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
}

async function shareStory() {
  const btn = $('pf-share');
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.textContent = 'Рисуем сторис…';
  try {
    const blob = await buildStory();
    const file = new File([blob], 'okno-v-proshloe-story.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Наша прогулка по Нижнему' }); return; } catch { /* отменили — скачаем */ }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) { alert('Не получилось нарисовать сторис: ' + err.message); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

// hooks: { onEditProfile, onNewTrip, onSignOut, onSignIn, onOpenTrip }
export function initProfile(h) {
  hooks = { ...hooks, ...h };
  $('prof-edit').onclick = () => hooks.onEditProfile();
  $('prof-newtrip').onclick = () => hooks.onNewTrip();
  $('prof-auth').onclick = () => (isAuthenticated() ? hooks.onSignOut() : hooks.onSignIn());
  $('pf-share').onclick = shareStory;
  $('pf-file').onchange = async e => {
    const list = readPhotos();
    for (const f of [...e.target.files].slice(0, MAX_PHOTOS - list.length)) {
      try { list.push(await downscale(f)); } catch { /* пропускаем битый файл */ }
    }
    if (!writePhotos(list)) alert('Не хватило места в браузере — удалите одно из фото');
    e.target.value = '';
    renderMemory();
  };
}
