import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlacesInRadius, fetchPlacesAlongRoute, loadRoutePlaces, clearRoutePlaces, allPlaces, kindOf } from './places.js';

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

test('corridor helper uses saved route and exactly 125 metres, not GPS', async () => {
  const original = globalThis.fetch;
  const urls = [];
  const date = '2030-06-15';
  try {
    globalThis.fetch = async raw => {
      const url = new URL(raw,'http://localhost'); urls.push(url);
      return {ok:true,json:async()=>({route_version:2,route_date:date,catalog_version:'v1',items:[{place_id:String(urls.length)}],evidence:[],next_cursor:urls.length===1?'page-2':null})};
    };
    const result = await fetchPlacesAlongRoute({tripId:'trip-1',version:2,date});
    assert.equal(result.items.length,2);
    assert.equal(urls[0].pathname,'/api/v1/trips/trip-1/map/places');
    assert.equal(urls[0].searchParams.get('buffer_m'),'125');
    assert.equal(urls[0].searchParams.has('lon'),false);
    assert.equal(urls[1].searchParams.get('expected_version'),'2');
    assert.equal(urls[1].searchParams.get('cursor'),'page-2');
    globalThis.fetch = async () => ({ok:true,json:async()=>({route_version:1,route_date:date})});
    await assert.rejects(fetchPlacesAlongRoute({tripId:'trip-1',version:2,date}), /Маршрут изменился/);
  } finally { globalThis.fetch=original; }
});

test('late response for the previous route cannot replace current infrastructure', async () => {
  const original = globalThis.fetch;
  let release;
  const date='2030-06-15';
  const response = version => ({ok:true,json:async()=>({route_version:version,route_date:date,catalog_version:'v1',items:[{place_id:String(version)}],evidence:[],next_cursor:null})});
  try {
    globalThis.fetch = async raw => {
      const version=Number(new URL(raw,'http://localhost').searchParams.get('expected_version'));
      if(version===1) return new Promise(resolve=>{release=()=>resolve(response(1));});
      return response(version);
    };
    const old=loadRoutePlaces({trip_id:'race',version:1,days:[{date}]});
    await loadRoutePlaces({trip_id:'race',version:2,days:[{date}]});
    release(); await old;
    assert.deepEqual(allPlaces().map(p=>p.place_id),['2']);
  } finally { clearRoutePlaces();globalThis.fetch=original; }
});

test('all requested infrastructure categories have map layers', () => {
  for (const [category,layer] of [['park','park'],['bench','bench'],['pharmacy','pharmacy'],['playground','playground'],['toilet','toilets']]) {
    assert.equal(kindOf({categories:[category]}),layer);
  }
});
