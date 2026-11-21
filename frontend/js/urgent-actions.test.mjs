import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runUrgentAction, urgentCandidates, urgentKind, walkingDirections} from './urgent-actions.js';
import {loadNearbyBenches, clearNearbyBenches, allPlaces, fetchNearestPlaces} from './places.js';

const origin=[44,56];
const fact=value=>({state:'known',value,evidence_ids:[]});
const place=(id,category,offset=0,extras={})=>({place_id:id,name:id,categories:[category],location:{coordinates:[44+offset,56]},indoor:{state:'unknown'},shelter:{state:'unknown'},...extras});
test('nearest search continues past unsuitable objects and returns three without a radius',async()=>{
  const original=globalThis.fetch;const requests=[];
  try {
    globalThis.fetch=async raw=>{
      const url=new URL(raw,'http://localhost');requests.push(url);
      const second=url.searchParams.has('cursor');
      return {ok:true,json:async()=>({items:second?[place('b','restaurant',.1),place('c','restaurant',.2)]:[place('bad','restaurant',0,{indoor:fact(false)}),place('a','restaurant',.01)],evidence:[],next_cursor:second?null:'page2'})};
    };
    const result=await fetchNearestPlaces({lon:44,lat:56,categories:['restaurant'],accept:p=>p.indoor.value!==false});
    assert.deepEqual(result.items.map(p=>p.place_id),['a','b','c']);
    assert.equal(requests[0].searchParams.get('nearest'),'true');
    assert.equal(requests[0].searchParams.get('limit'),'3');
    assert.equal(requests[0].searchParams.has('radius_km'),false);
    assert.equal(requests[1].searchParams.get('cursor'),'page2');
  } finally {globalThis.fetch=original;}
});
test('all five urgent buttons dispatch directly',()=>{
  assert.deepEqual(['Ребёнок устал','Нужен туалет','Хотим поесть','Пошёл дождь','Пропусти следующую точку'].map(urgentKind),['rest','toilet','food','rain','skip']);
});
test('toilet search uses live GPS and the nearest API, not route places',async()=>{
  let query;
  const answer=await runUrgentAction('toilet',{getPosition:async()=>origin,search:async q=>{query=q;return {items:[place('near','toilet',.001),place('far','toilet',.1),place('wrong','bench')]};}});
  assert.equal(query.lon,44);assert.equal(query.lat,56);assert.equal(query.count,3);assert.equal(query.radiusKm,undefined);assert.deepEqual(query.categories,['toilet']);
  assert.deepEqual(answer.places.map(p=>p.place_id),['near','far']);
  assert.deepEqual(answer.places[0].urgent_origin,origin);
});
test('location denial does not substitute route start or perform a search',async()=>{
  let searched=false;
  await assert.rejects(runUrgentAction('food',{getPosition:async()=>{throw Error('denied');},search:async()=>{searched=true;}}),/denied/);
  assert.equal(searched,false);
});
test('rest suggests nearest benches without a distance cutoff and never removes a stop',async()=>{
  const answer=await runUrgentAction('rest',{getPosition:async()=>origin,remove:()=>assert.fail('must not remove'),search:async q=>{
    assert.equal(q.count,3);assert.equal(q.radiusKm,undefined);return {items:[place('seat','bench',.001),place('far','bench',.003),place('play','playground')]};
  }});
  assert.deepEqual(answer.places.map(p=>p.place_id),['seat','far']);
  assert.equal(answer.preview,undefined);
});
test('rain ranks by distance and marks unknown cafes explicitly',()=>{
  const candidates=urgentCandidates([place('unknown','restaurant'),place('outside','restaurant',0,{indoor:fact(false)}),place('covered','park',.001,{shelter:fact(true)})],'rain',origin,500);
  assert.deepEqual(candidates.map(p=>p.place_id),['unknown','covered']);
  assert.match(candidates[0].urgent_note,/не подтверждена/);
});
test('skip previews the next planned stop from the confirmed route position',async()=>{
  let saved=false;
  const preview={preview_id:'preview-only'};
  const answer=await runUrgentAction('skip',{day:{execution:{},stops:[{stop_id:'done',progress:'visited'},{stop_id:'next',title:'Музей',progress:'planned'}]},getPosition:async()=>origin,remove:async(id,point)=>{assert.equal(id,'next');assert.equal(point,null);return preview;},apply:()=>{saved=true;}});
  assert.equal(answer.preview,preview);assert.equal(saved,false);
});
test('mandatory next stop cannot be skipped',async()=>{
  const answer=await runUrgentAction('skip',{day:{stops:[{stop_id:'next',title:'Сеанс',progress:'planned',mandatory:true}]},remove:()=>assert.fail('mandatory')});
  assert.match(answer.reply,/обязательная/);assert.equal(answer.preview,undefined);
});
test('walking link preserves latitude/longitude and uses pedestrian mode',()=>{
  const url=new URL(walkingDirections(origin,[44.01,56.01]));
  assert.equal(url.searchParams.get('rtext'),'56,44~56.01,44.01');assert.equal(url.searchParams.get('rtt'),'pd');
});
test('late GPS results cannot restore benches around the previous position',async()=>{
  const original=globalThis.fetch;let release;
  try {
    globalThis.fetch=async raw=>{
      const url=new URL(raw,'http://localhost');
      assert.deepEqual(url.searchParams.getAll('categories'),['bench']);assert.equal(url.searchParams.get('radius_km'),'0.125');
      const lon=Number(url.searchParams.get('lon'));
      const response={ok:true,json:async()=>({items:[place(String(lon),'bench',lon-44)],evidence:[],next_cursor:null})};
      return lon===44?new Promise(resolve=>{release=()=>resolve(response);}):response;
    };
    const old=loadNearbyBenches(origin);await loadNearbyBenches([44.01,56]);release();await old;
    assert.deepEqual(allPlaces().map(p=>p.place_id),['44.01']);
    clearNearbyBenches();assert.deepEqual(allPlaces(),[]);
  } finally {clearNearbyBenches();globalThis.fetch=original;}
});

test('nearest toilet search fills three unique objects across duplicate pages',async()=>{
 const original=globalThis.fetch;let calls=0;
 try {
  globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>calls===1?{items:[place('one','toilet',.001),place('one','toilet',.001),place('one','toilet',.001)],evidence:[],next_cursor:'more'}:{items:[place('two','toilet',.002),place('three','toilet',.003)],evidence:[],next_cursor:null}};};
  const answer=await runUrgentAction('toilet',{getPosition:async()=>origin});
  assert.deepEqual(answer.places.map(p=>p.place_id),['one','two','three']);
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
