// Regression: distribute manual selections across all requested days using real ML/OSM.
import fs from 'node:fs';
const base=process.env.BACKEND_URL||'http://127.0.0.1:8000';
const session=await fetch(base+'/api/v1/session');if(!session.ok)throw Error('Session unavailable');
const cookie=session.headers.getSetCookie()[0].split(';')[0],csrf=(await session.json()).csrf_token;
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const value=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(value));return value;}
const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));
input.family.children=[{child_id:'balance-child',age_years:7,height_cm:null,interest_ids:['history']}];input.family.adult_interest_ids=[];
input.planning_policy='manual_choices';input.request_text=null;input.selections=[];input.load_limits.max_walk_distance_m_per_day=5000;
input.days=Array.from({length:5},(_,i)=>({...input.days[0],date:'2030-06-'+(15+i),available_window:null,duration_budget_sec:21600,meal_count:0,meal_duration_sec:0,rest_budget_sec:0}));
const draft=await post('/api/v1/trips',input);
const options=await post('/api/v1/trips/'+draft.trip_id+'/planning-options',{expected_version:draft.version});
const start=input.days[0].start_point.coordinates;
const nearby=options.candidates.filter(c=>{const p=c.place.location.coordinates;return c.activity.kind!=='session' && c.activity.duration.duration_sec<=7200 && Math.hypot((p[0]-start[0])*62000,(p[1]-start[1])*111000)<1500;}).slice(0,10);
if(nearby.length<10)throw Error('Need ten nearby cultural fixtures');
input.selections=nearby.map(c=>({activity_id:c.activity.activity_id,place_id:c.place.place_id,occurrence_id:null,mandatory:false,preferred_date:null}));
const trip=await post('/api/v1/trips',input);
const preview=await post('/api/v1/trips/'+trip.trip_id+'/previews',{expected_version:trip.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
const days=preview.proposed_trip.days,ids=days.flatMap(d=>d.stops.map(s=>s.place_id));
const summary=days.map(d=>({date:d.date,stops:d.stops.length,minutes:Math.round(d.totals.elapsed_duration_sec/60),meters:Math.round(d.totals.walk_distance_m)}));
if(!preview.can_apply || days.length!==5 || days.some(d=>!d.stops.length || d.totals.elapsed_duration_sec>21600) || ids.length!==10 || new Set(ids).size!==10)throw Error('Invalid balanced result: '+JSON.stringify(summary));
console.log(JSON.stringify({status:'passed',days:summary}));
