import {getTrip,getSource,onTripChange,applyPreview,askRouteAssistant} from './api.js';
import {runUrgentAction,urgentKind} from './urgent-actions.js';
import {placeEmojiHtml} from './place-display.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actions=[['rest','Скамейка','bench'],['toilet','Туалет','toilet'],['pharmacy','Аптека','pharmacy'],['food','Поесть','restaurant'],['rain','От дождя','landmark'],['skip','Пропустить точку','pin']];
let hooks={},revision=0,applying=false,inlineMode=false,activeCategory=null;
const output=()=>$(inlineMode?'map-action-content':'urgent-content');
function title(text){$(inlineMode?'map-action-title':'urgent-title').textContent=text;}
function content(html){output().innerHTML=html;}
function status(text){content(`<p class="urgent-status">${esc(text)}</p>`);}
function open(title='Что нужно сейчас?') {
 revision++;hooks.onCancel?.();
 inlineMode=false;$('map-action-panel').hidden=true;$('map-action-content').replaceChildren();
 $('urgent-title').textContent=title;
 if(!$('urgent-dialog').open)$('urgent-dialog').showModal();
}
function close(){revision++;$('urgent-dialog').close();$('map-action-panel').hidden=true;inlineMode=false;hooks.onCancel?.();document.querySelectorAll('[data-urgent-kind]').forEach(button=>{const active=button.dataset.urgentKind===activeCategory;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});}
function openInline(label){
 revision++;hooks.onCancel?.();$('urgent-dialog').close();$('urgent-content').replaceChildren();inlineMode=true;
 $('map-action-panel').hidden=false;title(label);
 if($('map-sheet-content').hidden)$('map-sheet-toggle').click();
 $('map-sheet-content').scrollTop=0;
}
export function openUrgentWidget(){close();if($('map-sheet-content').hidden)$('map-sheet-toggle').click();$('map-sheet-content').scrollTop=0;document.querySelector('[data-urgent-kind]')?.focus();}
function error(err){status(err.message || 'Не удалось рассчитать изменение. Попробуйте ещё раз.');}
function showPreview(preview,label='Изменение маршрута') {
 title(label);
 hooks.onPreview?.(preview);
 const old=new Map(getTrip().days.flatMap(d=>d.stops.map(s=>[s.stop_id,s.title])));
 const next=new Map(preview.proposed_trip.days.flatMap(d=>d.stops.map(s=>[s.stop_id,s.title])));
 const lines=[...preview.diff.added_stop_ids.map(id=>'Добавим: '+(next.get(id)||'заход')),...preview.diff.removed_stop_ids.map(id=>'Уберём: '+(old.get(id)||'остановку'))];
 if(preview.diff.elapsed_delta_sec)lines.push(`${preview.diff.elapsed_delta_sec>0?'Дольше':'Короче'} на ${Math.round(Math.abs(preview.diff.elapsed_delta_sec)/60)} мин`);
 if(preview.diff.walk_delta_sec)lines.push(`${preview.diff.walk_delta_sec>0?'Больше':'Меньше'} ходьбы на ${Math.round(Math.abs(preview.diff.walk_delta_sec)/60)} мин`);
 const warnings=new Map((preview.warnings||[]).map(w=>[w.code,w.message]));
 content(`<div class="urgent-preview"><p class="urgent-kicker">ПРОВЕРЬТЕ ИЗМЕНЕНИЯ</p><ul>${(lines.length?lines:['Пересчитаем оставшийся путь']).map(line=>`<li>${esc(line)}</li>`).join('')}</ul>
 ${!preview.can_apply?'<p class="urgent-error">Такой заход не помещается в доступное время или часы работы. Уберите одну из следующих точек или выберите другое место.</p>':''}
 ${(preview.required_acknowledgement_codes||[]).map(code=>`<label class="urgent-ack"><input type="checkbox" data-ack="${esc(code)}"><span>${esc(warnings.get(code)||code)}</span></label>`).join('')}
 <div class="urgent-preview-actions"><button type="button" class="btn alt" id="urgent-cancel-preview">Оставить как было</button><button type="button" class="btn main" id="urgent-apply">Применить маршрут</button></div></div>`);
 $('urgent-cancel-preview').onclick=close;
 const boxes=[...output().querySelectorAll('[data-ack]')];
 const update=()=>{$('urgent-apply').disabled=!preview.can_apply||boxes.some(box=>!box.checked);};boxes.forEach(box=>box.onchange=update);update();
 $('urgent-apply').onclick=async()=>{
  $('urgent-apply').disabled=true;applying=true;
  try{await applyPreview(preview,boxes.filter(box=>box.checked).map(box=>box.dataset.ack));close();}
  catch(err){error(err);}finally{applying=false;}
 };
}
function selectCategory(kind){
 const next=activeCategory===kind?null:kind;
 close();activeCategory=next;hooks.onFilter?.(next);
 document.querySelectorAll('[data-urgent-kind]').forEach(button=>{const active=button.dataset.urgentKind===next;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
}
function showAssistantPlaces(answer){
 content(`${answer.reply?`<p class="urgent-results-hint">${esc(answer.reply)}</p>`:''}<p class="urgent-results-hint">Выберите место — сначала покажем, как оно изменит маршрут.</p><div class="urgent-results">${answer.places.map((p,i)=>`<button type="button" class="urgent-place" data-choice="${i+1}"><span><b>${esc(p.name)}</b><small>${answer.options?.[i] ? `~${Math.ceil(answer.options[i].walk_duration_sec/60)} мин пешком · ` : ''}подтвердите добавление после расчёта</small></span><span class="urgent-place-action">Выбрать <span aria-hidden="true">→</span></span></button>`).join('')}</div><p class="urgent-footnote">Помощник предлагает только места из каталога. Маршрут изменится после проверки и подтверждения.</p>`);
 output().querySelectorAll('[data-choice]').forEach(button=>{button.onclick=()=>chooseAssistantPlace(Number(button.dataset.choice));});
}
async function showAssistantAnswer(answer,title='Изменить маршрут'){
 if(answer.preview){showPreview(answer.preview,title);return;}
 if(answer.places?.length){showAssistantPlaces(answer);return;}
 status(answer.reply || 'Подходящих мест не нашлось. Попробуйте уточнить запрос.');
}
async function chooseAssistantPlace(number){
 const ticket=++revision;status('Проверяем выбранное место и пересчитываем маршрут…');
 try{
  const answer=await askRouteAssistant(`Добавь вариант ${number}`);if(ticket!==revision)return;
  await showAssistantAnswer(answer,'Добавить точку в маршрут');
 }catch(err){if(ticket===revision)error(err);}
}
async function askAssistant(text){
 const ticket=++revision;hooks.onCancel?.();status('Ищем подходящие места и проверяем маршрут…');
 try{
  if(getSource()!=='backend')throw Error('Для изменения нужен сохранённый маршрут и подключение к серверу.');
  const answer=await askRouteAssistant(text);if(ticket!==revision)return;
  await showAssistantAnswer(answer,'Изменение маршрута');
 }catch(err){if(ticket===revision)error(err);}
}
async function submitAssistantRequest(text){
 open('Помощник по маршруту');$('urgent-kinds').hidden=true;const ticket=revision;status('Разбираем просьбу и проверяем маршрут…');
 try{
  const kind=urgentKind(text);if(kind && actions.some(action=>action[0]===kind)){$('urgent-kinds').hidden=false;await search(kind);return;}
  if(ticket===revision)await askAssistant(text);
 }catch(err){if(ticket===revision)error(err);}
}
async function search(kind){
 if(kind!=='skip'){selectCategory(kind);return;}

 if(inlineMode && document.querySelector(`[data-urgent-kind="${kind}"]`)?.getAttribute('aria-pressed')==='true'){close();return;}
 openInline(actions.find(action=>action[0]===kind)?.[1]||'По пути');
 document.querySelectorAll('[data-urgent-kind]').forEach(button=>{const active=button.dataset.urgentKind===kind;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
 const ticket=++revision;
 $('urgent-kinds').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.kind===kind)));
 status('Рассчитываем пропуск следующей точки…');
 try{
  const answer=await runUrgentAction(kind);if(ticket!==revision)return;
  if(answer.preview)showPreview(answer.preview,'Пропустить следующую точку');
  else status(answer.reply);
 }catch(err){if(ticket===revision)error(err);}
}
export function initMapActions(options={}) {
 hooks=options;
 $('urgent-kinds').innerHTML=actions.map(([kind,label,icon])=>`<button type="button" data-kind="${kind}" aria-pressed="false">${kind==='rain'?'<span class="urgent-weather-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 19h16a5 5 0 0 0 0-10 8 8 0 0 0-15-1 6 6 0 0 0-1 11Z" fill="currentColor"/><path d="m10 23-2 4m9-4-2 4m9-4-2 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span>':placeEmojiHtml(icon)}${label}</button>`).join('');
 $('urgent-kinds').querySelectorAll('button').forEach(button=>button.onclick=()=>search(button.dataset.kind));
 $('urgent-close').onclick=close;$('map-action-close').onclick=close;
 $('map-action-chips').innerHTML=actions.map(([kind,label,icon])=>`<button type="button" class="chip" data-urgent-kind="${kind}">${kind==='rain'?'<span aria-hidden="true">☂️</span>':placeEmojiHtml(icon)}${label}</button>`).join('');
 document.querySelectorAll('[data-urgent-kind]').forEach(button=>button.onclick=()=>search(button.dataset.urgentKind));
 document.querySelector('.chip[data-layer="all"]').addEventListener('click',()=>{if(inlineMode)close();});
 $('urgent-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
 $('urgent-dialog').addEventListener('click',event=>{if(event.target===$('urgent-dialog')){const rect=$('urgent-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}});
 $('map-edit-toggle').onclick=()=>{const form=$('map-edit-form');form.hidden=!form.hidden;$('map-edit-toggle').setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden){form.scrollIntoView({block:'nearest'});$('map-edit-text').focus({preventScroll:true});}};
 $('map-edit-form').onsubmit=async event=>{event.preventDefault();const text=$('map-edit-text').value.trim();if(text)await submitAssistantRequest(text);};
 document.querySelectorAll('[data-assistant-prompt]').forEach(button=>button.onclick=async()=>{const text=button.dataset.assistantPrompt;$('map-edit-text').value=text;await submitAssistantRequest(text);});
 onTripChange(()=>{if(!applying&&($('urgent-dialog').open||!$('map-action-panel').hidden)){revision++;hooks.onCancel?.();status('Маршрут обновился. Выберите действие ещё раз.');}});
}
