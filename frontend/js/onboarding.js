// Анкета семьи: хранение и экраны 2–4 (docs/tz-onboarding.md).
// Состояние — один объект формы FamilyOnboardingInput: { version, family, load_limits, wishes }.
// Аккаунт — PUT /api/v1/profile/family; гость — localStorage. Имена детей — ТОЛЬКО на устройстве
// (в контракте поля нет; это лишние данные о ребёнке), рядом с child_id.

import { getProfile, saveProfile, referenceData, ApiError } from './api.js';
import { userEmail } from './session.js';

const $ = id => document.getElementById(id);
const PROFILE_KEY = 'family-profile-v1';
const NAMES_KEY = 'child-names-v1';
// Чья анкета и имена лежат на устройстве: 'guest' или почта аккаунта. Чужое не переносим и не показываем.
const OWNER_KEY = 'family-owner-v1';
const AGES = [3, 4, 5, 6, 7, 8, 9, 10, 11];
// Счётчик «− N +», как у взрослых: самый привычный способ выбрать количество. Верхняя граница — 10 (больше — уже группа).
const MAX_KIDS = 10;

// Интересы из макета. id для истории/науки/игр совпадают со справочником backend (history, science, play);
// остальные — [Предложение] до согласования словаря с ML (Вильдан) и reference-data (Максим).
// Backend принимает любые id (проверяет только длину/повторы), но смысл им придаёт только ML.
const CHILD_INTERESTS = [
  { id: 'animals', label: 'Животные' }, { id: 'history', label: 'История' },
  { id: 'art', label: 'Творчество' }, { id: 'tech', label: 'Техника' }, { id: 'play', label: 'Активные игры' },
  { id: 'nature', label: 'Природа' },
];
const ADULT_INTERESTS = [
  { id: 'history', label: 'История' }, { id: 'architecture', label: 'Архитектура' }, { id: 'museums', label: 'Музеи' },
  { id: 'walks', label: 'Прогулки' }, { id: 'nature', label: 'Природа' }, { id: 'local_food', label: 'Местная кухня' },
  { id: 'art', label: 'Искусство' }, { id: 'theatre', label: 'Театр' }, { id: 'music', label: 'Музыка' },
  { id: 'literature', label: 'Литература' }, { id: 'crafts', label: 'Ремёсла' }, { id: 'photo', label: 'Фотография' },
  { id: 'plants', label: 'Сады и парки' }, { id: 'sport', label: 'Спорт' }, { id: 'tech', label: 'Техника' },
  { id: 'cafes', label: 'Кафе и кофейни' }, { id: 'shopping', label: 'Сувениры и шопинг' },
];
// Интересы, которых нет в анкете, даже если их отдаёт справочник backend (у старых анкет id сохраняются)
const HIDDEN_CHILD_INTERESTS = new Set(['science']);

// ---------- Хранение ----------
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ } };

let profile = null;          // текущая анкета (или null — ещё не заполнена)
let names = read(NAMES_KEY, {});
let owner = read(OWNER_KEY, null);

// Сменился хозяин данных на устройстве — стираем прежнюю анкету и имена детей
function switchOwner(next, { keepGuest = false } = {}) {
  if (owner && owner !== next && !(keepGuest && owner === 'guest')) {
    names = {};
    write(NAMES_KEY, names);
    try { localStorage.removeItem(PROFILE_KEY); } catch { /* ничего */ }
  }
  owner = next;
  write(OWNER_KEY, owner);
}
const fromView = v => ({ version: v.version, family: v.family, load_limits: v.load_limits, wishes: v.wishes });

const emptyProfile = () => ({
  version: 0,
  family: { children: [{ child_id: 'child-1', age_years: 6, height_cm: null, interest_ids: [] }], adult_count: 2, adult_interest_ids: [] },
  load_limits: { pace: 'relaxed', max_walk_distance_m_per_day: null, max_continuous_walk_duration_sec: null, restaurant_walk_reserve_m_per_day: 0 },
  wishes: null,
});
const clone = o => JSON.parse(JSON.stringify(o));

// «Продолжить без входа» — всегда чистый гость: стираем анкету, имена и хозяина с устройства
export function clearDeviceData() {
  profile = null; names = {}; owner = 'guest';
  for (const k of [PROFILE_KEY, NAMES_KEY, OWNER_KEY]) { try { localStorage.removeItem(k); } catch { /* ничего */ } }
  write(OWNER_KEY, owner);
}

export const currentProfile = () => profile;
export const profileVersion = () => profile?.version || 0;

