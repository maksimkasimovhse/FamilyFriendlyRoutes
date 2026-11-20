// Задания «Тропы Маши»: игры с картинкой объекта. Текстовых заданий нет.
//   jigsaw — пазл: кусочки фото лежат внизу, ребёнок переносит их на своё место;
//   pixel  — тот же пазл, но из пиксельной версии фото;
//   paint  — раскраска по номерам: чёрно-белый контур с цифрами, внизу палитра;
//   quiz   — вопросы на знания и логику с вариантами ответа (единственное текстовое задание, у памятника Чкалову).
// Когда пиксель-пазл собран или раскраска закрашена, картинка превращается в настоящее фото.
// spec: { type, dir, image }. image — фото места (карточная картинка); из неё в браузере режется пазл и берётся
// фото для «оживающей» раскраски. В dir лежат готовые pixel.png (пиксель-пазл) или paint.png + paint.json
// (раскраска); их для всех мест готовит scripts/build-kid-games.py.
//
// startGame(root, spec, ageGroup, { onProgress(done, total), onSolved() }) -> Promise<{ destroy() }>

export const GAME_LABELS = { jigsaw: 'Пазл', pixel: 'Пиксель-пазл', paint: 'Раскраска', quiz: 'Вопросы' };
export const GAME_HINTS = {
  jigsaw: 'Собери картинку: перетащи кусочек на своё место!',
  pixel: 'Собери пиксельную картинку: перетащи кусочек на своё место!',
  paint: 'Выбери цвет внизу и закрась все места с таким номером!',
  quiz: 'Ответь на вопросы: выбери верный ответ!',
};

// Сколько кусочков в пазле: чем старше ребёнок, тем больше. [столбцов, строк]; размеры делят сетку 48×36 пикселей
const GRIDS = { '3-5': [2, 2], '6-8': [3, 3], '9-11': [4, 3] };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const shuffled = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const loadImage = src => new Promise((ok, fail) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => fail(new Error('Не загрузилась картинка: ' + src));
  img.src = src;
});

// Фото места в кадре 4:3 (как при подготовке картинок: по центру, чуть выше середины)
const crops = new Map();
function crop43(url) {
  if (!crops.has(url)) {
    crops.set(url, loadImage(url).then(img => {
      const W = 960, H = 720;
      const scale = Math.max(W / img.width, H / img.height);
      const sw = W / scale, sh = H / scale;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, (img.width - sw) * 0.5, (img.height - sh) * 0.45, sw, sh, 0, 0, W, H);
      return c.toDataURL('image/jpeg', 0.9);
    }));
  }
  return crops.get(url);
}

export function startGame(root, spec, ageGroup, handlers) {
  root.replaceChildren();
  const run = { paint: startPaint, quiz: startQuiz }[spec.type] || startPuzzle;
  return run(root, spec, ageGroup, handlers);
}

