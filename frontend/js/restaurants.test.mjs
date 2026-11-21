import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantBadges, restaurantCardModel } from './restaurants.js';

const fact = (state, value) => ({state, value, evidence_ids:[]});
test('restaurant card keeps known family features and labels unknown facts', () => {
  const candidate={place:{name:'Кафе',address:'Большая Покровская',distance_m:412,description:'Семейное кафе',location:{},restaurant:{children_menu:fact('known',true),play_area:fact('known',false),small_portions:fact('unknown',null),play_area_supervision:fact('unknown',null),cuisine:['русская']}},activity:{title:'Обед'},reasons:[]};
  const model=restaurantCardModel(candidate);
  assert.equal(model.title,'Кафе');
  assert.equal(model.distance,'412 м');
  assert.equal(model.cuisine,'русская');
  assert.deepEqual(model.badges.map(({key,state})=>({key,state})),[
    {key:'children_menu',state:'yes'},
    {key:'small_portions',state:'unknown'},
    {key:'play_area_supervision',state:'unknown'},
  ]);
  assert.equal(restaurantBadges(candidate.place).find(x=>x.key==='play_area').state,'no');
});
