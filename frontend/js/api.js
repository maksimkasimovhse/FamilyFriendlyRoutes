// Работа с бекендом Максима (docs/contracts/openapi.json).
// Цепочка: сессия → создать поездку → попросить вариант маршрута (preview).
// Если бекенд недоступен — берём сохранённый ответ из data/route-cache.json.

let csrfToken = null;

// 1. Гостевая сессия: бекенд ставит cookie и отдаёт CSRF-токен для POST-запросов
async function openSession() {
  const res = await fetch('/api/v1/session');
  if (!res.ok) throw new Error('сессия: HTTP ' + res.status);
  csrfToken = (await res.json()).csrf_token;
}

// POST с нужными заголовками. idempotencyKey — защита от двойного создания
async function post(path, body, idempotencyKey) {
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
  return data;
}

// Построить один день маршрута. Возвращает объект дня (stops, legs, totals…)
async function planDay(tripInput) {
  await openSession();
  const trip = await post('/api/v1/trips', tripInput, crypto.randomUUID());
  const preview = await post(`/api/v1/trips/${trip.trip_id}/previews`, {
    expected_version: trip.version,
    command: { kind: 'generate_plan' },
    current_position: null,
    observed_at: null,
  });
  return preview.proposed_trip.days[0];
}

// Главная функция для экранов: пробуем бекенд, иначе — сохранённый маршрут
export async function loadDay(tripInput) {
  try {
    return { day: await planDay(tripInput), source: 'backend' };
  } catch (err) {
    console.warn('Бекенд недоступен, берём сохранённый маршрут:', err);
    const cache = await (await fetch('data/route-cache.json')).json();
    return { day: cache.proposed_trip.days[0], source: 'cache', error: err.message };
  }
}
