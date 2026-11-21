import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requestId} from './request-id.js';
import {finishInstant} from './route-time.js';

test('HTTP origin creates distinct request IDs without randomUUID',()=>{
  let value=0;
  const crypto={getRandomValues: bytes=>{bytes.fill(++value);return bytes;}};
  assert.notEqual(requestId(crypto),requestId(crypto));
  assert.match(requestId(crypto),/^[0-9a-f]{32}$/);
});
test('finish includes reserved meals/rest and active-day elapsed time',()=>{
  const day={available_window:{start_at:'2030-06-15T10:00:00+03:00'},totals:{elapsed_duration_sec:3600+4500}};
  assert.equal(finishInstant(day),'2030-06-15T09:15:00.000Z');
  day.execution={started_at:'2030-06-15T11:00:00+03:00'};
  assert.equal(finishInstant(day),'2030-06-15T10:15:00.000Z');
});
test('initial wishes and active assistant forms have unique IDs',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size);
  assert.ok(html.includes('id="wish-chat-form"'));
});
