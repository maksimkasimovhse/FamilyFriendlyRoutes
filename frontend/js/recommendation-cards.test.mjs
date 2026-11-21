import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateCard, manualSelection, pickConfiguration, withinCardRadius, planningPolicyForSelections } from './recommendation-cards.js';

const candidate = {
  place:{place_id:'place-ml',categories:['museum'],location:{coordinates:[44,56],label:null}},
  activity:{activity_id:'activity-ml',title:'Музей',kind:'visit',duration:{duration_sec:1800}},
  availability:[{date:'2030-06-15',occurrences:[]}],reasons:[{message:'Подходит по интересам'}],
};
test('manual cards preserve ML identity and explicit date instead of presentation IDs', () => {
  const card=candidateCard(candidate,'2030-06-15');
  assert.deepEqual(manualSelection(card),{activity_id:'activity-ml',place_id:'place-ml',occurrence_id:null,mandatory:false,preferred_date:'2030-06-15'});
  assert.equal(card.image,null);
});
test('manual selection does not request automatic filling; skipping selection does',()=>{
  assert.equal(planningPolicyForSelections([manualSelection(candidateCard(candidate,'2030-06-15'))]),'manual_choices');
  assert.equal(planningPolicyForSelections([]),'ranked_prefix');
});
test('after the first empty-day pick, subsequent choices stay within 2 km', () => {
  const config=pickConfiguration({policy:{manual_limit_per_day:2,supplement_radius_m:2000},days:[{date:'2030-06-15',is_short:true,remaining_manual_choices:2,anchor:null,candidates:[candidate]}]},{supplemental:true});
  assert.equal(config.days[0].anchorOnFirstPick,true);
  assert.equal(withinCardRadius([44,56],[44.01,56],config.days[0].radiusM),true);
  assert.equal(withinCardRadius([44,56],[44.1,56],config.days[0].radiusM),false);
});
test('supplemental choices use remaining quota per short day', () => {
  const options={candidates:[candidate],policy:{manual_limit_per_day:2},days:[
    {date:'2030-06-15',is_short:true,remaining_manual_choices:1,candidates:[candidate]},
    {date:'2030-06-16',is_short:true,remaining_manual_choices:0,candidates:[candidate]},
    {date:'2030-06-17',is_short:false,remaining_manual_choices:2,candidates:[candidate]},
  ]};
  assert.deepEqual(pickConfiguration(options,{supplemental:true}).days.map(({date,limit})=>({date,limit})),[{date:'2030-06-15',limit:1}]);
  const initial=pickConfiguration(options,{selected:[candidateCard(candidate,'2030-06-15')]});
  assert.deepEqual(initial.days,[]);
  assert.equal(initial.tripLimit,6);
  assert.equal(initial.cards.length,1);
  assert.equal(manualSelection(initial.selected[0]).preferred_date,null);
});
