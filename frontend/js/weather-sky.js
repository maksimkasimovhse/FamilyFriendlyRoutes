// Тематическая карта: над картой — небо по погоде дня (тучки и капли, снег, солнечный лучик, туман).
// Слой лёгкий: градиент-«дымка» сверху + canvas с частицами; кликов не перехватывает.
// Анимация идёт только пока экран «Карта» виден; при «меньше движения» рисуется один кадр.

import { onTripChange, today } from './api.js';
import { forecastFor, skyKind } from './weather.js';

const TINT = {   // цвет дымки сверху, плавно уходит в прозрачность
  clear: 'rgba(120,190,255,.55)', partly: 'rgba(140,200,255,.45)', cloud: 'rgba(150,160,175,.55)',
  rain: 'rgba(95,115,140,.55)', heavyrain: 'rgba(70,88,115,.65)', thunder: 'rgba(55,60,90,.7)',
  snow: 'rgba(205,220,238,.7)', fog: 'rgba(200,205,210,.75)',
};
const CLOUDS = { clear: 0, partly: 3, cloud: 6, rain: 6, heavyrain: 7, thunder: 7, snow: 5, fog: 4 };
const DROPS = { rain: 70, heavyrain: 160, thunder: 180 };
const FLAKES = { snow: 90 };
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

let root, cv, ctx, W = 0, H = 0, kind = null, parts = [], clouds = [], raf = 0, flash = 0, t0 = 0;
const rnd = (a, b) => a + Math.random() * (b - a);

function fit() {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function build() {
  const heavy = kind === 'heavyrain' || kind === 'thunder';
  clouds = Array.from({ length: CLOUDS[kind] || 0 }, (_, i) => ({
    x: rnd(-.1, 1) * W, y: rnd(.02, .22) * H + (i % 2) * 14, s: rnd(.8, 1.5), v: rnd(4, 12) * (heavy ? 1.6 : 1),
    a: kind === 'partly' ? .85 : heavy ? .95 : .9, dark: ['rain', 'heavyrain', 'thunder'].includes(kind) ? (heavy ? .55 : .35) : kind === 'cloud' ? .15 : 0,
  }));
  parts = [];
  for (let i = 0; i < (DROPS[kind] || 0); i++) parts.push({ x: rnd(0, W), y: rnd(0, H), l: rnd(8, 16), v: rnd(420, 620) * (heavy ? 1.3 : 1) });
  for (let i = 0; i < (FLAKES[kind] || 0); i++) parts.push({ x: rnd(0, W), y: rnd(0, H), r: rnd(1.5, 3.8), v: rnd(30, 70), ph: rnd(0, 6.3), sw: rnd(10, 28) });
}

function cloud(c) {
  const g = Math.round(255 - c.dark * 140);
  ctx.fillStyle = `rgba(${g},${g},${Math.min(255, g + 8)},${c.a})`;
  const w = 90 * c.s, h = 26 * c.s;
  for (const [dx, dy, rx, ry] of [[0, 0, .5, .5], [-.28, .1, .3, .4], [.3, .12, .32, .38], [.05, -.28, .28, .42]]) {
    ctx.beginPath(); ctx.ellipse(c.x + w * dx, c.y + h * dy, w * rx, h * ry, 0, 0, 7); ctx.fill();
  }
}

function sun(t) {
  const x = W - 56, y = 52, rays = 12, pulse = 1 + Math.sin(t * 1.4) * .05;
  const glow = ctx.createRadialGradient(x, y, 4, x, y, 90);
  glow.addColorStop(0, 'rgba(255,236,150,.85)'); glow.addColorStop(1, 'rgba(255,236,150,0)');
  ctx.fillStyle = glow; ctx.fillRect(x - 90, y - 90, 180, 180);
  ctx.save(); ctx.translate(x, y); ctx.rotate(t * .15);
  ctx.strokeStyle = 'rgba(255,214,90,.9)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  for (let i = 0; i < rays; i++) {
    ctx.rotate(Math.PI * 2 / rays); ctx.beginPath(); ctx.moveTo(0, 26 * pulse); ctx.lineTo(0, 38 * pulse); ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#FFD84D'; ctx.beginPath(); ctx.arc(x, y, 20, 0, 7); ctx.fill();
}

function frame(now) {
  const t = now / 1000, dt = Math.min(.05, t - t0 || .016); t0 = t;
  ctx.clearRect(0, 0, W, H);
  if (kind === 'clear' || kind === 'partly') sun(t);
  if (kind === 'fog') {
    for (let i = 0; i < 3; i++) {
      const y = H * (.12 + i * .16), off = (t * (8 + i * 4) + i * 120) % (W + 200) - 100;
      const g = ctx.createLinearGradient(off - 200, 0, off + 200, 0);
      g.addColorStop(0, 'rgba(235,238,240,0)'); g.addColorStop(.5, 'rgba(235,238,240,.7)'); g.addColorStop(1, 'rgba(235,238,240,0)');
      ctx.fillStyle = g; ctx.fillRect(off - 200, y - 18, 400, 36);
    }
  }
  for (const c of clouds) { c.x += c.v * dt; if (c.x - 70 * c.s > W) c.x = -70 * c.s; cloud(c); }
  if (DROPS[kind]) {
    ctx.strokeStyle = kind === 'rain' ? 'rgba(80,130,200,.65)' : 'rgba(60,100,180,.8)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const p of parts) {
      p.y += p.v * dt; p.x -= p.v * dt * .18;
      if (p.y > H) { p.y = -p.l; p.x = rnd(0, W * 1.1); }
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.l * .18, p.y - p.l);
    }
    ctx.stroke();
  }
  if (FLAKES[kind]) {
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    for (const p of parts) {
      p.y += p.v * dt; p.ph += dt;
      if (p.y > H) { p.y = -4; p.x = rnd(0, W); }
      ctx.beginPath(); ctx.arc(p.x + Math.sin(p.ph) * p.sw, p.y, p.r, 0, 7); ctx.fill();
    }
  }
  if (kind === 'thunder') {
    if (flash <= 0 && Math.random() < dt * .25) flash = .35;
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, W, H); flash -= dt * 1.2; }
  }
}

function loop(now) {
  raf = 0;
  if (!kind) return;
  if (root.offsetParent === null) { raf = setTimeout(() => requestAnimationFrame(loop), 500); return; }   // экран карты скрыт
  frame(now);
  if (!reduce) raf = requestAnimationFrame(loop);
}

export function setSky(k) {
  kind = k;
  cancelAnimationFrame(raf); clearTimeout(raf); raf = 0;
  if (!k) { root.hidden = true; return; }
  root.hidden = false;
  root.style.setProperty('--sky', TINT[k]);
  root.dataset.sky = k;
  fit(); build();
  t0 = performance.now() / 1000;
  raf = requestAnimationFrame(loop);
}

let lastKey = '';
async function update() {
  const day = today();
  if (!day) return;
  const key = day.date;
  if (key === lastKey) return;
  lastKey = key;
  try {
    const fc = await forecastFor(day);
    setSky(fc ? skyKind(fc.h) : null);
  } catch { lastKey = ''; setSky(null); }
}

export function initWeatherSky(el) {
  root = el; cv = el.querySelector('canvas'); ctx = cv.getContext('2d');
  new ResizeObserver(() => { if (kind) { fit(); build(); if (reduce) frame(performance.now()); } }).observe(el);
  onTripChange(update);
  update();
}
