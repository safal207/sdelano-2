import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {replay,projectRewards,applyEvent,emptyLedger} from '../engine-lab/event-ledger.mjs';
import {auditWallet} from '../engine-lab/shadow-audit.mjs';
const actor='load', policy=()=>({xp:10,coins:5}), at=Date.UTC(2026,10,23,12), day='2026-11-23';
function fixture(n){
  const events=Array.from({length:n},(_,i)=>({eventId:'e-'+i,actorId:actor,kind:'task.completed',occurredAt:new Date(at+i).toISOString()}));
  const grants=[];
  for(let i=0;grants.length<n;i++){
    grants.push({key:'task:'+i,day,at:at+i,xp:10,coins:5});
    if(i===0)grants.push({key:'daily:'+day,day,at,xp:10,coins:5});
    if(i===2)grants.push({key:'triple:'+day,day,at:at+i,xp:15,coins:10});
  }
  return {events,wallet:{version:1,excludedIds:[],grants,purchases:[{id:'scarf',coins:50,at:at+n}]}};
}
function measure(fn){
  for(let i=0;i<5;i++)fn();
  const samples=[];
  for(let i=0;i<100;i++){const t=performance.now();fn();samples.push(performance.now()-t);}
  samples.sort((a,b)=>a-b);
  const delta=[];
  for(let i=0;i<5;i++){globalThis.gc?.();const before=process.memoryUsage().heapUsed;const result=fn();delta.push((process.memoryUsage().heapUsed-before)/1048576);assert.ok(result);}
  const r=n=>+n.toFixed(4);
  return {samples:100,p50Ms:r(samples[49]),p95Ms:r(samples[94]),p99Ms:r(samples[98]),maxSampledHeapDeltaMiB:r(Math.max(...delta)),forcedGc:typeof globalThis.gc==='function'};
}
for(const n of [100,1000,10000,12000])test('BitOS load '+n,()=>{
  const {events,wallet}=fixture(n),before=JSON.stringify({events,wallet});
  const project=()=>projectRewards(actor,events,policy),full=()=>replay(actor,events,policy),audit=()=>auditWallet(wallet);
  assert.deepEqual(project(),{actorId:actor,count:n,xp:n*10,coins:n*5});
  const f=full();assert.equal(f.entries.length,n);assert.equal(f.xp,n*10);assert.equal(f.coins,n*5);
  const a=audit();assert.equal(a.status,'ok');assert.deepEqual([a.expectedXp,a.observedXp,a.expectedCoins,a.observedCoins],[n*10+5,n*10+5,n*5-45,n*5-45]);assert.deepEqual(audit(),a);
  const dup=events.slice();dup[n-1]=dup[0];assert.equal(projectRewards(actor,dup,policy).count,n-1);assert.equal(replay(actor,dup,policy).entries.length,n-1);
  const broken={...wallet,grants:wallet.grants.slice()};broken.grants[n-1]={...broken.grants[n-1],xp:99};assert.equal(auditWallet(broken).status,'mismatch');
  const metrics={n,node:process.version,cpu:cpus()[0]?.model,projection:measure(project),replay:measure(full),audit:measure(audit)};
  console.log('BITOS_LOAD '+JSON.stringify(metrics));
  for(const key of ['projection','replay','audit'])assert.ok(metrics[key].p95Ms<250,key+' p95 exceeded 250 ms at '+n);
  assert.equal(JSON.stringify({events,wallet}),before);
});
test('BitOS boundaries and replay compatibility',()=>{
  const {events,wallet}=fixture(12000);
  assert.throws(()=>projectRewards(actor,[...events,events[0]],policy),/Invalid events array/);
  assert.equal(auditWallet({...wallet,grants:[...wallet.grants,wallet.grants[0]]}).status,'invalid');
  const foreign=events.slice();foreign[11999]={...foreign[0],actorId:'other'};
  assert.throws(()=>projectRewards(actor,foreign,policy),/Actor mismatch/);assert.throws(()=>replay(actor,foreign,policy),/Actor mismatch/);
  const sparse=[events[0],,events[1],events[0]],custom=()=>({xp:7,coins:3,ruleVersion:'test-2'});
  assert.deepEqual(replay(actor,sparse,custom),sparse.reduce((s,e)=>applyEvent(s,e,custom),emptyLedger(actor)));assert.deepEqual(replay(actor,[],null),emptyLedger(actor));
  const a=auditWallet({version:1,grants:Array(12000).fill(null),excludedIds:[]});assert.equal(a.status,'mismatch');assert.equal(a.issues.length,24);assert.equal(a.expectedXp,0);
});