// Загрузить анкету: аккаунт — с сервера, гость — с устройства. null — анкеты нет
export async function loadFamily({ authenticated }) {
  if (authenticated) {
    switchOwner(userEmail());
    const view = await getProfile();
    profile = view ? fromView(view) : null;
    if (profile) write(PROFILE_KEY, profile);
  } else {
    switchOwner('guest');
    profile = read(PROFILE_KEY, null);
  }
  return profile;
}

// После входа: переносим в аккаунт ТОЛЬКО анкету, заполненную гостем на этом устройстве
// (и только если в аккаунте своей анкеты ещё нет). Анкету другого аккаунта не трогаем.
export async function syncLocalProfile() {
  const email = userEmail();
  const wasGuest = owner === 'guest';
  const local = wasGuest ? read(PROFILE_KEY, null) : null;
  const view = await getProfile();
  if (view) {
    switchOwner(email);                       // в аккаунте своя анкета — гостевую не используем
    profile = fromView(view);
  } else if (local) {
    const saved = await saveProfile({ expected_version: 0, family: local.family, load_limits: local.load_limits, wishes: local.wishes });
    switchOwner(email, { keepGuest: true });  // имена детей гостя переходят вместе с анкетой
    profile = fromView(saved);
  } else {
    switchOwner(email);
    profile = null;
  }
  if (profile) write(PROFILE_KEY, profile);
  return profile;
}

// Имя ребёнка для детского режима; пусто — «Ребёнок 1»
export function childName(index = 0) {
  const id = profile?.family.children[index]?.child_id || `child-${index + 1}`;
  return (names[id] || '').trim() || `Ребёнок ${index + 1}`;
}
// Родительный падеж для фраз «Тропа Маши», «у Пети задание» — простое правило по окончанию
export function genitive(name) {
  if (/^Ребёнок \d+$/.test(name)) return name.replace('Ребёнок', 'ребёнка');
  const last = name.slice(-1).toLowerCase(), prev = name.slice(-2, -1).toLowerCase();
  if (last === 'а') return name.slice(0, -1) + ('гкхжшщч'.includes(prev) ? 'и' : 'ы');
  if (last === 'я' || last === 'ь') return name.slice(0, -1) + 'и';
  if (last === 'й') return name.slice(0, -1) + 'я';
  if ('бвгджзклмнпрстфхцчшщ'.includes(last)) return name + 'а';
  return name;
}
// «4 года», «7 лет», «21 год»
export function ageText(n) {
  const m10 = n % 10, m100 = n % 100;
  return n + ' ' + (m10 === 1 && m100 !== 11 ? 'год' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'года' : 'лет');
}
export function familySummary(p = profile) {
  if (!p) return '';
  const kids = p.family.children.map((c, i) => `${childName(i)}, ${ageText(c.age_years)}`).join('; ');
  return `${p.family.adult_count} взр. · ${kids}`;
}

// ДЕМО: у аккаунтов из scripts/seed-demo-users.py имён детей на сервере нет (их там вообще не хранят),
// поэтому на новом устройстве подставляем имена, чтобы детский режим не говорил «Ребёнок 1».
const DEMO_NAMES = {
  'masha@example.com': { 'child-1': 'Маша' },
  'petya@example.com': { 'child-1': 'Петя', 'child-2': 'Аня' },
};
export function seedDemoNames(email) {
  const demo = DEMO_NAMES[(email || '').toLowerCase()];
  if (!demo) return;
  names = { ...demo, ...names };   // то, что человек ввёл сам на этом устройстве, важнее
  write(NAMES_KEY, names);
}

// Названия интересов для профиля
// Старые анкеты могут хранить id, которых уже нет в списках (например, science) — подписываем их по-русски
const LEGACY_LABELS = { science: 'Наука', tech: 'Техника', play: 'Активные игры' };
export const interestLabel = id => (CHILD_INTERESTS.concat(ADULT_INTERESTS).find(o => o.id === id) || { label: LEGACY_LABELS[id] || id }).label;
export const adultInterestLabels = ids => ids.map(interestLabel);

// ---------- Экраны ----------
let draft = null;      // редактируемая копия
let unsure = {};       // «Пока не знаем» по child_id
let options = { onDone: () => {}, onBack: () => {}, authenticated: false };
let interestOptions = { child: CHILD_INTERESTS, adult: ADULT_INTERESTS };

function show(id) {
  ['onb-family', 'onb-kids', 'onb-adults'].forEach(s => { $(s).hidden = s !== id; });
  $(id).querySelector('.flow-scroll').scrollTop = 0;
}
const err = (id, text) => { $(id).textContent = text || ''; $(id).hidden = !text; };

