import { fetchNearestPlaces, distanceM, loadNearbyBenches } from './places.js';
import { currentPosition } from './geolocation.js';
import { today, previewRemove } from './api.js';

export const URGENT_ACTIONS = ['Ребёнок устал','Нужен туалет','Нужна аптека','Хотим поесть','Пошёл дождь','Пропусти следующую точку'];
export function urgentKind(message) {
  const text=message.toLowerCase();
  if (/пропус.*следующ/.test(text)) return 'skip';
  if (/устал|сил нет|тяжело идти/.test(text)) return 'rest';
  if (/аптек/.test(text)) return 'pharmacy';
  if (/площадк|поиграть/.test(text)) return 'playground';
  if (/туалет|санузел|пописать/.test(text)) return 'toilet';
  if (/поесть|голод|перекус|обед|ужин/.test(text)) return 'food';
  if (/дожд|ливень|промок/.test(text)) return 'rain';
  return null;
}
const knownTrue = fact => fact?.state === 'known' && fact.value === true;
const knownFalse = fact => fact?.state === 'known' && fact.value === false;
export function urgentCandidates(items, kind, origin, radiusM=Infinity) {
  const seen=new Set();
  return items.filter(p=>{
    if (seen.has(p.place_id)) return false;
    seen.add(p.place_id);
    const categories=p.categories;
    if (kind==='rest' && !categories.includes('bench')) return false;
    if (kind==='toilet' && !categories.includes('toilet')) return false;
    if (kind==='food' && !categories.includes('restaurant')) return false;
    if (kind==='pharmacy' && !categories.includes('pharmacy')) return false;
    if (kind==='playground' && !categories.includes('playground')) return false;
    if (kind==='rain' && !knownTrue(p.indoor) && !knownTrue(p.shelter) && (!categories.includes('restaurant') || knownFalse(p.indoor))) return false;
    return distanceM(origin,p.location.coordinates)<=radiusM;
  }).map(p=>({...p,urgent_origin:origin,urgent_distance_m:distanceM(origin,p.location.coordinates),
    urgent_note:kind==='rain' ? knownTrue(p.indoor) || knownTrue(p.shelter) ? 'Помещение или укрытие отмечено в каталоге; доступность проверьте на месте.' : 'Кафе: возможность укрыться не подтверждена.' : 'Часы работы и доступность сейчас не подтверждены.'}))
    .sort((a,b)=>{
      return a.urgent_distance_m-b.urgent_distance_m;
    }).slice(0,3);
}
export function walkingDirections(origin, destination) {
  return 'https://yandex.ru/maps/?'+new URLSearchParams({rtext:`${origin[1]},${origin[0]}~${destination[1]},${destination[0]}`,rtt:'pd'});
}
export async function runUrgentAction(kind, dependencies={}) {
  const getPosition=dependencies.getPosition || currentPosition;
  const search=dependencies.search || fetchNearestPlaces;
  const day=dependencies.day || today();
  if(kind==='skip') {
    const stop=day.stops.find(s=>s.progress==='planned');
    if(!stop)return {reply:'Все точки уже пройдены — пропускать нечего.',places:[],suggestions:URGENT_ACTIONS};
    if(stop.mandatory)return {reply:`«${stop.title}» — обязательная точка. Её нельзя пропустить этой командой.`,places:[],suggestions:URGENT_ACTIONS};
    const position=null; // Keep the confirmed route history; a skip does not infer a GPS track.
    const preview=await (dependencies.remove || previewRemove)(stop.stop_id,position);
    return {reply:`Предлагаю пропустить «${stop.title}». Пройденные точки сохранятся. Посмотрите изменения и подтвердите применение.`,preview,places:[],suggestions:URGENT_ACTIONS};
  }
  const origin=await getPosition();
  const categories=kind==='rest'?['bench']:kind==='toilet'?['toilet']:kind==='food'?['restaurant']:kind==='pharmacy'?['pharmacy']:kind==='playground'?['playground']:['restaurant','park','playground'];
  if(kind==='rest' && !dependencies.search)await loadNearbyBenches(origin).catch(err=>console.warn('Скамейки на карте:',err));
  const accept=p=>urgentCandidates([p],kind,origin).length>0;
  const data=await search({lon:origin[0],lat:origin[1],categories,count:3,accept});
  const places=urgentCandidates(data.items,kind,origin);
  const descriptions={rest:'Три ближайшие скамейки для отдыха',toilet:'Три ближайших туалета',food:'Три ближайших кафе или ресторана',pharmacy:'Три ближайшие аптеки',playground:'Три ближайшие площадки',rain:'Три ближайших места, где можно попробовать переждать дождь'};
  return {reply:places.length?`${descriptions[kind]}. Расстояние — по прямой, время ходьбы приблизительное. Маршрут поездки пока не меняется.`:
    'Подходящих объектов в базе не нашлось. Попробуйте другой сценарий.',
    places,suggestions:kind==='rest'||kind==='rain'?['Хотим поесть','Пропусти следующую точку','Нужен туалет']:URGENT_ACTIONS};
}
