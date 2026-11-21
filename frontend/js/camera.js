// Взгляд в прошлое: проверка «вы на месте фотографа» (GPS + компас) и камера.
// Камера и компас в браузере работают только по HTTPS или на localhost.
// Фото пользователя никуда не отправляется — остаётся в памяти телефона.

const PLACE_RADIUS_M = 40;    // ближе — считаем, что человек на месте фотографа
const HEADING_TOLERANCE = 35; // градусов: направление съёмки в PastVu грубое (8 сторон света)

const $ = id => document.getElementById(id);

// ---------- Геометрия: точки [долгота, широта] ----------
const toRad = d => d * Math.PI / 180;
function distanceM(a, b) {
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const angleDiff = (from, to) => ((to - from + 540) % 360) - 180;   // −180…180, плюс = правее
const side = d => Math.abs(d) <= 30 ? 'прямо впереди' : Math.abs(d) >= 150 ? 'позади' : d > 0 ? 'справа' : 'слева';

// ---------- Датчики: GPS и компас ----------
let position = null, heading = null, geoWatch = null, listeners = [];

function notify() { listeners.forEach(fn => fn()); }

function onOrientation(e) {
  if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;   // iPhone
  else if (e.absolute && e.alpha !== null) heading = (360 - e.alpha) % 360;            // Android
  else return;
  notify();
}

// Компас: на iPhone разрешение спрашивается только по нажатию кнопки
export async function enableCompass() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } catch { return; }
    addEventListener('deviceorientation', onOrientation);
  } else {
    addEventListener('deviceorientationabsolute', onOrientation);
  }
}

// Следить, на месте ли человек. onChange получает { ready, distance, text }.
// Возвращает функцию «перестать следить».
export function watchPlace(stop, demo, onChange) {
  const check = () => {
    if (demo) return onChange({ ready: true, text: 'Демо-режим: считаем, что вы на месте' });
    if (!position) return onChange({ ready: false, text: 'Ищем вас по GPS…' });
    const dist = distanceM(position, stop.point);
    if (dist > PLACE_RADIUS_M) {
      const where = heading === null ? '' : ', точка ' + side(angleDiff(heading, bearing(position, stop.point)));
      return onChange({ ready: false, distance: dist, text: `До места фотографа ${Math.round(dist)} м${where}` });
    }
    if (heading !== null && Math.abs(angleDiff(heading, stop.headingDeg)) > HEADING_TOLERANCE) {
      const right = angleDiff(heading, stop.headingDeg) > 0;
      return onChange({ ready: true, distance: dist, text: right ? 'Вы на месте! Повернитесь правее' : 'Вы на месте! Повернитесь левее' });
    }
    onChange({ ready: true, distance: dist, text: 'Вы на месте фотографа!' });
  };
  listeners.push(check);
  if (!demo && navigator.geolocation && geoWatch === null) {
    geoWatch = navigator.geolocation.watchPosition(
      p => { position = [p.coords.longitude, p.coords.latitude]; notify(); },
      () => onChange({ ready: false, text: 'Нет доступа к GPS — включите геолокацию' }),
      { enableHighAccuracy: true, maximumAge: 2000 });
  }
  check();
  return () => {
    listeners = listeners.filter(fn => fn !== check);
    if (!listeners.length) {
      if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
      geoWatch = null;
      position = null;
    }
  };
}

// ---------- Старый кадр: чистим и строим контур ----------
// У снимков PastVu внизу тёмная полоса с водяным знаком — срезаем её (подпись автора показываем отдельно).
const TRIM_BOTTOM = 0.045;
const assets = new Map();
const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });

// { url, edges, aspect } — чистый кадр, его контур (светлые линии на прозрачном) и пропорции
export function prepareOld(stop) {
  if (!assets.has(stop.id)) assets.set(stop.id, (async () => {
    const img = await loadImg(stop.photo.url);
    const w = img.naturalWidth, h = Math.round(img.naturalHeight * (1 - TRIM_BOTTOM));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h, 0, 0, w, h);
    return { url: c.toDataURL('image/jpeg', 0.92), edges: edgesOf(c), aspect: w / h };
  })());
  return assets.get(stop.id);
}

