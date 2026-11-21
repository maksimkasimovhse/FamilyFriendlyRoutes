// Live isolated guest fixture: real PostgreSQL pharmacy + OSM routing + preview/apply.
import fs from 'node:fs';
const base=process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const session=await fetch(base+'/api/v1/session');
if(!session.ok)throw Error('Session unavailable');
const cookie=session.headers.getSetCookie()[0].split(';')[0],csrf=(await session.json()).csrf_token;
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(r.status+' '+JSON.stringify(value));return value;}
const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));
input.planning_policy='manual_choices';input.request_text=null;input.selections=[];input.load_limits.max_walk_distance_m_per_day=8000;
input.days=[{...input.days[0],date:'2030-06-15',available_window:null,duration_budget_sec:10800,meal_count:0,meal_duration_sec:0,rest_budget_sec:0}];
const draft=await post('/api/v1/trips',input);
const options=await post(`/api/v1/trips/${draft.trip_id}/planning-options`,{expected_version:draft.version});
const card=options.candidates[0];input.days[0].start_point=card.place.entrance||card.place.location;input.days[0].end_point=input.days[0].start_point;
input.selections=[{activity_id:card.activity.activity_id,place_id:card.place.place_id,occurrence_id:null,mandatory:false,preferred_date:null}];
let trip=await post('/api/v1/trips',input);const root='/api/v1/trips/'+trip.trip_id;
const preview=await post(root+'/previews',{expected_version:trip.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
trip=await post(root+'/previews/'+preview.preview_id+'/apply',{expected_version:preview.base_version,acknowledged_warning_codes:preview.required_acknowledgement_codes});
const [lon,lat]=input.days[0].start_point.coordinates;
const nearest=await fetch(base+'/api/v1/map/places?'+new URLSearchParams({lon,lat,nearest:true,categories:'pharmacy',limit:3}));
const pharmacies=await nearest.json();if(!nearest.ok||pharmacies.items.length!==3)throw Error('Need three real pharmacies');
const urgent=await post(root+'/previews',{expected_version:trip.version,command:{kind:'insert_infrastructure_stop',date:trip.days[0].date,place_id:pharmacies.items[0].place_id},current_position:input.days[0].start_point,observed_at:new Date().toISOString()});
if(!urgent.can_apply || urgent.proposed_trip.days[0].stops[0].place_id!==pharmacies.items[0].place_id)throw Error('Pharmacy preview not first or not applicable');
trip=await post(root+'/previews/'+urgent.preview_id+'/apply',{expected_version:urgent.base_version,acknowledged_warning_codes:urgent.required_acknowledgement_codes});
const edited=await post(root+'/previews',{expected_version:trip.version,command:{kind:'edit_route',date:trip.days[0].date,text:'убери последнюю точку'},current_position:null,observed_at:null});
if(!edited.can_apply || edited.diff.removed_stop_ids.length!==1)throw Error('Text edit did not preview removal');
console.log(JSON.stringify({status:'passed',pharmacies:pharmacies.items.length,pharmacy_saved:trip.days[0].stops[0].category==='pharmacy',stops:trip.days[0].stops.length,text_removed:edited.diff.removed_stop_ids.length,version:trip.version}));
