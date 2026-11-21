import {test} from 'node:test';import assert from 'node:assert/strict';import {napDayHtml} from './nap-display.js';
const day=()=>({stops:[],nap:{latest_start_at:'2030-06-15T09:00:00Z',window:{start_at:'2030-06-15T12:00:00Z',end_at:'2030-06-15T14:00:00Z'},location:{label:'Жильё <script>'}}});
test('future day shows Moscow latest start and fixed sleep window, with escaped lodging',()=>{const s=napDayHtml(day());assert.match(s,/Начните до 12:00/);assert.match(s,/вернуться в жильё к 15:00/);assert.match(s,/15:00–17:00/);assert.match(s,/&lt;script&gt;/);assert.doesNotMatch(s,/<script>/)});
test('active and completed days do not recommend starting in the past',()=>{const d=day();d.execution={};assert.doesNotMatch(napDayHtml(d),/Начните до/);d.stops=[{activity_kind:'nap',progress:'visited'}];assert.match(napDayHtml(d),/Дневной сон завершён/)});
test('days without nap have no lodging notice',()=>assert.equal(napDayHtml({}),''));
