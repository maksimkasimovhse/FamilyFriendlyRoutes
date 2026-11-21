import { requestId } from './request-id.js';
// Поездка семьи и работа с бекендом Максима (docs/contracts/openapi.json, docs/active_day.md).
// Одна сохранённая поездка на весь интерфейс: карта и «Сегодня» читают её отсюда
// и перерисовываются, когда она меняется (начали день, отметили остановку, пропустили).
//
// Цепочка: сессия → (вход / анкета) → поездка (POST /trips или /trips/from-profile)
//          → план (preview generate_plan) → сохранить (apply)
//          → «начинаем» (start_day) → «мы на месте» (progress) / «пропустить» (remove_stop).
// Если бекенд недоступен — показываем сохранённый план из data/route-cache.json (только просмотр).

let csrfToken = null;
let trip = null;            // TripView с сервера
let source = 'backend';     // 'backend' или 'cache'
const listeners = [];

// ---------- Подписка: экраны узнают об изменениях ----------
export function onTripChange(fn) { listeners.push(fn); }
function setTrip(t) { trip = t; listeners.forEach(fn => fn(trip, source)); }
export const getTrip = () => trip;
export const getSource = () => source;
// День, который показывают «Сегодня» и карта: сегодняшний по Москве, иначе первый день поездки
const todayMskDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
export const today = () => trip && (trip.days.find(d => d.date === todayMskDate()) || trip.days[0]);

// ---------- HTTP ----------
export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Гостевая или авторизованная сессия: cookie (HttpOnly) + CSRF-токен в памяти.
// Ответ: { csrf_token, authenticated, user, onboarding_completed }
export async function openSession() {
  let res;
  try { res = await fetch('/api/v1/session'); } catch { throw new ApiError('NETWORK', 'Нет связи с сервером'); }
  if (!res.ok) throw new ApiError('NETWORK', 'Сервер недоступен');
  const data = await res.json();
  csrfToken = data.csrf_token;
  return data;
}

async function call(method, path, body, idempotent = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (idempotent) headers['Idempotency-Key'] = requestId();
  let res;
  try { res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError('NETWORK', 'Нет связи с сервером'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error?.code || 'HTTP_' + res.status, data.error?.message || 'Ошибка сервера ' + res.status);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('Retry-After')) || null;
    throw err;
  }
  return data;
}

const tripPath = () => `/api/v1/trips/${trip.trip_id}`;
const nowIso = () => new Date().toISOString();

// Посмотреть вариант (preview) и сохранить его (apply)
async function preview(command, t = trip, position = null) {
  return call('POST', `/api/v1/trips/${t.trip_id}/previews`, { expected_version: t.version, command, current_position: position ? {coordinates:position,label:null} : null, observed_at: position ? nowIso() : null });
}
export async function applyPreview(p, acknowledged = p.required_acknowledgement_codes) {
  const saved = await call('POST', `/api/v1/trips/${p.trip_id}/previews/${p.preview_id}/apply`,
    { expected_version: p.base_version, acknowledged_warning_codes: acknowledged }, true);
  source = 'backend';
  setTrip(saved);
  remember(saved.trip_id);
  return saved;
}

// ---------- Вход, регистрация, выход (docs/auth_onboarding.md) ----------
// После входа/выхода backend меняет cookie и CSRF — берём новый токен из ответа.
async function authCall(path, body) {
  const data = await call('POST', '/api/v1/auth/' + path, body);
  csrfToken = data.csrf_token;
  return data;
}
export const register = (email, password) => authCall('register', { email, password });
export const login = (email, password) => authCall('login', { email, password });
export async function logout() {
  const data = await authCall('logout', {});
  forget();
  return data;
}

// ---------- Анкета семьи ----------
// null — анкеты ещё нет (404 PROFILE_NOT_FOUND)
export async function getProfile() {
  try { return await call('GET', '/api/v1/profile/family'); }
  catch (err) { if (err.code === 'PROFILE_NOT_FOUND') return null; throw err; }
}
// body: { expected_version, family, load_limits, wishes } → FamilyOnboardingView (с новой version)
export const saveProfile = body => call('PUT', '/api/v1/profile/family', body);

let reference = null;
export async function referenceData() {
  if (!reference) reference = await call('GET', '/api/v1/reference-data');
  return reference;
}