// ===================== Пазл (обычный и пиксельный) =====================
async function startPuzzle(root, spec, ageGroup, { onProgress, onSolved }) {
  const [cols, rows] = GRIDS[ageGroup] || GRIDS['6-8'];
  const total = cols * rows;
  const pixelated = spec.type === 'pixel';
  const url = pixelated ? `${spec.dir}/pixel.png` : await crop43(spec.image);
  const pieceRatio = (4 / 3) * (rows / cols);       // ширина / высота кусочка

  const wrap = el('div', 'pz' + (pixelated ? ' pixelated' : ''));
  const board = el('div', 'pz-board');
  board.style.setProperty('--cols', cols);
  board.style.setProperty('--rows', rows);
  const photoReady = pixelated ? crop43(spec.image) : null;      // чёткое фото готовим заранее
  const reveal = el('img', 'pz-reveal');
  reveal.alt = '';
  const ghost = el('div', 'pz-ghost');
  ghost.style.backgroundImage = `url("${url}")`;
  if (pixelated) ghost.classList.add('px');
  board.append(ghost);
  const slots = [];
  for (let i = 0; i < total; i++) {
    const slot = el('div', 'pz-slot');
    slot.dataset.i = i;
    slots.push(slot);
    board.append(slot);
  }
  if (pixelated) {
    board.append(reveal);
    photoReady.then(u => { reveal.src = u; }).catch(() => {});
  }
  const tray = el('div', 'pz-tray');
  wrap.append(board, tray);
  root.append(wrap);

  // Кусочек — тот же кадр, сдвинутый background-position
  const paint = (node, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    node.style.backgroundImage = `url("${url}")`;
    node.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
    node.style.backgroundPosition = `${cols > 1 ? c / (cols - 1) * 100 : 0}% ${rows > 1 ? r / (rows - 1) * 100 : 0}%`;
  };
  const pieces = shuffled([...Array(total).keys()]).map(i => {
    const p = el('div', 'pz-piece');
    p.dataset.i = i;
    p.style.aspectRatio = String(pieceRatio);
    if (pixelated) p.classList.add('px');
    paint(p, i);
    tray.append(p);
    return p;
  });

  let placed = 0;
  let selected = null;
  let alive = true;

  function select(piece) {
    selected?.classList.remove('sel');
    selected = piece;
    selected?.classList.add('sel');
  }

  function tryPlace(piece, slot) {
    if (!slot || slot.classList.contains('filled')) return false;
    if (slot.dataset.i !== piece.dataset.i) {            // не то место: кусочек возвращается
      slot.classList.add('wrong');
      piece.classList.add('shake');
      setTimeout(() => { slot.classList.remove('wrong'); piece.classList.remove('shake'); }, 450);
      return false;
    }
    paint(slot, Number(slot.dataset.i));
    slot.classList.add('filled');
    if (pixelated) slot.classList.add('px');
    piece.remove();
    if (selected === piece) selected = null;
    placed++;
    onProgress?.(placed, total);
    if (placed === total) {
      board.classList.add('solved');
      if (pixelated) {                                   // пиксели «проявляются» в настоящее фото
        board.classList.add('revealing');
        setTimeout(() => { if (alive) onSolved?.(); }, 1100);
      } else {
        onSolved?.();
      }
    }
    return true;
  }

  // ----- перетаскивание: кусочек «поднимается» и едет за пальцем -----
  tray.addEventListener('pointerdown', e => {
    const piece = e.target.closest('.pz-piece');
    if (!piece || e.button > 0) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const slotRect = slots[0].getBoundingClientRect();
    const flying = piece.cloneNode();
    flying.classList.add('flying');
    flying.style.width = slotRect.width + 'px';
    flying.style.height = slotRect.height + 'px';
    let dragging = false;
    const move = ev => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        dragging = true;
        document.body.append(flying);
        piece.classList.add('lifted');
      }
      if (dragging) flying.style.transform = `translate(${ev.clientX - slotRect.width / 2}px, ${ev.clientY - slotRect.height / 2 - 28}px)`;
    };
    const end = ev => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      flying.remove();
      piece.classList.remove('lifted');
      if (!alive) return;
      if (!dragging) { select(selected === piece ? null : piece); return; }   // просто нажатие: выбрать кусочек
      const under = document.elementFromPoint(ev.clientX, ev.clientY - 28) || document.elementFromPoint(ev.clientX, ev.clientY);
      tryPlace(piece, under && under.closest('.pz-slot'));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  });

  // Нажатие по пустому месту, когда кусочек выбран
  board.addEventListener('click', e => {
    const slot = e.target.closest('.pz-slot');
    if (slot && selected) tryPlace(selected, slot);
  });

  onProgress?.(0, total);
  return { destroy() { alive = false; root.replaceChildren(); } };
}

