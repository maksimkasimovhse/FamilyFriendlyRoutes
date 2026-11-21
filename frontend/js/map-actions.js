import {today,getTrip,getSource,onTripChange,applyPreview,previewInfrastructure,previewRouteEdit} from './api.js';
import {runUrgentAction,urgentKind} from './urgent-actions.js';
import {currentPosition} from './geolocation.js';
import {placeEmojiHtml} from './place-display.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actions=[['rest','Ребёнок устал','bench'],['toilet','Туалет','toilet'],['pharmacy','Аптека','pharmacy'],['food','Поесть','restaurant'],['rain','Дождь','landmark'],['playground','Площадка','playground'],['skip','Пропустить точку','pin']];
const distance=m=>m<1000?`${Math.round(m)} м`:`${(m/1000).toFixed(1).replace('.',',')} км`;
let hooks={},revision=0,applying=false;
function content(html){$('urgent-content').innerHTML=html;}
function status(text){content(`<p class="urgent-status">${esc(text)}</p>`);}
function open(title='Что нужно сейчас?') {
 revision++;hooks.onCancel?.();
 $('urgent-title').textContent=title;$('urgent-toggle').setAttribute('aria-expanded','true');
 if(!$('urgent-dialog').open)$('urgent-dialog').showModal();
}
function close(){revision++;$('urgent-dialog').close();$('urgent-toggle').setAttribute('aria-expanded','false');hooks.onCancel?.();}
export function openUrgentWidget(){open();$('urgent-kinds').hidden=false;$('urgent-kinds').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed','false'));content('');}
function error(err){status(err.message || 'Не удалось рассчитать изменение. Попробуйте ещё раз.');}
function showPreview(preview,label='Изменение маршрута') {
 $('urgent-title').textContent=label;
 hooks.onPreview?.(preview);
 const old=new Map(getTrip().days.flatMap(d=>d.stops.map(s=>[s.stop_id,s.title])));
 const next=new Map(preview.proposed_trip.days.flatMap(d=>d.stops.map(s=>[s.stop_id,s.title])));
 const lines=[...preview.diff.added_stop_ids.map(id=>'Добавим: '+(next.get(id)||'заход')),...preview.diff.removed_stop_ids.map(id=>'Уберём: '+(old.get(id)||'остановку'))];
 if(preview.diff.elapsed_delta_sec)lines.push(`${preview.diff.elapsed_delta_sec>0?'Дольше':'Короче'} на ${Math.round(Math.abs(preview.diff.elapsed_delta_sec)/60)} мин`);
 if(preview.diff.walk_delta_sec)lines.push(`${preview.diff.walk_delta_sec>0?'Больше':'Меньше'} ходьбы на ${Math.round(Math.abs(preview.diff.walk_delta_sec)/60)} мин`);
 const warnings=new Map((preview.warnings||[]).map(w=>[w.code,w.message]));
 content(`<div class="urgent-preview"><p class="urgent-kicker">ПРОВЕРЬТЕ ИЗМЕНЕНИЯ</p><ul>${(lines.length?lines:['Пересчитаем оставшийся путь']).map(line=>`<li>${esc(line)}</li>`).join('')}</ul>
 ${!preview.can_apply?'<p class="urgent-error">Такой заход не помещается в доступное время или километраж. Уберите одну из следующих точек или выберите другое место.</p>':''}
 ${(preview.required_acknowledgement_codes||[]).map(code=>`<label class="urgent-ack"><input type="checkbox" data-ack="${esc(code)}"><span>${esc(warnings.get(code)||code)}</span></label>`).join('')}
 <div class="urgent-preview-actions"><button type="button" class="btn alt" id="urgent-cancel-preview">Оставить как было</button><button type="button" class="btn main" id="urgent-apply">Применить маршрут</button></div></div>`);
 $('urgent-cancel-preview').onclick=close;
 const boxes=[...$('urgent-content').querySelectorAll('[data-ack]')];
 const update=()=>{$('urgent-apply').disabled=!preview.can_apply||boxes.some(box=>!box.checked);};boxes.forEach(box=>box.onchange=update);update();
 $('urgent-apply').onclick=async()=>{
  $('urgent-apply').disabled=true;applying=true;
  try{await applyPreview(preview,boxes.filter(box=>box.checked).map(box=>box.dataset.ack));close();}
  catch(err){error(err);}finally{applying=false;}
 };
}
async function choosePlace(place){
 const ticket=++revision;status('Рассчитываем заход и оставшийся путь…');
 try{
  if(getSource()!=='backend')throw Error('Для изменения нужен сохранённый маршрут и подключение к серверу.');
  const point=await currentPosition();if(ticket!==revision)return;
  hooks.onFocus?.(place);
  const preview=await previewInfrastructure(place.place_id,point);if(ticket!==revision)return;
  showPreview(preview,'Заход: '+place.name);
 }catch(err){if(ticket===revision)error(err);}
}
function showPlaces(answer){
 content(`<div class="urgent-results">${answer.places.map((p,i)=>`<button type="button" class="urgent-place" data-place="${i}"><span class="urgent-place-number" aria-hidden="true">${i+1}</span><span class="urgent-place-info"><b>${esc(p.name)}</b>${p.address?`<small>${esc(p.address)}</small>`:''}<small>${distance(p.urgent_distance_m)} от вас · по прямой</small></span><span class="urgent-place-action">Зайти сюда <span aria-hidden="true">→</span></span></button>`).join('')}</div>`);
 $('urgent-content').querySelectorAll('[data-place]').forEach(button=>{button.onclick=()=>choosePlace(answer.places[Number(button.dataset.place)]);});
}
async function search(kind){
 const ticket=++revision;hooks.onCancel?.();
 $('urgent-kinds').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.kind===kind)));
 status(kind==='skip'?'Рассчитываем пропуск следующей точки…':'Определяем геопозицию и ищем ближайшие места…');
 try{
  const answer=await runUrgentAction(kind);if(ticket!==revision)return;
  if(answer.preview)showPreview(answer.preview,'Пропустить следующую точку');
  else if(answer.places.length)showPlaces(answer);else status(answer.reply);
 }catch(err){if(ticket===revision)error(err);}
}
export function initMapActions(options={}) {
 hooks=options;
 $('urgent-kinds').innerHTML=actions.map(([kind,label,icon])=>`<button type="button" data-kind="${kind}" aria-pressed="false">${kind==='rain'?'<span class="urgent-weather-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 19h16a5 5 0 0 0 0-10 8 8 0 0 0-15-1 6 6 0 0 0-1 11Z" fill="currentColor"/><path d="m10 23-2 4m9-4-2 4m9-4-2 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span>':placeEmojiHtml(icon)}${label}</button>`).join('');
 $('urgent-kinds').querySelectorAll('button').forEach(button=>button.onclick=()=>search(button.dataset.kind));
 $('urgent-toggle').onclick=openUrgentWidget;$('urgent-close').onclick=close;
 $('urgent-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
 $('urgent-dialog').addEventListener('click',event=>{if(event.target===$('urgent-dialog')){const rect=$('urgent-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
 $('map-edit-toggle').onclick=()=>{const form=$('map-edit-form');form.hidden=!form.hidden;$('map-edit-toggle').setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)$('map-edit-text').focus();};
 $('map-edit-form').onsubmit=async event=>{
  event.preventDefault();const text=$('map-edit-text').value.trim();if(!text)return;
  open('Изменить маршрут');$('urgent-kinds').hidden=true;const ticket=revision;status('Рассчитываем изменение…');
  try{
   const kind=urgentKind(text);if(kind){$('urgent-kinds').hidden=false;await search(kind);return;}
   if(getSource()!=='backend')throw Error('Для изменения нужен сохранённый маршрут и подключение к серверу.');
   const preview=await previewRouteEdit(text);if(ticket===revision)showPreview(preview,'Изменение маршрута');
  }catch(err){if(ticket===revision)error(err);}
 };
 onTripChange(()=>{if(!applying&&$('urgent-dialog').open){revision++;hooks.onCancel?.();status('Маршрут обновился. Выберите действие ещё раз.');}});
}
