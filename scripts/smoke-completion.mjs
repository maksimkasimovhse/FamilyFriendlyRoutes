// Integration check for the bundled mock catalog + real Valhalla. Creates test trips.
import fs from 'node:fs';
const base=process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const boot=await fetch(base+'/api/v1/session');
if(!boot.ok)throw Error('Cannot bootstrap test session');
const cookie=boot.headers.getSetCookie()[0].split(';')[0],csrf=(await boot.json()).csrf_token;
async function post(path,body){
  const response=await fetch(base+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw Error(response.status+' '+JSON.stringify(value));return value;
}
const input=JSON.parse(fs.readFileSync('examples/trip-one-day.json','utf8'));
input.selections=[];input.request_text=null;input.planning_policy='ranked_prefix';input.planning_context='before_arrival';input.load_limits.max_walk_distance_m_per_day=5000;
const point={coordinates:[43.985146,56.327401],label:'Тест дополнения: Рождественская церковь'};
input.days=[{...input.days[0],date:'2030-06-15',start_point:point,end_point:point,available_window:null,duration_budget_sec:3600,meal_count:0,meal_duration_sec:0,rest_budget_sec:0}];
const trip=await post('/api/v1/trips',input),root='/api/v1/trips/'+trip.trip_id;
const initial=await post(root+'/planning-options',{expected_version:trip.version});
if(initial.policy.manual_limit_per_day!==2 || initial.policy.short_day_ratio!==.7 || initial.policy.supplement_radius_m!==2000)throw Error('Wrong completion policy');
const preview=await post(root+'/previews',{expected_version:trip.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
const options=await post(root+'/planning-options',{expected_version:trip.version,preview_id:preview.preview_id}),day=options.days[0];
if(!day.is_short || !day.candidates.length)throw Error('This fixture requires the current bundled 11-place mock catalog and a short day with feasible supplements');
const candidate=day.candidates[0],choice={activity_id:candidate.activity.activity_id,place_id:candidate.place.place_id,occurrence_id:null,mandatory:false,preferred_date:day.date};
const next=await post(root+'/previews',{expected_version:trip.version,command:{kind:'append_manual_choices',date:day.date,choices:[choice],base_preview_id:preview.preview_id},current_position:null,observed_at:null});
if(!next.can_apply)throw Error('Supplement preview is not applicable');
const saved=await post(root+'/previews/'+next.preview_id+'/apply',{expected_version:next.base_version,acknowledged_warning_codes:next.required_acknowledgement_codes});
if(saved.input.selections.length!==1 || !saved.days[0].stops.some(s=>s.activity_id===choice.activity_id))throw Error('Supplement not persisted');
// Choosing one card must not silently add the rest of the recommendation pool.
const first=initial.candidates[0],manualInput=structuredClone(input);
manualInput.planning_policy='manual_choices';
const anchor=first.place.entrance || first.place.location;
manualInput.days[0]={...manualInput.days[0],start_point:anchor,end_point:anchor,duration_budget_sec:7200};
manualInput.selections=[{activity_id:first.activity.activity_id,place_id:first.place.place_id,occurrence_id:null,mandatory:false,preferred_date:null}];
const manualTrip=await post('/api/v1/trips',manualInput),manualRoot='/api/v1/trips/'+manualTrip.trip_id;
const manualPreview=await post(manualRoot+'/previews',{expected_version:manualTrip.version,command:{kind:'generate_plan'},current_position:null,observed_at:null});
if(manualPreview.proposed_trip.days[0].stops.length!==1)throw Error('One chosen card triggered hidden automatic filling');
const more=await post(manualRoot+'/planning-options',{expected_version:manualTrip.version,preview_id:manualPreview.preview_id});
if(!more.days[0].is_short || !more.days[0].candidates.length || more.days[0].remaining_manual_choices!==1)throw Error('Short manually chosen day did not offer cards');
console.log(JSON.stringify({status:'passed',pool:initial.candidates.length,initial_stops:preview.proposed_trip.days[0].stops.length,fill_ratio:day.fill_ratio,suggestions:day.candidates.length,saved_stops:saved.days[0].stops.length,manual_choices:saved.input.selections.length,saved_version:saved.version,explicitly_chosen:1,manual_route_stops:manualPreview.proposed_trip.days[0].stops.length,offered_extra_cards:more.days[0].candidates.length}));
