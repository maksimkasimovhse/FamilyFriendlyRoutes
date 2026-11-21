import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(preview){
 const element=()=>({hidden:true,open:false,innerHTML:'',dataset:{},attributes:{},classList:{toggle(){},remove(){}},setAttribute(k,v){this.attributes[k]=v},getAttribute(k){return this.attributes[k]},querySelectorAll(){return []},addEventListener(){},close(){this.open=false},replaceChildren(){},focus(){},click(){this.onclick?.()}});
 const ids=new Map(),byId=id=>{if(!ids.has(id))ids.set(id,element());return ids.get(id)};
 const buttons=['rest','toilet','pharmacy','food','park','playground','skip'].map(kind=>({...element(),dataset:{urgentKind:kind}}));
 const filters=[],applied=[];
 const context={document:{getElementById:byId,querySelectorAll:()=>buttons,querySelector:()=>element()},runUrgentAction:async kind=>{assert.equal(kind,'skip');return {preview}},urgentKind(){return null},placeEmojiHtml(){return ''},onTripChange(){},getSource(){return 'backend'},applyPreview:async(p,acks)=>applied.push({p,acks})};
 vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('./map-actions.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export function /g,'function '),context);
 context.initMapActions({onFilter:keys=>filters.push(Array.from(keys))});
 return {context,buttons,byId,filters,applied};
}

test('category buttons combine and removing one keeps the other categories',async()=>{
 const f=fixture();await f.buttons[1].onclick();await f.buttons[2].onclick();await f.buttons[4].onclick();await f.buttons[5].onclick();
 assert.deepEqual(f.filters.at(-1),['toilet','pharmacy','park','playground']);
 await f.buttons[1].onclick();assert.deepEqual(f.filters.at(-1),['pharmacy','park','playground']);
 assert.equal(f.buttons[2].getAttribute('aria-pressed'),'true');assert.equal(f.buttons[1].getAttribute('aria-pressed'),'false');
 assert.equal(f.byId('map-action-panel').hidden,true);
 const markup=f.byId('map-action-chips').innerHTML;assert.match(markup,/Парки/);assert.match(markup,/Площадки/);assert.doesNotMatch(markup,/дождя|Погод/);
});

test('skip confirmation shows only total reduction, no checkbox, and applies required acknowledgements',async()=>{
 const p={can_apply:true,diff:{elapsed_delta_sec:-4020,walk_delta_sec:-1320},required_acknowledgement_codes:['SNAPPED_ENDPOINTS','DURATION_ESTIMATED']};
 const f=fixture(p);await f.buttons[6].onclick();
 const markup=f.byId('map-action-content').innerHTML;
 assert.match(markup,/Маршрут сократится на 67 мин/);assert.doesNotMatch(markup,/checkbox|data-ack|ходьбы|Уберём|ПРОВЕРЬТЕ/);
 assert.equal(f.byId('urgent-apply').disabled,false);await f.byId('urgent-apply').onclick();
 assert.equal(f.applied.length,1);assert.deepEqual(f.applied[0].acks,p.required_acknowledgement_codes);
});

test('removing checkboxes does not permit applying an infeasible preview',async()=>{
 const f=fixture({can_apply:false,diff:{elapsed_delta_sec:-600},required_acknowledgement_codes:[]});await f.buttons[6].onclick();assert.equal(f.byId('urgent-apply').disabled,true);
});

test('map shows the union of selected amenity layers',()=>{
 const visible=new Map();
 const chips=['all','bench','toilets','pharmacy','cafe','park','playground'].map(layer=>({dataset:{layer},getAttribute:()=> 'true'}));
 const context={document:{getElementById(){return {}},querySelectorAll(){return chips}},testMap:{setFilter(){},setLayoutProperty(id,key,value){visible.set(id,value)}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('./map.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async )?function /g,(_,a)=>(a||'')+'function ')+'\nmap=testMap;amenityFilters=new Set(["toilet","park","playground"]);applyChips();',context);
 assert.equal(visible.get('amenity-toilets'),'visible');assert.equal(visible.get('amenity-park'),'visible');assert.equal(visible.get('amenity-playground'),'visible');assert.equal(visible.get('amenity-cafe'),'none');
});