// Справочник интересов с backend + варианты из макета (подписи из макета, id — общие)
async function loadInterests() {
  try {
    const ref = await referenceData();
    const extra = (ref.interest_options || []).filter(o => !CHILD_INTERESTS.some(c => c.id === o.id) && !HIDDEN_CHILD_INTERESTS.has(o.id));
    interestOptions = { child: [...CHILD_INTERESTS, ...extra], adult: ADULT_INTERESTS };
  } catch { /* backend недоступен — список из макета */ }
}

// ----- Шаг 1: кто едет -----
function renderFamily() {
  const f = draft.family;
  $('adults-count').textContent = f.adult_count;
  $('adults-minus').disabled = f.adult_count <= 1;
  $('adults-plus').disabled = f.adult_count >= 10;
  $('kids-count').textContent = f.children.length;
  $('kids-minus').disabled = f.children.length <= 1;
  $('kids-plus').disabled = f.children.length >= MAX_KIDS;
  $('kids-cards').innerHTML = '';
  f.children.forEach((child, i) => {
    const card = document.createElement('div');
    card.className = 'card-w kid-card-w';
    card.innerHTML = `
      <div class="kid-head"><span class="kid-num">${i + 1}</span>Ребёнок ${i + 1}</div>
      <label class="field">Имя
        <input type="text" maxlength="30" autocomplete="off" placeholder="Например, Маша"></label>
      <div class="age-pick">
        <button type="button" class="age-btn" data-d="-1" aria-label="Младше">−</button>
        <div class="age-val" aria-live="polite"><b></b><span></span></div>
        <button type="button" class="age-btn" data-d="1" aria-label="Старше">+</button>
      </div>
      <input type="range" class="age-range" min="3" max="11" step="1" aria-label="Возраст ребёнка">`;
    const input = card.querySelector('input');
    input.value = names[child.child_id] || '';
    input.oninput = () => { names[child.child_id] = input.value; };
    // Возраст: цифра, «−/+» и ползунок. Обновляем на месте, без перерисовки, чтобы ползунок можно было тянуть
    const num = card.querySelector('.age-val b'), word = card.querySelector('.age-val span'), range = card.querySelector('.age-range');
    const paint = () => {
      const a = child.age_years;
      num.textContent = a;
      word.textContent = ageText(a).replace(/^\d+ /, '');
      range.value = a;
      range.style.setProperty('--p', ((range.value - 3) / 8 * 100) + '%');
    };
    const setAge = v => { child.age_years = Math.min(11, Math.max(3, v)); paint(); };
    card.querySelectorAll('.age-btn').forEach(b => { b.onclick = () => setAge(child.age_years + Number(b.dataset.d)); });
    range.oninput = () => setAge(Number(range.value));
    paint();
    $('kids-cards').append(card);
  });
}

function bindFamily() {
  $('adults-minus').onclick = () => { draft.family.adult_count = Math.max(1, draft.family.adult_count - 1); renderFamily(); };
  $('adults-plus').onclick = () => { draft.family.adult_count = Math.min(10, draft.family.adult_count + 1); renderFamily(); };
  // child_id стабилен: ребёнок N — всегда child-N, лишний убираем с конца
  $('kids-plus').onclick = () => {
    const kids = draft.family.children;
    if (kids.length < MAX_KIDS) kids.push({ child_id: `child-${kids.length + 1}`, age_years: 6, height_cm: null, interest_ids: [] });
    renderFamily();
  };
  $('kids-minus').onclick = () => { if (draft.family.children.length > 1) draft.family.children.pop(); renderFamily(); };
  $('family-next').onclick = () => {
    const missing = draft.family.children.findIndex(c => !AGES.includes(c.age_years));
    if (missing !== -1) return err('family-error', `Выберите возраст ребёнка ${missing + 1}`);
    err('family-error');
    renderKids();
    show('onb-kids');
  };
}

