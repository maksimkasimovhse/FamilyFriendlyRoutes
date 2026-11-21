import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionReview} from './selection-review.js';
const make=()=>({input:{selections:['a','b','c','d'].map(activity_id=>({activity_id}))},days:[{stops:[{activity_id:'a'}]},{stops:[{activity_id:'b'},{activity_id:'c'}]}],recommendation_snapshot:{candidates:['a','b','c','d'].map(id=>({activity:{activity_id:id,title:'Место '+id}}))}});
test('review counts unscheduled choices across all days and retains full removable list',()=>{const r=selectionReview(make());assert.equal(r.excludedCount,1);assert.equal(r.cards.length,4);assert.deepEqual(r.cards.filter(c=>c.missing).map(c=>c.title),['Место d']);});
test('after deleting excess choice no exclusions remain',()=>{const t=make();t.input.selections.pop();assert.equal(selectionReview(t).excludedCount,0);});
