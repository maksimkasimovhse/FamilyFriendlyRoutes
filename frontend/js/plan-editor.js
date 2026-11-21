// «Изменить план» на экране маршрута (черновик, ещё не сохранён).
// Маршрут составляет и упорядочивает backend (ML + планировщик), поэтому правки только в рамках одного дня:
// убрать место (✕) или добавить новое карточками (тот же свайп, что в подборе мест). Переносить места между днями
// и менять порядок нельзя. По «Применить» правки уходят командами remove_stop → add_activity, каждая считается от
// предыдущего варианта (base_preview_id), и backend перестраивает день. Цепочка проходит целиком либо план
// остаётся прежним. Вариант на сервере живёт 10 минут: если он устарел, план пересобирается и правки
// накладываются заново, ничего не теряется.

import { candidateCard } from './recommendation-cards.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '';
const fmtDay = iso => { const t = new Date(iso + 'T12:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const fmtDayShort = iso => { const t = new Date(iso + 'T12:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }); return t.charAt(0).toUpperCase() + t.slice(1); };

const isExpired = e => e && (e.code === 'PREVIEW_EXPIRED' || e.code === 'PREVIEW_STALE' || e.code === 'PREVIEW_NOT_FOUND');
function humanError(e) {
  if (isExpired(e)) return 'Вариант устарел. Нажмите «Применить» ещё раз: мы пересоберём план с вашими правками.';
  if (e.code === 'NETWORK') return 'Нет связи с сервером. Правки сохранены в окне — попробуйте ещё раз.';
  if (e.status === 422 || e.status === 409) return 'Так не получится: ' + (e.message || 'план не собрался') + ' Правки остались в окне: измените их или отмените.';
  return e.message || 'Не удалось пересчитать план.';
}

// Кандидаты подборки, которые можно показать карточкой на конкретный день
const cardsFor = (cands, taken, date) => cands
  .filter(c => !taken.has(c.activity.activity_id))
  .map(c => candidateCard(c, date))
  .filter(card => card.occurrence_id !== null || !cands.find(c => c.activity.activity_id === card.activity_id && c.activity.kind === 'session'));

// Наложить правки на вариант. layout: { removed: [activity_id], added: [{ date, id }] }.
// meta: activity_id → { place_id, occurrence_id } для добавляемых мест. Возвращает последний вариант.
export async function applyLayout({ preview, layout, change, meta }) {
  let base = preview, plan = preview.proposed_trip;
  const run = async cmd => { base = await change(cmd, base.preview_id); plan = base.proposed_trip; };
  const find = aid => { for (const d of plan.days) { const s = d.stops.find(x => x.activity_id === aid); if (s) return { date: d.date, stop: s }; } return null; };
  for (const aid of layout.removed) {                                               // 1. убрать
    const f = find(aid);
    if (f) await run({ kind: 'remove_stop', date: f.date, stop_id: f.stop.stop_id });
  }
  const snapshot = new Map((plan.recommendation_snapshot?.candidates || []).map(c => [c.activity.activity_id, c]));
  for (const { date, id } of layout.added) {                                        // 2. добавить в выбранный день
    if (find(id)) continue;
    const m = meta.get(id) || { place_id: snapshot.get(id)?.place.place_id, occurrence_id: null };
    if (!m.place_id) continue;
    await run({ kind: 'add_activity', date, selection: { activity_id: id, place_id: m.place_id, occurrence_id: m.occurrence_id ?? null, mandatory: false, preferred_date: date } });
  }
  return base;
}

