import test from 'node:test';
import assert from 'node:assert/strict';
import { alignActions, actions, metrics, answer } from './run-comparison-data.ts';
const call=(args)=>({name:'read',args});
test('aligns inserted calls without shifting exact matches; retains repetitions',()=>{
 const rows=alignActions([call('a'),call('a'),call('b')],[call('a'),{name:'search',args:'q'},call('a'),call('b')]);
 assert.deepEqual(rows.map(r=>r.status),['Same','Added','Same','Same']);
});
test('pairs changed arguments and reports removed calls',()=>{
 assert.deepEqual(alignActions([call('a'),{name:'edit',args:'b'}],[call('c')]).map(r=>r.status),['Arguments changed','Removed']);
});
test('canonicalizes JSON arguments and excludes carried results',()=>{
 const t={events:[{title:'Tool call: read',raw:JSON.stringify({name:'read',arguments:'{"b":2,"a":1}'})},{title:'Tool result: read',raw:'{}'}]};
 assert.deepEqual(actions(t),[{name:'read',args:'{"a":1,"b":2}'}]);
});
test('missing cost does not produce a misleading partial savings comparison',()=>{
 const t={events:[],requests:[{cost:0,input:10,output:3,durationMs:1000,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:01Z'},{cost:null,input:10,output:3,durationMs:1000,startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:00:01Z'}]};
 assert.equal(metrics(t).cost,null);assert.equal(metrics(t).time,2000);assert.equal(metrics(t).span,1000);
 assert.equal(metrics({...t,requests:[t.requests[0]]}).cost,0);
});
test('extracts last answer rather than earlier commentary',()=>{
 assert.equal(answer({events:[{title:'Model answer',raw:'{"content":[{"text":"Earlier"}]}'},{title:'Model answer',raw:'{"content":[{"text":"Final"}]}'}]}),'Final');
});
