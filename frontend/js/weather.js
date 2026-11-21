// Погода на день прогулки и советы, что надеть и взять с собой.
// Источник — Open-Meteo (бесплатно, без ключа, браузер ходит туда напрямую).
// Наружу уходят только дата прогулки и координаты центра Нижнего Новгорода. Нет связи — блок просто не показывается.

const API = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'temperature_2m,apparent_temperature,precipitation,snowfall,precipitation_probability,weather_code,wind_gusts_10m,uv_index';
const TTL = 30 * 60 * 1000;
// Прогноз всегда для Нижнего Новгорода (центр города), а не для геолокации или точки старта
const NN = { lat: 56.3273, lon: 44.0066 };

// ---------- Запрос ----------
async function fetchHours(lat, lon, date) {
  const key = `weather:${lat.toFixed(2)},${lon.toFixed(2)},${date}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key));
    if (hit && Date.now() - hit.t < TTL) return hit.h;
  } catch { /* кэша нет — не страшно */ }
  const url = `${API}?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}&wind_speed_unit=ms&timezone=Europe%2FMoscow&start_date=${date}&end_date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather ' + res.status);
  const { hourly } = await res.json();
  const hours = hourly.time.map((t, i) => ({
    hour: Number(t.slice(11, 13)),
    temp: hourly.temperature_2m[i], feels: hourly.apparent_temperature[i],
    rain: hourly.precipitation[i], snow: hourly.snowfall[i], prob: hourly.precipitation_probability[i],
    code: hourly.weather_code[i], gust: hourly.wind_gusts_10m[i], uv: hourly.uv_index[i],
  }));
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), h: hours })); } catch { /* ничего */ }
  return hours;
}

// ---------- Что за погода ----------
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
const THUNDER_CODES = [95, 96, 99];
const FOG_CODES = [45, 48];
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
const max = (a, f) => Math.max(...a.map(x => f(x) ?? -Infinity));
const min = (a, f) => Math.min(...a.map(x => f(x) ?? Infinity));

function describe(h) {
  const worst = h.reduce((w, x) => (x.code > w.code ? x : w), h[0]);
  if (h.some(x => THUNDER_CODES.includes(x.code))) return { icon: '⛈️', text: 'гроза' };
  if (h.some(x => SNOW_CODES.includes(x.code) || x.snow > 0)) return { icon: '🌨️', text: 'снег' };
  if (max(h, x => x.rain) >= 2.5) return { icon: '🌧️', text: 'сильный дождь' };
  if (h.some(x => x.code >= 51 && x.code <= 67 || x.code >= 80 && x.code <= 82)) return { icon: '🌦️', text: 'дождь' };
  if (h.some(x => FOG_CODES.includes(x.code))) return { icon: '🌫️', text: 'туман' };
  if (worst.code === 3) return { icon: '☁️', text: 'пасмурно' };
  if (worst.code >= 1) return { icon: '⛅', text: 'облачно' };
  return { icon: '☀️', text: 'ясно' };
}