// Опции:
//  preview      — текущий PlanPreview
//  change(cmd, basePreviewId) → новый PlanPreview
//  refresh()    → свежий PlanPreview с уже применёнными прежними правками (когда вариант устарел)
//  pickCards(date, cards, title) → Promise<карточки | null>: экран подбора мест поверх окна
//  onDone(preview, layout, meta) — правки применены; layout накапливается между применениями
export function openPlanEditor({ preview, change, refresh, pickCards, onDone, prior }) {
  let current = preview;
  const trip = () => current.proposed_trip;
  const info = new Map();
  const remember = pv => {
    pv.proposed_trip.days.forEach(d => d.stops.forEach(s => info.set(s.activity_id, { title: s.title, mins: Math.round((s.duration?.duration_sec || 0) / 60) })));
    (pv.proposed_trip.recommendation_snapshot?.candidates || []).forEach(c => { if (!info.has(c.activity.activity_id)) info.set(c.activity.activity_id, { title: c.activity.title, mins: Math.round((c.activity.duration?.duration_sec || 0) / 60) }); });
  };
  remember(current);
  const meta = new Map();                                  // для добавленных карточками мест

  const layoutOf = pv => pv.proposed_trip.days.map(d => ({ date: d.date, ids: d.stops.map(s => s.activity_id) }));
  const orig = layoutOf(current);
  const work = orig.map(d => ({ date: d.date, ids: [...d.ids] }));
  let busy = false, error = '';

  const sheet = document.getElementById('plan-sheet') || (() => {
    const el = document.createElement('div');
    el.id = 'plan-sheet'; el.className = 'plan-sheet';
    document.getElementById('trip-preview').append(el);
    return el;
  })();
  const close = () => { sheet.hidden = true; sheet.replaceChildren(); };
  const changed = () => JSON.stringify(work.map(d => d.ids)) !== JSON.stringify(orig.map(d => d.ids));
  const taken = () => new Set(work.flatMap(d => d.ids));
  const candidates = () => (trip().recommendation_snapshot?.candidates || []);
  const remove = id => work.forEach(d => { d.ids = d.ids.filter(x => x !== id); });

  function draw() {
    const multi = work.length > 1;
    const freeCount = taken().size < candidates().length;
    sheet.innerHTML = `
      <div class="plan-panel" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <div class="plan-head"><h2 id="plan-title">Изменить план</h2><button type="button" class="plan-x" aria-label="Закрыть" data-act="close">✕</button></div>
        <div class="plan-body" id="plan-body">
          <p class="small">Уберите лишнее (✕) или добавьте места карточками: маршрут этого дня перестроится сам.</p>
          ${work.map((d, di) => `
            <section class="pe-day" data-di="${di}">
              <h3>${esc(fmtDay(d.date))} <span>${d.ids.length ? d.ids.length + ' мест' : 'пусто'}</span></h3>
              <ul class="pe-list">
                ${d.ids.map(id => `
                  <li class="pe-row" data-id="${esc(id)}">
                    <span class="pe-title">${esc(info.get(id)?.title || id)}<small>${info.get(id)?.mins ? '~' + info.get(id).mins + ' мин' : ''}</small></span>
                    <button type="button" class="pe-x" data-rm="${esc(id)}" aria-label="Убрать">✕</button>
                  </li>`).join('') || '<li class="pe-empty">В этот день пока нет мест — добавьте карточками</li>'}
              </ul>
              ${d.ids.length < 2 ? '<p class="pe-hint">В день лучше хотя бы 2 места</p>' : ''}
              <button type="button" class="pe-addcards" data-add="${di}" ${freeCount ? '' : 'disabled'}>＋ Добавить карточками${multi ? ' · ' + esc(fmtDayShort(d.date)) : ''}</button>
            </section>`).join('')}
          ${freeCount ? '' : '<p class="small">Все подходящие места уже в плане.</p>'}
          ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
        </div>
        <div class="plan-foot">
          <button type="button" class="btn flow-main" data-act="apply" ${changed() && !busy ? '' : 'disabled'}>${busy ? 'Пересчитываем…' : 'Применить и пересчитать'}</button>
          <button type="button" class="btn link" data-act="close">Отмена</button>
        </div>
      </div>`;
    sheet.querySelectorAll('[data-act="close"]').forEach(b => { b.onclick = () => { if (!busy) close(); }; });
    sheet.querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { remove(b.dataset.rm); error = ''; draw(); }; });
    sheet.querySelectorAll('[data-add]').forEach(b => { b.onclick = () => addCards(Number(b.dataset.add)); });
    sheet.querySelector('[data-act="apply"]').onclick = apply;
  }

  // Новые места — карточками: экран подбора открывается поверх, окно ждёт
  async function addCards(di) {
    const date = work[di].date;
    const cards = cardsFor(candidates(), taken(), date);
    if (!cards.length) { error = 'Подходящих мест больше нет.'; draw(); return; }
    sheet.hidden = true;
    const chosen = await pickCards(date, cards, `Добавить в: ${fmtDay(date)}`);
    sheet.hidden = false;
    for (const card of chosen || []) {
      if (taken().has(card.activity_id)) continue;
      meta.set(card.activity_id, { place_id: card.place_id, occurrence_id: card.occurrence_id });
      info.set(card.activity_id, { title: card.title, mins: 0 });
      work[di].ids.push(card.activity_id);
    }
    error = '';
    draw();
  }

  // ---------- Применение ----------
  async function apply() {
    busy = true; error = ''; draw();
    // Что изменилось в этом окне — по дням: убрано из дня и добавлено в день (убрать и добавить в другой день = перенос)
    const layout = { removed: [], added: [] };
    work.forEach((d, i) => {
      orig[i].ids.filter(id => !d.ids.includes(id)).forEach(id => layout.removed.push(id));
      d.ids.filter(id => !orig[i].ids.includes(id)).forEach(id => layout.added.push({ date: d.date, id }));
    });
    try {
      let result;
      try { result = await applyLayout({ preview: current, layout, change, meta }); }
      catch (e) {
        if (!isExpired(e)) throw e;
        result = await applyLayout({ preview: await refresh(), layout, change, meta });    // вариант устарел → свежий + те же правки
      }
      onDone(result, layout, meta);
      close();
    } catch (e) {
      busy = false; error = humanError(e); draw();
    }
  }

  draw();
  sheet.hidden = false;
}
