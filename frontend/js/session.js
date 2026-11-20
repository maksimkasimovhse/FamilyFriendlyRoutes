// Сессия: вход, регистрация, выход, гостевой режим (docs/auth_onboarding.md, docs/tz-onboarding.md, экран 1).
// Пароль нигде не храним — только отправляем. Cookie HttpOnly ставит backend, CSRF держит api.js.

import { openSession, register, login, logout, ApiError } from './api.js';

const $ = id => document.getElementById(id);
const GUEST_KEY = 'guest-mode-v1';
// ДЕМО: пароль тестовых аккаунтов из scripts/seed-demo-users.py (только локальная база, не для настоящих людей)
const DEMO_PASSWORD = 'demo-semya-nizhny-2026';
let info = null;   // { csrf_token, authenticated, user, onboarding_completed }

export const session = () => info;
export const isAuthenticated = () => !!info?.authenticated;
export const userEmail = () => info?.user?.email || null;
export function isGuest() { try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } }
function setGuest(on) { try { on ? localStorage.setItem(GUEST_KEY, '1') : localStorage.removeItem(GUEST_KEY); } catch { /* приватный режим */ } }

export const enterGuest = () => setGuest(true);
export const leaveGuest = () => setGuest(false);

export async function startSession() {
  info = await openSession();
  if (info.authenticated) setGuest(false);
  return info;
}

export async function signOut() {
  info = await logout();      // backend выдаёт новую гостевую сессию и новый CSRF
  setGuest(false);
  return info;
}

// ---------- Экран 1 ----------
let mode = 'register';
let onDone = () => {};

function setMode(m) {
  mode = m;
  document.querySelectorAll('#onb-auth .seg button').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === m));
  $('auth-submit').textContent = m === 'register' ? 'Создать аккаунт' : 'Войти';
  $('auth-password').autocomplete = m === 'register' ? 'new-password' : 'current-password';
  $('auth-error').hidden = true;
}

function showError(text) {
  $('auth-error').textContent = text;
  $('auth-error').hidden = false;
}

// Проверка до отправки: почта с «@», пароль 15–128 символов и не только пробелы
function validate(email, password) {
  if (!email.trim() || !email.includes('@')) return 'Введите почту, например family@example.com';
  if (!password.trim()) return 'Введите пароль';
  if (mode === 'register' && [...password].length < 15) return 'Пароль — не короче 15 символов. Удобно фразой.';
  if ([...password].length > 128) return 'Пароль — не длиннее 128 символов';
  return null;
}

async function submit(e) {
  e.preventDefault();
  const email = $('auth-email').value;
  const password = $('auth-password').value;
  const problem = validate(email, password);
  if (problem) return showError(problem);
  const btn = $('auth-submit');
  btn.disabled = true;
  $('auth-error').hidden = true;
  try {
    // Уже вошли (например, в другой вкладке) — сначала выйти, иначе 409 ALREADY_AUTHENTICATED
    if (info?.authenticated) info = await logout();
    info = await (mode === 'register' ? register(email, password) : login(email, password));
    setGuest(false);
    $('auth-password').value = '';
    onDone(info);
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      showError(`Слишком много попыток, подождите ${err.retryAfter || 30} с`);
    } else if (err instanceof ApiError && err.code === 'ALREADY_AUTHENTICATED') {
      info = await startSession();
      onDone(info);
    } else {
      showError(err.message);
    }
  } finally {
    btn.disabled = false;
  }
}

// options: { onDone(sessionInfo), onGuest() }
export function initAuthScreen(options) {
  onDone = options.onDone;
  document.querySelectorAll('#onb-auth .seg button').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
  $('auth-form').addEventListener('submit', submit);
  $('auth-eye').onclick = () => {
    const show = $('auth-password').type === 'password';
    $('auth-password').type = show ? 'text' : 'password';
    $('auth-eye').setAttribute('aria-pressed', show);
    $('auth-eye').setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  };
  $('auth-guest').onclick = () => { setGuest(true); options.onGuest(); };
  // ДЕМО: заполнить почту и пароль тестового аккаунта и сразу войти
  document.querySelectorAll('[data-demo]').forEach(b => {
    b.onclick = () => {
      setMode('login');
      $('auth-email').value = b.dataset.demo;
      $('auth-password').value = DEMO_PASSWORD;
      $('auth-form').requestSubmit();
    };
  });
  // Подсказка «i»: открывается и закрывается нажатием (наведение не используем — на телефоне оно ломает нажатие)
  const tip = $('guest-tip'), tipBtn = $('guest-tip-btn');
  const setTip = open => { tip.hidden = !open; tipBtn.setAttribute('aria-expanded', open); };
  tipBtn.onclick = e => { e.stopPropagation(); setTip(tip.hidden); };
  document.addEventListener('click', e => { if (!tip.hidden && !tip.contains(e.target)) setTip(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setTip(false); });
  setMode('register');
}

// Показать экран входа; mode — 'register' или 'login'
export function openAuth(m = 'register') {
  setMode(m);
  $('onb-auth').hidden = false;
}
