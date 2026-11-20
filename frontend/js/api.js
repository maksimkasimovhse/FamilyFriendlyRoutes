// Поездка семьи и работа с бекендом Максима (docs/contracts/openapi.json, docs/active_day.md).
// Одна сохранённая поездка на весь интерфейс: карта и «Сегодня» читают её отсюда
// и перерисовываются, когда она меняется (начали день, отметили остановку, пропустили).
//
// Цепочка: сессия → создать поездку → план (preview) → сохранить (apply)
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
export const today = () => trip && trip.days[0];

// ---------- HTTP ----------
export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function openSession() {
  const res = await fetch('/api/v1/session');
  if (!res.ok) throw new ApiError('NETWORK', 'Сервер недоступен');
  csrfToken = (await res.json()).csrf_token;
}

async function call(method, path, body, idempotent = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (idempotent) headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error?.code || 'HTTP_' + res.status, data.error?.message || 'Ошибка сервера ' + res.status);
  return data;
}

const tripPath = () => `/api/v1/trips/${trip.trip_id}`;
const nowIso = () => new Date().toISOString();

// Посмотреть вариант (preview) и сохранить его (apply)
async function preview(command) {
  return call('POST', tripPath() + '/previews', { expected_version: trip.version, command, current_position: null, observed_at: null });
}
export async function applyPreview(p) {
  const saved = await call('POST', `${tripPath()}/previews/${p.preview_id}/apply`,
    { expected_version: p.base_version, acknowledged_warning_codes: p.required_acknowledgement_codes }, true);
  setTrip(saved);
  return saved;
}

// ---------- Загрузка поездки ----------
function remember(id) { try { localStorage.setItem('trip-id-v2', id); } catch { /* приватный режим */ } }
function remembered() { try { return localStorage.getItem('trip-id-v2'); } catch { return null; } }

// Взять сохранённую поездку (если она на сегодня), иначе создать новую и сохранить план
export async function loadTrip(tripInput) {
  try {
    await openSession();
    const id = remembered();
    if (id) {
      try {
        const saved = await call('GET', '/api/v1/trips/' + id);
        if (saved.status !== 'draft' && saved.days[0]?.date === tripInput.days[0].date) {
          source = 'backend';
          setTrip(saved);
          return trip;
        }
      } catch { /* поездка устарела или сессия новая — создадим заново */ }
    }
    trip = await call('POST', '/api/v1/trips', tripInput, true);
    remember(trip.trip_id);
    await applyPreview(await preview({ kind: 'generate_plan' }));
    return trip;
  } catch (err) {
    console.warn('Бекенд недоступен, показываем сохранённый план:', err);
    const cache = await (await fetch('data/route-cache.json')).json();
    source = 'cache';
    setTrip(cache.proposed_trip);
    return trip;
  }
}

// Начать заново: новая поездка с теми же параметрами
export async function resetTrip(tripInput) {
  try { localStorage.removeItem('trip-id-v2'); } catch { /* ничего */ }
  return loadTrip(tripInput);
}

// ---------- Действия активного дня ----------
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

export function previewRemove(stopId) {
  return preview({ kind: 'remove_stop', date: today().date, stop_id: stopId });
}
