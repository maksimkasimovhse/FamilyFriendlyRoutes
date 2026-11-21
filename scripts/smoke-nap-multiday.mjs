// Isolated guest, real ML pool and OSM: sleep is mandatory every enabled day.
import fs from 'node:fs';
const base=process.env.BACKEND_URL||'http://127.0.0.1:8000';
const session=await fetch(base+'/api/v1/session');if(!session.ok)throw Error('Session unavailable');
const cookie=session.headers.getSetCookie()[0].split(';')[0],csrf=(await session.json()).csrf_token;
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const v=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(v));return v;}
const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));input.family.children=[{child_id:'nap-child',age_years:7,height_cm:null,interest_ids:['history']}];input.family.adult_interest_ids=[];input.family.nap={start_time:'13:00',end_time:'15:00'};input.request_text=null;input.planning_context='before_arrival';input.planning_policy='manual_choices';input.selections=[];
input.days=Array.from({length:2},(_,i)=>{const date='2030-06-'+(15+i);const start=input.days[0].start_point;return {...input.days[0],date,available_window:{start_at:date+'T10:00:00+03:00',end_at:date+'T20:00:00+03:00'},duration_budget_sec:18000,nap:{location:start,window:{start_at:date+'T13:00:00+03:00',end_at:date+'T15:00:00+03:00'}}};});
const draft=await post('/api/v1/trips',input);const options=await post('/api/v1/trips/'+draft.trip_id+'/planning-options',{expected_version:draft.version});
const origin=input.days[0].start_point.coordinates;
const cards=options.candidates.filter(c=>{const p=c.place.location.coordinates;return c.activity.kind!=='session'&&c.activity.duration.duration_sec<=3600&&Math.hypot((p[0]-origin[0])*62000,(p[1]-origin[1])*111000)<1200;}).slice(0,4);
if(cards.length<4)throw Error('Need four nearby fixtures');
input.selections=cards.map(c=>({activity_id:c.activity.activity_id,place_id:c.place.place_id,occurrence_id:null,mandatory:false,preferred_date:null}));
const trip=await post('/api/v1/trips',input),root='/api/v1/trips/'+trip.trip_id;
const preview=await post(root+'/previews',{expected_version:trip.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
for(const d of preview.proposed_trip.days){const naps=d.stops.filter(s=>s.activity_kind==='nap');if(naps.length!==1||!naps[0].mandatory||d.totals.nap_duration_sec!==7200||d.totals.outing_duration_sec>18000||Date.parse(naps[0].timing.estimated_arrival_at)>Date.parse(d.nap.window.start_at)||!d.nap.latest_start_at)throw Error('Invalid nap day '+JSON.stringify(d.totals));}
if(!preview.can_apply)throw Error('Nap preview cannot apply');
await post(root+'/previews/'+preview.preview_id+'/apply',{expected_version:preview.base_version,acknowledged_warning_codes:preview.required_acknowledgement_codes});
console.log(JSON.stringify({status:'passed',days:preview.proposed_trip.days.map(d=>({date:d.date,visits:d.stops.filter(s=>s.activity_kind!=='nap').length,latest_start:d.nap.latest_start_at,outing_minutes:Math.round(d.totals.outing_duration_sec/60),sleep_minutes:d.totals.nap_duration_sec/60}))}));