// ---------- Новая поездка: черновик → план → сохранение ----------
// Гость — полный TripInput; аккаунт — из анкеты (expected_profile_version)
export const createTrip = tripInput => call('POST', '/api/v1/trips', tripInput, true);
export const createTripFromProfile = request => call('POST', '/api/v1/trips/from-profile', request, true);
// Рассчитать маршрут для черновика (ещё не сохраняет)
export const planDraft = draft => preview({ kind: 'generate_plan' }, draft);
// Изменить рассчитанный, но ещё не сохранённый вариант (черновик): команда считается от base_preview_id
export const previewDraftChange = (draft, command, basePreviewId) => call('POST', `/api/v1/trips/${draft.trip_id}/previews`, {
  expected_version: draft.version, command: { ...command, base_preview_id: basePreviewId }, current_position: null, observed_at: null,
});
export const listTrips = () => call('GET', '/api/v1/trips');

// Открыть сохранённую поездку как текущую
export async function openTrip(id) {
  const saved = await call('GET', '/api/v1/trips/' + id);
  source = 'backend';
  setTrip(saved);
  remember(saved.trip_id);
  return saved;
}

// ---------- Загрузка поездки ----------
function remember(id) { try { localStorage.setItem('trip-id-v2', id); } catch { /* приватный режим */ } }
function remembered() { try { return localStorage.getItem('trip-id-v2'); } catch { return null; } }
export function forget() { try { localStorage.removeItem('trip-id-v2'); } catch { /* ничего */ } }

// Сохранённая поездка, если она ещё не закончилась (последний день — сегодня или позже); иначе null
export async function loadSavedTrip() {
  const id = remembered();
  if (!id) return null;
  try {
    const saved = await call('GET', '/api/v1/trips/' + id);
    const lastDay = saved.days[saved.days.length - 1]?.date;
    if (saved.status === 'draft' || !lastDay || lastDay < todayMskDate()) return null;
    source = 'backend';
    setTrip(saved);
    return saved;
  } catch { return null; }
}

// Бекенд недоступен — сохранённый план для показа (route-cache.json), только просмотр
export async function loadCachedTrip() {
  const cache = await (await fetch('data/route-cache.json')).json();
  source = 'cache';
  setTrip(cache.proposed_trip);
  return trip;
}

// ---------- Действия активного дня ----------
export function previewStartDay(point=today().start_point){return preview({kind:'start_day',date:today().date,point,start_at:nowIso()});}
export async function startDay() {
  const day = today();
  const p = await preview({ kind: 'start_day', date: day.date, point: day.start_point, start_at: nowIso() });
  return applyPreview(p);
}

export async function markVisited(stopId) {
  const saved = await call('POST', tripPath() + '/progress',
    { expected_version: trip.version, date: today().date, stop_id: stopId, status: 'visited', observed_at: nowIso() }, true);
  setTrip(saved);
  return saved;
}

// Пропустить остановку: сначала показываем, что изменится (preview), сохраняем по подтверждению
export function previewReplan() {
  return preview({ kind: 'replan_day', date: today().date });
}
// Любая команда PlanCommand (для помощника) — только расчёт, без сохранения
export function previewCommand(command) {
  return preview(command);
}
export const tripId = () => trip && trip.trip_id;
export const tripVersion = () => trip && trip.version;
export const csrf = () => csrfToken;
export const planningOptions = (t, previewId = null) => call('POST', `/api/v1/trips/${t.trip_id}/planning-options`, { expected_version:t.version, ...(previewId ? {preview_id:previewId} : {}) });
export const previewManualChoices = (t, date, choices, basePreviewId = null) => call('POST', `/api/v1/trips/${t.trip_id}/previews`, {
  expected_version:t.version, command:{kind:'append_manual_choices',date,choices,...(basePreviewId ? {base_preview_id:basePreviewId} : {})}, current_position:null, observed_at:null,
});

export function previewRemove(stopId, position = null) {
  return preview({ kind: 'remove_stop', date: today().date, stop_id: stopId }, trip, position);
}

export function previewInfrastructure(placeId,position) {
 return preview({kind:'insert_infrastructure_stop',date:today().date,place_id:placeId},trip,position);
}
export function previewRouteEdit(text) {
 return preview({kind:'edit_route',date:today().date,text});
}

export function previewActivity(selection) {
 return preview({kind:'add_activity',date:today().date,selection});
}
