import test from "node:test";
import assert from "node:assert/strict";
import {discoverIntent,matchOpportunity,recommendReturn} from "../engine-lab/return-engine.mjs";
const now=1720000000000, day=86400000;
const context=(over={})=>({now,questionAppropriate:true,...over});
const snapshot=(product="done",over={})=>({product,schemaVersion:1,lastUsefulActionAt:null,pendingCount:0,...over});
const stated=(category,over={})=>({status:"stated",source:"explicit",category,statedAt:now-1000,expiresAt:now+1000,...over});
const policy=(over={})=>({minGap:day,availableActions:["ask_intent","start_task","resume_task","jacket","premium","coffee","lesson","habit","training"],allowQuestion:true,allowOffers:true,catalog:[],...over});
const item=(id,product,category,over={})=>({id,product,category,available:true,verifiedAt:now-1000,validUntil:now+1000,relevance:80,...over});
const price=amount=>({amount,currency:"TRY"});
const jacket=item("jacket","atelier23","date",{price:price(1900000),offerType:"standalone"});
const premium=item("premium","atelier23","date",{price:price(3500000),offerType:"replacement"});
const decide=(p,c={},s={},pol={})=>recommendReturn(snapshot(p,s),context(c),policy(pol));
test("unknown intent asks once only when appropriate and allowed",()=>{
  assert.equal(decide("atelier23").kind,"ask_intent");
  for(const c of [{declined:true},{askedThisSession:true},{questionAppropriate:false}])
    assert.equal(decide("atelier23",c).kind,"none");
  assert.equal(decide("atelier23",{}, {},{allowQuestion:false}).kind,"none");
});
test("explicit valid intent, expiry boundary, future time, unknown and declined",()=>{
  assert.equal(discoverIntent("atelier23",context({currentIntent:stated("date")})).status,"stated");
  assert.equal(discoverIntent("atelier23",context({currentIntent:stated("date",{expiresAt:now})})).status,"expired");
  assert.equal(discoverIntent("atelier23",context({currentIntent:stated("date",{statedAt:now+1})})).status,"invalid");
  assert.equal(discoverIntent("atelier23",context({currentIntent:stated("date",{source:"inferred"})})).status,"invalid");
  assert.equal(discoverIntent("atelier23",context({currentIntent:stated("date"),declined:true})).status,"declined");
  assert.equal(discoverIntent("atelier23",context()).status,"unknown");
});
test("Atelier 23 budget and relevance, not higher spend",()=>{
  const c={currentIntent:stated("date"),budget:price(2000000)};
  assert.equal(decide("atelier23",c,{}, {catalog:[premium,jacket]}).action,"jacket");
  assert.equal(decide("atelier23",{...c,budget:price(4000000)}, {},{catalog:[premium,jacket]}).action,"jacket");
  assert.equal(decide("atelier23",{...c,budget:price(4000000)}, {},{catalog:[{...premium,relevance:90},jacket]}).action,"premium");
  assert.equal(decide("atelier23",{...c,budget:price(1000000)}, {},{catalog:[premium,jacket]}).kind,"none");
});
test("unavailable, stale, wrong category, zero relevance and forbidden offers never substitute unrelated products",()=>{
  const c={currentIntent:stated("date"),budget:price(4000000)};
  for(const bad of [{available:false},{validUntil:now},{verifiedAt:now+1},{category:"work"},{relevance:0},{price:null},{offerType:null}])
    assert.equal(decide("atelier23",c,{}, {catalog:[{...jacket,...bad}]}).kind,"none");
  assert.equal(decide("atelier23",c,{}, {catalog:[jacket],allowOffers:false}).kind,"none");
  assert.equal(decide("atelier23",c,{}, {catalog:[jacket],availableActions:["ask_intent"]}).kind,"none");
});
test("duplicate IDs, currency mismatch and mixed currency fail closed",()=>{
  const c={currentIntent:stated("date")};
  assert.equal(decide("atelier23",c,{}, {catalog:[jacket,jacket]}).kind,"none");
  const other={...premium,price:{amount:35000,currency:"EUR"}};
  assert.equal(decide("atelier23",c,{}, {catalog:[jacket,other]}).reason,"ambiguous_currency");
  assert.equal(decide("atelier23",{...c,budget:price(4000000)}, {},{catalog:[other]}).kind,"none");
  assert.equal(decide("atelier23",{...c,budget:{amount:-1,currency:"TRY"}}, {},{catalog:[jacket]}).reason,"invalid_budget");
});
test("Robys: work intent matches available coffee only",()=>{
  const coffee=item("coffee","robys","work",{price:price(15000),offerType:"standalone"});
  assert.equal(decide("robys",{currentIntent:stated("work")},{},{catalog:[coffee]}).action,"coffee");
  assert.equal(decide("robys",{currentIntent:stated("rest")},{},{catalog:[coffee]}).kind,"none");
});
test("AI PATH, Habit, Zenit select relevant noncommercial actions",()=>{
  for(const [product,category,id] of [["ai-path","learn","lesson"],["habit","next_step","habit"],["zenit","training","training"]])
    assert.equal(decide(product,{currentIntent:stated(category)}, {},{catalog:[item(id,product,category)]}).action,id);
});
test("Done: new, referral, pending, completed, gap boundary and future activity",()=>{
  assert.equal(decide("done").reason,"first_visit");
  assert.equal(decide("done",{entrySource:"referral"},{pendingCount:3,lastUsefulActionAt:now-day}).reason,"referral");
  assert.equal(decide("done",{}, {pendingCount:1,lastUsefulActionAt:now-day+1}).kind,"none");
  assert.equal(decide("done",{}, {pendingCount:1,lastUsefulActionAt:now-day}).action,"resume_task");
  assert.equal(decide("done",{}, {pendingCount:0,lastUsefulActionAt:now-day}).reason,"return_empty");
  assert.equal(decide("done",{}, {pendingCount:1,lastUsefulActionAt:now+1}).reason,"invalid_input");
  assert.equal(decide("done",{declined:true},{pendingCount:1,lastUsefulActionAt:now-day}).action,"resume_task");
});
test("explicit intent overrides pending history; forged intent does not match",()=>{
  const c={currentIntent:stated("new_task")};
  const catalog=[item("start_task","done","new_task")];
  assert.equal(decide("done",c,{pendingCount:1,lastUsefulActionAt:now-day},{catalog}).kind,"start");
  assert.equal(matchOpportunity("atelier23",{status:"stated",category:"date"},context(),policy({catalog:[jacket]})).kind,"none");
});
test("pure deterministic, order independent and no private fields in result",()=>{
  const s=snapshot("atelier23"),c=context({currentIntent:stated("date",{privateText:"secret"}),privateName:"secret"});
  const p=policy({catalog:[jacket,premium]});
  const before=JSON.stringify([s,c,p]), result=recommendReturn(s,c,p);
  assert.deepEqual(result,recommendReturn(s,c,{...p,catalog:[premium,jacket]}));
  assert.equal(JSON.stringify([s,c,p]),before);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(recommendReturn(null,c,p).kind,"none");
});
