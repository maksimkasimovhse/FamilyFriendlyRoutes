// Погода на день прогулки и советы, что надеть и взять с собой.
// Источник — Open-Meteo (бесплатно, без ключа, браузер ходит туда напрямую).
// Наружу уходят только координаты старта и дата прогулки. Нет связи — блок просто не показывается.

const API = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'temperature_2m,apparent_temperature,precipitation,snowfall,precipitation_probability,weather_code,wind_gusts_10m,uv_index';
const TTL = 30 * 60 * 1000;

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
  if (!day?.start_point?.coordinates) return null;
  const [lon, lat] = day.start_point.coordinates;
  const all = await fetchHours(lat, lon, day.date);
  const times = day.stops.flatMap(s => [s.timing?.estimated_arrival_at, s.timing?.estimated_departure_at]).filter(Boolean)
    .map(t => Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Moscow' })));
  const from = times.length ? Math.min(...times) : 9, to = times.length ? Math.max(...times) : 20;
  const hours = all.filter(x => x.hour >= from && x.hour <= to);
  const h = hours.length ? hours : all.filter(x => x.hour >= 9 && x.hour <= 20);
  return h.length ? { h, from, to } : null;
}

// ---------- Показ ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n));
let shown = '';

// day — день плана (date, start_point, stops). Рисует блок в элементе el.
export async function renderWeather(el, day) {
  if (!el || !day?.start_point?.coordinates) return;
  const key = `${day.date}|${day.start_point.coordinates}`;
  if (shown === key) return;
  shown = key;
  try {
    const fc = await forecastFor(day);
    if (!fc) { el.hidden = true; return; }
    const { h, from, to } = fc;
    const sky = describe(h);
    const lo = min(h, x => x.temp), hi = max(h, x => x.temp);
    const tips = adviceFor(h);
    el.className = 'weather' + (tips.some(t => t.level === 'warn') ? ' warn' : '');
    el.innerHTML = `
      <div class="weather-head"><span class="weather-ico" aria-hidden="true">${sky.icon}</span>
        <div><b>${sign(lo)}${hi - lo >= 1.5 ? '…' + sign(hi) : ''}°C, ${esc(sky.text)}</b>
        <small>погода на время прогулки, ${from}:00–${to}:00</small></div></div>
      ${tips.length ? `<ul class="weather-tips">${tips.map(t => `<li class="${t.level}"><span aria-hidden="true">${t.icon}</span>${esc(t.text)}</li>`).join('')}</ul>`
        : '<p class="weather-ok">Хорошая погода для прогулки, специальная одежда не нужна.</p>'}`;
    el.hidden = false;
  } catch (err) {
    console.warn('Погода недоступна:', err);
    shown = '';          // попробуем ещё раз при следующей отрисовке
    el.hidden = true;
  }
}