// Контур Собелем: оставляем ~13% самых резких границ — дома, купола, линия площади
function edgesOf(src) {
  const W = 560, H = Math.round(W * src.height / src.width);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.filter = 'blur(1px)'; g.drawImage(src, 0, 0, W, H); g.filter = 'none';
  const px = g.getImageData(0, 0, W, H), d = px.data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11;
  const mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, q = k => gray[i + k];
    const gx = -q(-W - 1) - 2 * q(-1) - q(W - 1) + q(-W + 1) + 2 * q(1) + q(W + 1);
    const gy = -q(-W - 1) - 2 * q(-W) - q(-W + 1) + q(W - 1) + 2 * q(W) + q(W + 1);
    mag[i] = Math.hypot(gx, gy);
  }
  const sorted = Float32Array.from(mag).sort();
  const lo = sorted[Math.floor(sorted.length * .84)], hi = sorted[Math.floor(sorted.length * .95)] || lo + 1;
  // Утолщаем линии (берём максимум по соседям) — контур читается и на ярком небе, и на тёмных домах
  const thick = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    thick[i] = Math.max(mag[i], mag[i - 1], mag[i + 1], mag[i - W], mag[i + W]);
  }
  for (let i = 0; i < W * H; i++) {
    const a = Math.max(0, Math.min(1, (thick[i] - lo) / (hi - lo)));
    d[i * 4] = 255; d[i * 4 + 1] = 246; d[i * 4 + 2] = 214; d[i * 4 + 3] = Math.round(a * 255);
  }
  g.putImageData(px, 0, 0);
  return c.toDataURL('image/png');
}

// ---------- Камера ----------
const video = $('cam-video');
const ghost = $('cam-ghost');
const win = $('cam-window');
let stream = null, onPhoto = null, stopWatch = null, asset = null, mode = 'edges';

// Окно — по центру между верхней подсказкой и панелью; на повёрнутом телефоне становится шире
function layoutWindow() {
  if (!asset || $('cam-page').hidden) return;
  const page = $('cam-page').getBoundingClientRect();
  const top = 76, bottom = $('cam-page').querySelector('.cam-panel').offsetHeight + 16;
  const availW = page.width - 28, availH = page.height - top - bottom;
  const w = Math.min(availW, availH * asset.aspect), h = w / asset.aspect;
  Object.assign(win.style, { width: w + 'px', height: h + 'px', left: (page.width - w) / 2 + 'px', top: top + (availH - h) / 2 + 'px' });
}
addEventListener('resize', layoutWindow);

function setMode(m) {
  mode = m;
  ghost.src = m === 'edges' ? asset.edges : asset.url;
  $('cam-page').querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  ghost.classList.toggle('edges', m === 'edges');
  ghost.style.opacity = m === 'edges' ? 1 : 0.55;
}

export async function openCamera(stop, demo, photoCallback) {
  onPhoto = photoCallback;
  asset = await prepareOld(stop);
  $('cam-page').hidden = false;
  setMode('edges');
  layoutWindow();
  $('cam-tip').textContent = 'Совместите контур с тем, что видите';
  stopWatch = watchPlace(stop, demo, s => {
    $('cam-tip').textContent = s.ready && !s.text.includes('Повернитесь') ? 'Совместите контур с тем, что видите' : s.text;
  });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('cam-tip').textContent = 'Камера работает только по HTTPS';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch {
    $('cam-tip').textContent = 'Камера недоступна — разрешите доступ к камере в настройках';
  }
}

export function closeCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  if (stopWatch) stopWatch();
  stopWatch = null;
  $('cam-page').hidden = true;
}

// Снимаем ровно то, что видно в окне: те же пропорции, что у старого кадра —
// поэтому «тогда» и «сейчас» потом лягут друг на друга без обрезки.
function captureWindow() {
  const vr = video.getBoundingClientRect(), wr = win.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const x0 = vr.left + (vr.width - vw * scale) / 2, y0 = vr.top + (vr.height - vh * scale) / 2;
  return cropTo(video, (wr.left - x0) / scale, (wr.top - y0) / scale, wr.width / scale, wr.height / scale);
}
function cropTo(source, sx, sy, sw, sh) {
  const outW = 1600, outH = Math.round(outW / asset.aspect);
  const c = document.createElement('canvas'); c.width = outW; c.height = outH;
  c.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);
  return c.toDataURL('image/jpeg', 0.9);
}

function finish(url) {
  const f = $('cam-flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  setTimeout(() => { closeCamera(); onPhoto(url, asset); }, 260);
}

$('cam-page').querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
$('cam-shot').addEventListener('click', () => {
  if (!stream || !video.videoWidth) { $('cam-tip').textContent = 'Камера ещё не включилась — подождите секунду'; return; }
  finish(captureWindow());
});