// ----- Шаг 2: интересы детей -----
function renderKids() {
  $('kids-interests').innerHTML = '';
  draft.family.children.forEach((child, i) => {
    const name = childName(i);
    const card = document.createElement('div');
    card.className = 'card-w';
    const count = child.interest_ids.length;
    card.innerHTML = `
      <div class="kid-top"><span class="kid-ava"></span><h2 class="kid-title"></h2><span class="kid-age"></span></div>
      <div class="chips-w" role="group" aria-label="Интересы">${interestOptions.child.map(o =>
        `<button type="button" data-id="${o.id}" aria-pressed="${child.interest_ids.includes(o.id)}"></button>`).join('')}
        <button type="button" class="unsure" data-unsure aria-pressed="${!!unsure[child.child_id]}">Пока не знаем</button></div>`;
    card.querySelector('.kid-title').textContent = name;
    card.querySelector('.kid-ava').textContent = name.replace(/^Ребёнок\s*/, '').charAt(0).toUpperCase() || name.charAt(0).toUpperCase();
    card.querySelector('.kid-age').textContent = ageText(child.age_years);
    card.querySelectorAll('[data-id]').forEach(b => {
      b.textContent = interestOptions.child.find(o => o.id === b.dataset.id).label;
      b.onclick = () => {
        const ids = child.interest_ids;
        const k = ids.indexOf(b.dataset.id);
        k === -1 ? ids.push(b.dataset.id) : ids.splice(k, 1);
        unsure[child.child_id] = false;
        renderKids();
      };
    });
    card.querySelector('[data-unsure]').onclick = () => {
      unsure[child.child_id] = !unsure[child.child_id];
      if (unsure[child.child_id]) child.interest_ids = [];   // «Пока не знаем» → interest_ids: []
      renderKids();
    };
    $('kids-interests').append(card);
  });
}

// ----- Шаг 3: взрослые, темп, пожелания -----
function renderAdults() {
  $('adult-interests').innerHTML = '';
  interestOptions.adult.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.setAttribute('aria-pressed', draft.family.adult_interest_ids.includes(o.id));
    b.onclick = () => {
      const ids = draft.family.adult_interest_ids;
      const k = ids.indexOf(o.id);
      k === -1 ? ids.push(o.id) : ids.splice(k, 1);
      renderAdults();
    };
    $('adult-interests').append(b);
  });
}

function bindAdults() {
  $('profile-save').onclick = save;
}

async function save() {
  const btn = $('profile-save');
  btn.disabled = true;
  err('adults-error');
  try {
    if (options.authenticated) {
      const view = await saveProfile({ expected_version: draft.version || 0, family: draft.family, load_limits: draft.load_limits, wishes: draft.wishes });
      draft.version = view.version;
    }
    profile = clone(draft);
    owner = options.authenticated ? userEmail() : 'guest';
    write(OWNER_KEY, owner);
    write(PROFILE_KEY, profile);
    write(NAMES_KEY, names);
    options.onDone(profile);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      await loadFamily({ authenticated: true });
      draft = clone(profile);
      renderAdults();
      err('adults-error', 'Анкета изменилась на другом устройстве — мы загрузили новую версию. Проверьте и сохраните ещё раз.');
    } else {
      err('adults-error', e.message);
    }
  } finally {
    btn.disabled = false;
  }
}

let bound = false;
// options: { authenticated, onDone(profile), onBack() }
export async function openOnboarding(opts) {
  options = { ...options, ...opts };
  await loadInterests();
  draft = clone(profile || emptyProfile());
  unsure = {};
  draft.family.children.forEach(c => { unsure[c.child_id] = profile ? c.interest_ids.length === 0 : false; });
  if (!bound) {
    bound = true;
    bindFamily();
    bindAdults();
    $('onb-family').querySelector('[data-back]').onclick = () => { $('onb-family').hidden = true; options.onBack(); };
    $('onb-kids').querySelector('[data-back]').onclick = () => show('onb-family');
    $('onb-adults').querySelector('[data-back]').onclick = () => { renderKids(); show('onb-kids'); };
    $('kids-next').onclick = () => { renderAdults(); show('onb-adults'); };
  }
  renderFamily();
  show('onb-family');
}

export function closeOnboarding() { ['onb-family', 'onb-kids', 'onb-adults'].forEach(s => { $(s).hidden = true; }); }

// ---------- Правка интересов из профиля (карандашик) ----------
// kind: 'child' | 'adult'. Варианты — те же, что в анкете.
export async function interestChoices(kind) {
  await loadInterests();
  return kind === 'adult' ? interestOptions.adult : interestOptions.child;
}

// Сохраняет интересы одного ребёнка (index) или всех взрослых. Аккаунт — на сервере (с проверкой версии), гость — на устройстве.
export async function updateInterests({ kind, index = 0, ids, authenticated }) {
  if (!profile) throw new Error('Анкета ещё не заполнена');
  const next = clone(profile);
  if (kind === 'adult') next.family.adult_interest_ids = ids;
  else next.family.children[index].interest_ids = ids;
  if (authenticated) {
    const view = await saveProfile({ expected_version: next.version || 0, family: next.family, load_limits: next.load_limits, wishes: next.wishes });
    next.version = view.version;
  }
  profile = next;
  write(PROFILE_KEY, profile);
  return profile;
}