// Советы по часам прогулки. Каждый — { level: 'warn' | 'info', icon, text }; самые важные первыми.
export function adviceFor(h) {
  const tips = [];
  const feelsMin = min(h, x => x.feels), feelsMax = max(h, x => x.feels);
  const snowing = h.some(x => SNOW_CODES.includes(x.code) || x.snow > 0);
  const heavyRain = max(h, x => x.rain) >= 2.5;
  const rain = heavyRain || h.some(x => x.rain >= 0.3 || (x.prob >= 60 && x.code >= 51));

  if (h.some(x => THUNDER_CODES.includes(x.code)))
    tips.push({ level: 'warn', icon: '⛈️', text: 'Ожидается гроза. Лучше выбрать места под крышей — музеи, кафе — и не стоять под деревьями.' });
  if (heavyRain) tips.push({ level: 'warn', icon: '☂️', text: 'На улице сильный дождь — возьмите зонт и непромокаемые куртки, а ребёнку сменную обувь.' });
  else if (rain && !snowing) tips.push({ level: 'info', icon: '☂️', text: 'Возможен дождь — положите в рюкзак зонт или дождевики.' });

  if (snowing && feelsMin <= -3) tips.push({ level: 'warn', icon: '🧣', text: 'Идёт снег и холодно — наденьте шапку, шарф и варежки, обувь выбирайте непромокаемую.' });
  else if (snowing) tips.push({ level: 'info', icon: '🧢', text: 'Идёт снег — наденьте шапку и непромокаемую обувь.' });

  if (feelsMin <= -15) tips.push({ level: 'warn', icon: '🥶', text: 'Сильный мороз — тёплый комбинезон, термобельё, и почаще греться в кафе. Не оставайтесь на улице дольше 30–40 минут подряд.' });
  else if (feelsMin <= -3 && !snowing) tips.push({ level: 'info', icon: '🧤', text: 'На улице мороз — шапка, шарф, тёплые перчатки.' });
  else if (feelsMin <= 5 && !snowing) tips.push({ level: 'info', icon: '🧥', text: 'Прохладно — тёплая куртка и шапка пригодятся, особенно ребёнку.' });
  else if (feelsMin <= 12 && !rain && !snowing) tips.push({ level: 'info', icon: '🧥', text: 'Свежо — возьмите лёгкую куртку или кофту.' });

  if (feelsMax >= 28) tips.push({ level: 'warn', icon: '🧴', text: 'Жарко — кепка или панама, вода для всех и солнцезащитный крем.' });
  else if (max(h, x => x.uv) >= 6) tips.push({ level: 'info', icon: '🧴', text: 'Яркое солнце — панама и солнцезащитный крем.' });

  if (max(h, x => x.gust) >= 15) tips.push({ level: 'warn', icon: '💨', text: 'Сильный ветер — застегните куртки, зонт может не пригодиться.' });
  if (h.some(x => FOG_CODES.includes(x.code))) tips.push({ level: 'info', icon: '🌫️', text: 'Туман — на переходах держите ребёнка за руку.' });

  return tips.sort((a, b) => (b.level === 'warn') - (a.level === 'warn'));
}

// Вид неба для тематической карты: thunder | snow | heavyrain | rain | fog | cloud | partly | clear
export function skyKind(h) {
  if (h.some(x => THUNDER_CODES.includes(x.code))) return 'thunder';
  if (h.some(x => SNOW_CODES.includes(x.code) || x.snow > 0)) return 'snow';
  if (max(h, x => x.rain) >= 2.5) return 'heavyrain';
  if (h.some(x => x.rain >= 0.3 || x.code >= 51 && x.code <= 67 || x.code >= 80 && x.code <= 82)) return 'rain';
  if (h.some(x => FOG_CODES.includes(x.code))) return 'fog';
  const cloudy = h.filter(x => x.code === 3).length / h.length;
  if (cloudy >= 0.5) return 'cloud';
  if (h.some(x => x.code >= 1)) return 'partly';
  return 'clear';
}

