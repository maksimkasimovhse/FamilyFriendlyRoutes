// Every scheduled stop is a visit, including a selected cafe or rest stop.
export function routeDurationParts(day) {
 const totals=day.totals;
 const visits=(totals.visit_duration_sec||0)+(totals.meal_duration_sec||0)+(totals.rest_duration_sec||0);
 const parts=[['walk','Все переходы',totals.walk_duration_sec],['visit','Посещения',visits],['wait','Ожидание начала посещения',totals.wait_duration_sec]].filter(([,label,seconds])=>Number.isFinite(seconds)&&seconds>0).map(([kind,label,seconds])=>({kind,label,seconds}));
 const finish=[...(day.legs||[])].reverse().find(leg=>leg.to?.kind==='day_end');
 return {parts,finishSeconds:finish?.travel_duration_sec??null};
}
export function routeDurationHtml(day,format) {
 const {parts,finishSeconds}=routeDurationParts(day);
 return '<div class="route-duration" aria-label="Из чего складывается время маршрута"><dl>'+parts.map(part=>'<div><dt>'+part.label+'</dt><dd>'+format(part.seconds)+'</dd></div>').join('')+'</dl>'+(finishSeconds>0?'<p>В переходы входит путь до финиша: '+format(finishSeconds)+'.</p>':'')+'</div>';
}
