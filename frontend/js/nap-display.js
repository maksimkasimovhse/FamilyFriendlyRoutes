const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const napTime=iso=>iso?new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}):'';
export function napDayHtml(day){
 if(!day?.nap)return '';
 const n=day.nap;
 const completed=day.stops?.some(s=>s.activity_kind==='nap'&&s.progress==='visited');
 const heading=completed?'Дневной сон завершён':day.execution?'Вернуться в жильё к '+napTime(n.window.start_at):'Начните до '+napTime(n.latest_start_at)+', чтобы вернуться в жильё к '+napTime(n.window.start_at);
 return '<aside class="nap-day-note"><b>'+heading+'</b><p>'+napTime(n.window.start_at)+'–'+napTime(n.window.end_at)+' · Дневной сон · '+esc(n.location.label||'Жильё')+'</p><small>Расчётное время: переходы и посещения могут занять больше. Сон не входит в выбранные часы прогулки.</small></aside>';
}
