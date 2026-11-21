import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {placeEmoji,emojiAsset,placeEmojiHtml,thinBenches,BENCH_SPACING_M} from './place-display.js';
import {distanceM} from './places.js';
test('infrastructure types use distinct emoji',()=>{
 assert.equal(new Set(['toilet','restaurant','playground','park','bench','pharmacy'].map(placeEmoji)).size,6);
 assert.equal(placeEmoji('restaurant'),'🍽️');assert.equal(placeEmoji('unknown'),'📍');
});
test('colored category badges use local SVG assets in HTML',()=>{
 for(const kind of ['toilet','restaurant','playground','park','bench','pharmacy','museum','event','unknown']) {
  const asset=emojiAsset(kind);
  assert.ok(asset.startsWith('/assets/category-icons/'));
  const bytes=fs.readFileSync(new URL('..'+asset,import.meta.url));
  assert.ok(bytes.toString().startsWith('<svg'));
  assert.ok(bytes.toString().includes('viewBox="0 0 80 80"'));
  assert.ok(placeEmojiHtml(kind).includes('src="'+asset+'"'));
 }
 assert.equal(emojiAsset('restaurant'),'/assets/category-icons/food.svg');
});
test('bench display keeps nearest seats with at least 50 m separation',()=>{
  const bench=(id,lat,d)=>({place_id:id,categories:['bench'],location:{coordinates:[44,56+lat]},distance_m:d});
  const original=[bench('far',.0002,25),bench('closest',0,0),bench('separate',.0008,90),bench('far-duplicate',.0009,100)];
  const result=thinBenches(original,distanceM);
  assert.deepEqual(result.map(p=>p.place_id),['closest','separate']);
  assert.ok(distanceM(...result.map(p=>p.location.coordinates))>=BENCH_SPACING_M);
  assert.equal(original.length,4);
});