// Прогноз на часы прогулки дня: { h, from, to } или null. Повторные вызовы не ходят в сеть (кэш).
export async function forecastFor(day) {
  if (!day) return null;
  const all = await fetchHours(NN.lat, NN.lon, day.date);
  const times = day.stops.flatMap(s => [s.timing?.estimated_arrival_at, s.timing?.estimated_departure_at]).filter(Boolean)
    .map(t => Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Moscow' })));
  const from = times.length ? Math.min(...times) : 9, to = times.length ? Math.max(...times) : 20;
  const hours = all.filter(x => x.hour >= from && x.hour <= to);
  const h = hours.length ? hours : all.filter(x => x.hour >= 9 && x.hour <= 20);
  return h.length ? { h, from, to } : null;
}

// ---------- Линейные иконки погоды (в стиле остального интерфейса, вместо эмодзи) ----------
const CLOUD = 'M7 16h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 7.2 4.5 4.5 0 0 0 7 16z';
const ICONS = {
  clear: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  partly: '<circle cx="8" cy="8" r="2.6"/><path d="M8 2.5v1.3M2.5 8h1.3M4.1 4.1l.9.9M11.9 4.1l-.9.9"/><path d="M8.5 20h8.5a3.6 3.6 0 0 0 .5-7.1A5.2 5.2 0 0 0 8 13.2 3.4 3.4 0 0 0 8.5 20z"/>',
  cloud: `<path d="${CLOUD}" transform="translate(0 2)"/>`,
  rain: `<path d="${CLOUD}"/><path d="M8 19l-1 2.5M12 19l-1 2.5M16 19l-1 2.5"/>`,
  snow: `<path d="${CLOUD}"/><path d="M8 20h.01M12 21.5h.01M16 20h.01" stroke-width="3"/>`,
  fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
  thunder: `<path d="${CLOUD}"/><path d="M12.8 14.5l-2.8 4h3l-1.4 3.5"/>`,
};
const iconSvg = kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind === 'heavyrain' ? 'rain' : kind] || ICONS.cloud}</svg>`;

// ---------- Показ ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const sign = n => { const r = Math.round(n); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r); };   // «−0°» не показываем
let shown = '';
// Нажатие в любом другом месте закрывает подробности погоды
document.addEventListener('click', e => { document.querySelectorAll('.wx-pop').forEach(p => { if (!p.hidden && !p.parentElement.contains(e.target)) { p.hidden = true; p.parentElement.querySelector('.wx-btn')?.setAttribute('aria-expanded', 'false'); } }); });

// day — день плана (date, start_point, stops). Рисует блок в элементе el.
export async function renderWeather(el, day) {
  if (!el || !day) return;
  const key = day.date;
  if (shown === key) return;
  shown = key;
  try {
    const fc = await forecastFor(day);
    if (!fc) { el.hidden = true; return; }
    const { h, from, to } = fc;
    const sky = describe(h);
    const lo = min(h, x => x.temp), hi = max(h, x => x.temp);
    const tips = adviceFor(h);
    const warn = tips.some(t => t.level === 'warn');
    const kind = skyKind(h);
    const future = day.date > new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });   // прогноз на будущий день — «Ожидается»
    el.className = 'wx' + (warn ? ' warn' : '');
    // Компактная плашка «☁️ +3…+5°»; по нажатию — подробности и советы
    el.innerHTML = `
      <button type="button" class="wx-btn" aria-expanded="false" aria-label="Погода на прогулку: ${sign(lo)}${hi - lo >= 1.5 ? ' … ' + sign(hi) : ''} градусов, ${esc(sky.text)}. Подробнее">
        <span class="wx-ico">${iconSvg(kind)}</span><b>${sign(lo)}${hi - lo >= 1.5 ? '…' + sign(hi) : ''}°</b>${warn ? '<i class="wx-dot" aria-hidden="true"></i>' : ''}
      </button>
      <div class="wx-pop" hidden>
        <div class="wx-sum"><span class="wx-ico big">${iconSvg(kind)}</span><b>${future ? 'Ожидается: ' + esc(sky.text) : esc(cap(sky.text))}, ${sign(lo)}${hi - lo >= 1.5 ? '…' + sign(hi) : ''}°C</b></div>
        ${tips.length ? `<ul class="wx-tips">${tips.map(t => `<li class="${t.level}"><span aria-hidden="true">${t.icon}</span>${esc(t.text)}</li>`).join('')}</ul>`
          : '<p class="wx-ok">Хорошая погода для прогулки, специальная одежда не нужна.</p>'}
      </div>`;
    const btn = el.querySelector('.wx-btn'), pop = el.querySelector('.wx-pop');
    btn.onclick = e => { e.stopPropagation(); const open = pop.hidden; pop.hidden = !open; btn.setAttribute('aria-expanded', open); };
    el.hidden = false;
  } catch (err) {
    console.warn('Погода недоступна:', err);
    shown = '';          // попробуем ещё раз при следующей отрисовке
    el.hidden = true;
  }
}