// ===================== Вопросы на знания и логику =====================
// spec.questions: [{ q, options: [...], answer: индекс верного, explain }]. Порядок вариантов каждый раз случайный.
function startQuiz(root, spec, ageGroup, { onProgress, onSolved }) {
  const questions = spec.questions || [];
  const total = questions.length;
  const wrap = el('div', 'qz');
  root.append(wrap);
  let i = 0;
  let alive = true;

  function show() {
    wrap.replaceChildren();
    const q = questions[i];
    const last = i === total - 1;
    const card = el('div', 'qz-card');
    const list = el('div', 'qz-options');
    const note = el('p', 'qz-note');
    const next = el('button', 'btn kid-main qz-next', 'Дальше');
    next.hidden = true;
    shuffled(q.options.map((text, idx) => ({ text, ok: idx === q.answer }))).forEach(o => {
      const b = el('button', 'qz-opt', o.text);
      b.addEventListener('click', () => {
        if (!alive || b.disabled) return;
        if (!o.ok) {                                  // неверно: вариант гаснет, можно думать дальше
          b.classList.add('wrong');
          b.disabled = true;
          note.textContent = 'Не совсем. Подумай ещё!';
          note.className = 'qz-note bad';
          return;
        }
        list.querySelectorAll('button').forEach(x => { x.disabled = true; });
        b.classList.add('right');
        note.textContent = q.explain || 'Верно!';
        note.className = 'qz-note good';
        onProgress?.(i + 1, total);
        if (last) onSolved?.(); else next.hidden = false;
      });
      list.append(b);
    });
    next.addEventListener('click', () => { i++; show(); });
    card.append(el('p', 'qz-step', `Вопрос ${i + 1} из ${total}`), el('h3', 'qz-q', q.q), list, note, next);
    wrap.append(card);
  }

  show();
  onProgress?.(0, total);
  return { destroy() { alive = false; root.replaceChildren(); } };
}

