// МОК ИИ-помощника — пока у Вильдана нет сервиса (контракт: docs/contracts/assistant_draft.md).
// Понимает несколько типичных просьб по ключевым словам. Изменения маршрута делает
// настоящими командами бекенда (remove_stop, replan_day) — только расчёт (preview),
// сохраняет пользователь кнопкой «Применить».
// Ответ — в формате контракта: { reply, preview, places, suggestions }.

import { today, previewRemove, previewReplan } from './api.js';
import { nearest, isFamilyCafe } from './places.js';

const DEFAULT_SUGGESTIONS = ['Ребёнок устал', 'Нужен туалет', 'Хотим поесть', 'Пошёл дождь', 'Пропусти следующую точку'];

const planned = () => today().stops.filter(s => s.progress === 'planned');

// Откуда искать места: последняя отметка → следующая точка → старт
function origin() {
  const day = today();
  if (day.execution) return day.execution.current_point.coordinates;
  return (planned()[0] || day).location?.coordinates || day.start_point.coordinates;
}

const placesReply = (kind, filter = () => true) => nearest(origin(), kind, 3, filter).map(x => x.place);

// Найти точку маршрута по словам из сообщения: «убери кремль» → «Кремль: смотровая площадка»
function findStop(text) {
  const words = text.split(/[^а-яёa-z]+/i).filter(w => w.length > 3).map(w => w.slice(0, 5));
  return planned().find(s => words.some(w => s.title.toLowerCase().includes(w)));
}

async function removeAnswer(stop, why) {
  const preview = await previewRemove(stop.stop_id);
  return { reply: `${why} Уберу «${stop.title}» — вот что получится:`, preview, places: [], suggestions: ['Нужен туалет', 'Хотим поесть'] };
}

export async function mockAssistant(message) {
  const t = message.toLowerCase();
  const left = planned();

  if (/туалет|пописать|санузел|\bwc\b/.test(t)) {
    const places = placesReply('toilets');
    return { reply: places.length ? 'Ближайшие туалеты от вашей точки:' : 'Рядом туалетов в данных не нашлось.', preview: null, places, suggestions: ['Хотим поесть', 'Ребёнок устал'] };
  }
  if (/дожд|мокр|холод|замерз|ливень/.test(t)) {
    const places = placesReply('cafe');
    return { reply: 'Переждать можно в кафе рядом. Если дождь надолго — могу сократить прогулку.', preview: null, places, suggestions: ['Сократи прогулку', 'Хотим поесть'] };
  }
  if (/голод|поесть|кушать|есть хо|обед|ужин|перекус|кафе|ресторан/.test(t)) {
    let places = placesReply('cafe', isFamilyCafe);
    const family = places.length > 0;
    if (!family) places = placesReply('cafe');
    return { reply: family ? 'Кафе рядом, где есть что-то для детей:' : 'Кафе с подтверждённым детским меню рядом нет — вот ближайшие:', preview: null, places, suggestions: ['Нужен туалет', 'Ребёнок устал'] };
  }
  if (/площадк|поигра|скучн|побега|покачат/.test(t)) {
    const places = placesReply('playground');
    return { reply: 'Ближайшие детские площадки:', preview: null, places, suggestions: ['Ребёнок устал', 'Хотим поесть'] };
  }
  if (/завтра|следующ\w* день|перенес/.test(t)) {
    return { reply: 'Перенос точек на завтра скоро появится. Сейчас могу убрать точку из сегодняшнего маршрута — она останется в плане на потом.', preview: null, places: [], suggestions: left.map(s => `Убери «${s.title}»`).slice(0, 3) };
  }
  if (/пересчит|опазд|задерж|не успева/.test(t)) {
    const preview = await previewReplan();
    return { reply: 'Пересчитал оставшийся маршрут от текущего момента:', preview, places: [], suggestions: DEFAULT_SUGGESTIONS.slice(0, 3) };
  }
  if (/убер|убрат|пропус|не пойд|не хоч|без /.test(t)) {
    if (/следующ/.test(t) && left[0]) return removeAnswer(left[0], 'Хорошо.');
    const stop = findStop(t);
    if (stop) return removeAnswer(stop, 'Хорошо.');
    return { reply: 'Какую точку убрать?', preview: null, places: [], suggestions: left.map(s => `Убери «${s.title}»`).slice(0, 4) };
  }
  if (/устал|сил нет|тяжело|домой|сократ|короче|хватит|капризн/.test(t)) {
    if (left.length < 2) {
      return { reply: 'Осталась последняя точка — можно отдохнуть на площадке рядом и закончить.', preview: null, places: placesReply('playground'), suggestions: ['Хотим поесть'] };
    }
    const last = left[left.length - 1];
    const answer = await removeAnswer(last, 'Понимаю. Давайте сократим прогулку с конца, а следующую точку оставим.');
    answer.places = placesReply('playground').slice(0, 2);
    return answer;
  }
  return {
    reply: 'Я помогу перестроить прогулку: могу убрать точку, сократить день, найти туалет, кафе для детей или площадку. Что случилось?',
    preview: null, places: [], suggestions: DEFAULT_SUGGESTIONS,
  };
}

export { DEFAULT_SUGGESTIONS };
