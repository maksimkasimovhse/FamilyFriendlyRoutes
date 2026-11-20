import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlacesInRadius, kindOf } from './places.js';

test('radius helper loads every page and retains query filters', async () => {
  const original = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async url => {
      requests.push(new URL(url, 'http://localhost'));
      const second = requests.length === 2;
      return { ok: true, json: async () => ({ catalog_version: 'v1', items: [{place_id: second ? '2' : '1'}], evidence: [{evidence_id: 'e1'}], next_cursor: second ? null : 'next-page' }) };
    };
    const result = await fetchPlacesInRadius({ lon:44,lat:56,radiusKm:2,categories:['toilet','pharmacy'] });
    assert.deepEqual(result.items.map(p => p.place_id), ['1','2']);
    assert.equal(result.evidence.length, 1);
    assert.equal(requests[0].pathname, '/api/v1/map/places');
    assert.equal(requests[0].searchParams.get('radius_km'), '2');
    assert.equal(requests[1].searchParams.get('cursor'), 'next-page');
    assert.deepEqual(requests[1].searchParams.getAll('categories'), ['toilet','pharmacy']);
    globalThis.fetch = async () => ({ ok:false,status:503,json:async()=>({error:{message:'Каталог недоступен'}}) });
    await assert.rejects(fetchPlacesInRadius({lon:44,lat:56,radiusKm:2}), /Каталог недоступен/);
  } finally { globalThis.fetch = original; }
});

test('all requested infrastructure categories have map layers', () => {
  for (const [category,layer] of [['park','park'],['bench','bench'],['pharmacy','pharmacy'],['playground','playground'],['toilet','toilets']]) {
    assert.equal(kindOf({categories:[category]}),layer);
  }
});