// ===================== Раскраска по номерам =====================
async function startPaint(root, spec, ageGroup, { onProgress, onSolved }) {
  const status = el('p', 'pn-loading', 'Готовим раскраску…');
  root.append(status);
  let alive = true;
  const handle = { destroy() { alive = false; root.replaceChildren(); } };

  let meta, labelImg, photo;
  try {
    [meta, labelImg, photo] = await Promise.all([
      fetch(`${spec.dir}/paint.json`).then(r => { if (!r.ok) throw new Error('paint.json: HTTP ' + r.status); return r.json(); }),
      loadImage(`${spec.dir}/paint.png`),
      crop43(spec.image).then(loadImage),
    ]);
  } catch (err) {
    status.textContent = 'Не получилось загрузить раскраску: ' + err.message;
    return handle;
  }
  if (!alive) return handle;
  status.remove();

  const W = meta.w, H = meta.h, S = 2;                      // карта областей W×H, на экране рисуем в 2 раза крупнее
  const CW = W * S, CH = H * S;

  // Карта областей: номер области лежит в R (младший байт) и G
  const probe = document.createElement('canvas');
  probe.width = W; probe.height = H;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(labelImg, 0, 0);
  const rgba = pctx.getImageData(0, 0, W, H).data;
  const labels = new Uint16Array(W * H);
  const members = new Map();                                // id области -> индексы её пикселей
  for (let i = 0; i < W * H; i++) {
    const id = rgba[i * 4] | (rgba[i * 4 + 1] << 8);
    labels[i] = id;
    if (!members.has(id)) members.set(id, []);
    members.get(id).push(i);
  }
  const regionById = new Map(meta.regions.map(r => [r.id, r]));

  // Контуры: пиксель — граница, если сосед справа или снизу из другой области
  const border = new Uint8Array(CW * CH);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = labels[y * W + x];
    if ((x < W - 1 && labels[y * W + x + 1] !== id) || (y < H - 1 && labels[(y + 1) * W + x] !== id)) {
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        const px = x * S + dx, py = y * S + dy;
        if (px < CW && py < CH) border[py * CW + px] = 1;
      }
    }
  }

  // ----- разметка -----
  const wrap = el('div', 'pn');
  const stage = el('div', 'pn-stage');
  const canvas = el('canvas', 'pn-canvas');
  canvas.width = CW; canvas.height = CH;
  const overlay = el('canvas', 'pn-numbers');
  overlay.width = CW; overlay.height = CH;
  const reveal = el('img', 'pn-reveal');
  reveal.src = photo.src;
  reveal.alt = '';
  stage.append(canvas, overlay, reveal);
  const palette = el('div', 'pn-palette');
  wrap.append(stage, palette);
  root.append(wrap);

  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(CW, CH);
  const px32 = new Uint32Array(image.data.buffer);
  const BLACK = 0xFF000000, WHITE = 0xFFFFFFFF;
  for (let i = 0; i < px32.length; i++) px32[i] = border[i] ? BLACK : WHITE;
  ctx.putImageData(image, 0, 0);

  const colorOf = Object.fromEntries(Object.entries(meta.palette).map(([n, hex]) => [n, hex]));
  const abgr = hex => 0xFF000000 | (parseInt(hex.slice(5, 7), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(1, 3), 16);
  const left = {};                                          // сколько областей каждого цвета ещё не закрашено
  meta.regions.forEach(r => { left[r.c] = (left[r.c] || 0) + 1; });
  const filled = new Set();
  const total = meta.regions.length;
  let current = null;

  // ----- палитра -----
  const buttons = {};
  Object.keys(colorOf).map(Number).sort((a, b) => a - b).forEach(n => {
    const b = el('button', 'pn-color');
    b.style.setProperty('--c', colorOf[n]);
    b.dataset.n = n;
    b.setAttribute('aria-label', `Цвет ${n}`);
    b.append(el('span', 'num', n), el('i', 'left', left[n] || 0));
    b.addEventListener('click', () => choose(n));
    palette.append(b);
    buttons[n] = b;
  });
  function choose(n) {
    current = n;
    Object.entries(buttons).forEach(([k, b]) => b.classList.toggle('sel', Number(k) === n));
  }
  const firstLeft = () => Object.keys(left).map(Number).sort((a, b) => a - b).find(n => left[n] > 0);
  choose(firstLeft());

  // ----- цифры на незакрашенных областях -----
  function drawNumbers() {
    const g = overlay.getContext('2d');
    g.clearRect(0, 0, CW, CH);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#111';
    for (const r of meta.regions) {
      if (filled.has(r.id)) continue;
      const size = Math.max(15, Math.min(46, r.r * S * 0.95));
      g.font = `800 ${size}px Nunito, sans-serif`;
      g.fillText(String(r.c), r.cx * S + S / 2, r.cy * S + S / 2 + size * 0.05);
    }
  }
  drawNumbers();

  function fillRegion(id) {
    const color = abgr(colorOf[regionById.get(id).c]);
    for (const i of members.get(id)) {
      const x = (i % W) * S, y = Math.floor(i / W) * S;
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
        const k = (y + dy) * CW + x + dx;
        if (!border[k]) px32[k] = color;
      }
    }
    // жирный контур вокруг закрашенного не трогаем: он остаётся чёрным
    ctx.putImageData(image, 0, 0);
  }

  function updatePalette(n) {
    const b = buttons[n];
    b.querySelector('.left').textContent = left[n];
    if (left[n] === 0) {
      b.classList.add('done');
      b.querySelector('.left').textContent = '✓';
      if (current === n) { const next = firstLeft(); if (next) choose(next); }
    }
  }

  function hit(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * W);
    const y = Math.floor((e.clientY - rect.top) / rect.height * H);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    return labels[y * W + x];
  }

  function paintAt(e, firstTouch) {
    const id = hit(e);
    if (!id || filled.has(id)) return;
    const region = regionById.get(id);
    if (region.c !== current) {
      if (!firstTouch) return;                              // при протягивании пальцем чужие области молча пропускаем
      stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
      buttons[region.c].classList.remove('hint'); void buttons[region.c].offsetWidth; buttons[region.c].classList.add('hint');
      return;
    }
    filled.add(id);
    left[region.c]--;
    fillRegion(id);
    drawNumbers();
    updatePalette(region.c);
    onProgress?.(filled.size, total);
    if (filled.size === total) finish();
  }

  let down = false;
  stage.addEventListener('pointerdown', e => {
    if (stage.classList.contains('solved')) return;
    down = true;
    stage.setPointerCapture?.(e.pointerId);
    paintAt(e, true);
  });
  stage.addEventListener('pointermove', e => { if (down) paintAt(e, false); });
  const up = () => { down = false; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  // Всё закрашено: раскраска «оживает» и превращается в настоящее фото
  function finish() {
    stage.classList.add('solved');
    setTimeout(() => { if (alive) onSolved?.(); }, 900);
  }

  onProgress?.(0, total);
  return handle;
}
