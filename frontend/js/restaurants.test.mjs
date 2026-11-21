import test from 'node:test';
import assert from 'node:assert/strict';
import { restaurantBadges, restaurantCardModel, mapRestaurantWidgetModel, cardSwipeAction, restaurantCardAllowsSwipe, candidateMatchesFilters } from './restaurants.js';

const fact = (state, value) => ({state, value, evidence_ids:[]});
test('restaurant card keeps known family features and labels unknown facts', () => {
  const candidate={place:{name:'Кафе',address:'Большая Покровская',distance_m:412,description:'Семейное кафе',location:{},restaurant:{children_menu:fact('known',true),play_area:fact('known',false),small_portions:fact('unknown',null),play_area_supervision:fact('unknown',null),cuisine:['русская']}},activity:{title:'Обед'},reasons:[]};
  const model=restaurantCardModel(candidate);
  assert.equal(model.title,'Кафе');
  assert.equal(model.distance,'412 м');
  assert.equal(model.cuisine,'русская');
  assert.deepEqual(model.badges.map(({key,state})=>({key,state})),[
    {key:'high_chairs',state:'unknown'},
    {key:'children_menu',state:'yes'},
  ]);
  assert.equal(restaurantBadges(candidate.place).find(x=>x.key==='play_area').state,'no');
});

test('map widget presents the nearest family-friendly restaurant concisely', () => {
  const model = mapRestaurantWidgetModel({
    place: { name: 'Семейное кафе', distance_m: 240, restaurant: { children_menu: fact('known', true) } },
    activity: { title: 'Семейное кафе' }, reasons: [],
  });
  assert.deepEqual(model, { title: 'Семейное кафе', detail: '240 м · Детское меню' });
});

test('card swipes skip the restaurant in either direction', () => {
  assert.equal(cardSwipeAction(75), 'skip');
  assert.equal(cardSwipeAction(-75), 'skip');
  assert.equal(cardSwipeAction(30), null);
  assert.equal(cardSwipeAction(20, .3), 'skip');
});

test('card controls do not start a swipe gesture', () => {
  assert.equal(restaurantCardAllowsSwipe({closest: () => ({})}), false);
  assert.equal(restaurantCardAllowsSwipe({closest: () => null}), true);
});

test('child infrastructure filters require confirmed facilities', () => {
  const candidate = { place: { restaurant: { high_chairs: fact('known', true), children_menu: fact('unknown', null) } } };
  assert.equal(candidateMatchesFilters(candidate, {high_chairs:true}), true);
  assert.equal(candidateMatchesFilters(candidate, {children_menu:true}), false);
});
