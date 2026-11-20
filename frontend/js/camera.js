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

// ---------- Камера ----------
const video = $('cam-video');
const ghost = $('cam-ghost');
let stream = null;
let onPhoto = null;
let stopWatch = null;

export async function openCamera(stop, demo, photoCallback) {
  onPhoto = photoCallback;
  ghost.src = stop.photo.url;
  ghost.style.opacity = $('cam-opacity').value / 100;
  $('cam-page').hidden = false;
  $('cam-tip').textContent = 'Совместите старое фото с тем, что видите';
  stopWatch = watchPlace(stop, demo, s => {
    $('cam-tip').textContent = s.ready && !s.text.includes('Повернитесь') ? 'Совместите старое фото с тем, что видите' : s.text;
  });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('cam-tip').textContent = 'Камера работает только по HTTPS — выберите фото из галереи';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    $('cam-tip').textContent = 'Камера недоступна — выберите фото из галереи';
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

// Снимок с той же обрезкой, что видна на экране (object-fit: cover),
// чтобы «сейчас» легло на «тогда» так же, как человек их совместил.
function captureCover(source, srcW, srcH) {
  const view = $('cam-page').getBoundingClientRect();
  const outW = 1080, outH = Math.round(outW * view.height / view.width);
  const scale = Math.max(view.width / srcW, view.height / srcH);
  const sw = view.width / scale, sh = view.height / scale;
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  canvas.getContext('2d').drawImage(source, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, outW, outH);
  return { url: canvas.toDataURL('image/jpeg', 0.9), aspect: view.width / view.height };
}

function finish(photo) { closeCamera(); onPhoto(photo.url, photo.aspect); }

$('cam-opacity').addEventListener('input', e => { ghost.style.opacity = e.target.value / 100; });
$('cam-shot').addEventListener('click', () => {
  if (!stream || !video.videoWidth) { $('cam-tip').textContent = 'Камера ещё не включилась — подождите или выберите фото из галереи'; return; }
  finish(captureCover(video, video.videoWidth, video.videoHeight));
});
// Запасной путь: фото из галереи (если камера недоступна)
$('cam-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { finish(captureCover(img, img.naturalWidth, img.naturalHeight)); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});
