import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const base=process.env.BACKEND_URL||'http://127.0.0.1:8080';
const api=JSON.parse(fs.readFileSync('docs/contracts/openapi.json','utf8'));
// Checks the schema subset used by these responses, not the full OpenAPI document.
function validate(schema,value,path='$'){
 if(schema.$ref){let target=api;for(const key of schema.$ref.slice(2).split('/'))target=target[key];return validate(target,value,path);}
 if(schema.oneOf){let matches=0;for(const branch of schema.oneOf){try{validate(branch,value,path);matches++;}catch{}}if(matches!==1)throw Error(path+': oneOf matches '+matches);return;}
 if('const'in schema&&JSON.stringify(value)!==JSON.stringify(schema.const))throw Error(path+': const mismatch');
 if(schema.enum&&!schema.enum.includes(value))throw Error(path+': invalid enum '+value);
 const actual=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(schema.type==='integer'){if(!Number.isInteger(value))throw Error(path+': not integer');}
 else if(schema.type&&schema.type!==actual)throw Error(path+': expected '+schema.type+', got '+actual);
 if(typeof value==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)))throw Error(path+': numeric bounds');
 if(typeof value==='string'&&schema.minLength!==undefined&&value.length<schema.minLength)throw Error(path+': string too short');
 if(schema.format==='date-time'&&(!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))throw Error(path+': invalid timestamp');
 if(schema.format==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error(path+': invalid date');
 if(actual==='array'){
  if((schema.minItems!==undefined&&value.length<schema.minItems)||(schema.maxItems!==undefined&&value.length>schema.maxItems))throw Error(path+': array bounds');
  value.forEach((item,i)=>validate(schema.prefixItems?.[i]||schema.items||{},item,path+'['+i+']'));
 }
 if(actual==='object'){
  for(const key of schema.required||[])if(!(key in value))throw Error(path+'.'+key+': required');
  for(const [key,item]of Object.entries(value)){if(schema.properties?.[key])validate(schema.properties[key],item,path+'.'+key);else if(schema.additionalProperties===false)throw Error(path+'.'+key+': unknown');}
 }
}
let cookie,csrf;
async function call(method,path,body,key,expected){
 const headers={};if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;if(body!==undefined)headers['Content-Type']='application/json';if(key)headers['Idempotency-Key']=key;
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const value=await response.json();if(response.status!==expected)throw Error(method+' '+path+' returned '+response.status+': '+JSON.stringify(value));return {value,response};
}
const session=await call('GET','/api/v1/session',undefined,undefined,200);cookie=session.response.headers.getSetCookie()[0].split(';')[0];csrf=session.value.csrf_token;validate(api.components.schemas.SessionResponse,session.value);
const reference=await call('GET','/api/v1/reference-data',undefined,undefined,200);validate(api.components.schemas.ReferenceData,reference.value);
const input=JSON.parse(fs.readFileSync(process.env.TRIP_INPUT||'examples/trip-one-day.json','utf8'));validate(api.components.schemas.TripInput,input);
const createKey=randomUUID();const created=await call('POST','/api/v1/trips',input,createKey,201);validate(api.components.schemas.TripView,created.value);
const repeated=await call('POST','/api/v1/trips',input,createKey,201);if(repeated.value.trip_id!==created.value.trip_id)throw Error('create not idempotent');
const tripPath='/api/v1/trips/'+created.value.trip_id;
const preview=await call('POST',tripPath+'/previews',{expected_version:1,command:{kind:'generate_plan'},current_position:null,observed_at:null},undefined,201);validate(api.components.schemas.PlanPreview,preview.value);
if(!preview.value.can_apply)throw Error('sample plan not applicable');
const draft=await call('GET',tripPath,undefined,undefined,200);if(draft.value.version!==1||draft.value.days.length!==0)throw Error('preview mutated trip');
const applyPath=tripPath+'/previews/'+preview.value.preview_id+'/apply';
const applyBody={expected_version:1,acknowledged_warning_codes:preview.value.required_acknowledgement_codes};const applyKey=randomUUID();
const applied=await call('POST',applyPath,applyBody,applyKey,200);validate(api.components.schemas.TripView,applied.value);
const replay=await call('POST',applyPath,applyBody,applyKey,200);if(replay.value.version!==2)throw Error('apply replay changed version');
await call('POST',applyPath,applyBody,randomUUID(),409);
const saved=await call('GET',tripPath,undefined,undefined,200);validate(api.components.schemas.TripView,saved.value);if(saved.value.version!==2)throw Error('plan not saved');
if(saved.value.days.length!==input.days.length)throw Error('missing trip days');
const ids=new Set();for(const day of saved.value.days){if(day.legs.length!==day.stops.length+1)throw Error('missing legs');for(const stop of day.stops){if(ids.has(stop.place_id))throw Error('place scheduled twice');ids.add(stop.place_id);}}
const report={checked_at:new Date().toISOString(),trip_id:saved.value.trip_id,version:saved.value.version,catalog_version:saved.value.catalog_version,feasibility:saved.value.days[0].feasibility,presentation:saved.value.days[0].presentation,stops:saved.value.days[0].stops.length,legs:saved.value.days[0].legs.length,totals:saved.value.days[0].totals,geometry_points:saved.value.days[0].legs.map(l=>l.geometry.coordinates.length),checks:['response schemas','idempotent create','preview does not mutate','apply','idempotent apply','stale version rejected','read saved plan']};
report.days=saved.value.days.map(day=>({date:day.date,feasibility:day.feasibility,stops:day.stops.map(stop=>stop.activity_id),elapsed_duration_sec:day.totals.elapsed_duration_sec}));
fs.mkdirSync('data/backend',{recursive:true});fs.writeFileSync('data/backend/smoke-report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
