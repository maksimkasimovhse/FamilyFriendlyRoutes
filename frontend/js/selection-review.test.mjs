import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionReview} from './selection-review.js';
const make=()=>({input:{selections:['a','b','c','d'].map(activity_id=>({activity_id}))},days:[{stops:[{activity_id:'a'}]},{stops:[{activity_id:'b'},{activity_id:'c'}]}],recommendation_snapshot:{candidates:['a','b','c','d'].map(id=>({activity:{activity_id:id,title:'Место '+id}}))}});
test('review counts unscheduled choices across all days and retains full removable list',()=>{const r=selectionReview(make());assert.equal(r.excludedCount,1);assert.equal(r.cards.length,4);assert.deepEqual(r.cards.filter(c=>c.missing).map(c=>c.title),['Место d']);});
test('after deleting excess choice no exclusions remain',()=>{const t=make();t.input.selections.pop();assert.equal(selectionReview(t).excludedCount,0);});

test('short day does not turn a walking exclusion into a time warning',()=>{const t=make();t.days[0].totals={elapsed_duration_sec:600};t.warnings=[{code:'CANDIDATE_NOT_SCHEDULED',activity_id:'d',message:'Место не включено в маршрут поездки. При проверке вариантов: превышен дневной лимит пешего расстояния.'}];const r=selectionReview(t);assert.equal(r.excludedCount,1);assert.match(r.cards.find(c=>c.missing).reason,/пешего расстояния/);assert.doesNotMatch(r.cards.find(c=>c.missing).reason,/не успеете/);});
test('legacy generic exclusion does not assert insufficient time',()=>{const t=make();t.warnings=[{code:'CANDIDATE_NOT_SCHEDULED',activity_id:'d',message:'Место не включено: max(0, min(M, V×T) − P)'}];assert.match(selectionReview(t).cards.find(c=>c.missing).reason,/Причина не уточнена/);});
