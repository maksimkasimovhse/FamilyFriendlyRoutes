// Regression: an unfit top-ranked venue must not block all days.
import fs from 'node:fs';
const base=process.env.BACKEND_URL||'http://127.0.0.1:8000';
for(const interests of [[],['animals'],['history']]) {
 const session=await fetch(base+'/api/v1/session');if(!session.ok)throw Error('Session unavailable');
 const cookie=session.headers.getSetCookie()[0].split(';')[0],csrf=(await session.json()).csrf_token;
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const value=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(value));return value;};
 const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));
 input.family.children=[{child_id:'regression-child',age_years:7,height_cm:null,interest_ids:interests}];input.family.adult_interest_ids=[];
 input.planning_policy='ranked_prefix';input.request_text=null;input.selections=[];input.load_limits.max_walk_distance_m_per_day=5000;
 input.days=Array.from({length:3},(_,i)=>({...input.days[0],date:'2030-06-'+(15+i),available_window:null,duration_budget_sec:14400,meal_count:0,meal_duration_sec:0,rest_budget_sec:0}));
 const draft=await post('/api/v1/trips',input);
 const preview=await post('/api/v1/trips/'+draft.trip_id+'/previews',{expected_version:draft.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
 const days=preview.proposed_trip.days,ids=days.flatMap(day=>day.stops.map(stop=>stop.place_id));
 if(!preview.can_apply||days.length!==3||days.some(day=>day.stops.length<2||day.totals.elapsed_duration_sec>14400||day.totals.walk_distance_m>5000)||new Set(ids).size!==ids.length)throw Error('Invalid multiday result: '+JSON.stringify({interests,days:days.map(d=>({stops:d.stops.length,totals:d.totals}))}));
 console.log(JSON.stringify({status:'passed',interests,stops_per_day:days.map(day=>day.stops.length)}));
}
