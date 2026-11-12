import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessWeek, createStarsAccess, createLocalStarsAccess } from '../auth/stars-access.mjs';
import { normalizeProfile, normalizeProfileEdit } from '../auth/profile.mjs';

const policy = { accountId:'account', enforced:true, legacy:false, currentWeek:20, purchasedWeeks:[21], preservedWeeks:[30] };
test('one predicate protects all weeks, purchased/preserved survive date changes, calendar stays complete', () => {
  const gate=createStarsAccess({contextProvider:async()=>policy});
  assert.deepEqual(Array.from({length:42},(_,i)=>i+1).filter(w=>gate.canWeek(policy,w)),[...Array.from({length:21},(_,i)=>i+1),30]);
  for(const invalid of [null,undefined,0,43,'bad',1.5]) assert.equal(canAccessWeek(policy,invalid),false);
  assert.throws(()=>gate.assertWeek(policy,22),e=>e.code==='week_locked');
  const data={mom:{20:'open',22:'closed'},baby:{21:'bought',22:'closed'},calendar:{42:'calendar'},calendarNotes:['all']};
  assert.deepEqual(gate.weekly(policy,data).mom,{20:'open'});
  assert.deepEqual(gate.weekly(policy,data).baby,{21:'bought'});
  assert.deepEqual(gate.weekly(policy,data).calendar,data.calendar);
  assert.deepEqual(gate.filter(policy,[{week:20},{week:22}]),[{week:20}]);
  assert.equal(gate.canWeek({...policy,currentWeek:0},21),true);
  assert.equal(gate.canWeek({...policy,currentWeek:0},1),false);
  assert.equal(gate.canWeek({...policy,legacy:true},42),true);
  assert.equal(gate.canWeek({...policy,enforced:false},42),true);
  assert.equal(gate.videoWeek(126),42);assert.equal(gate.videoWeek(75),25);assert.equal(gate.videoWeek(127),null);
});
test('local policy bridge forwards only auth identity and fails closed on outage, mismatch or malformed permissive response',async()=>{
  let headers;
  const gate=createLocalStarsAccess({fetchImpl:async(url,options)=>{assert.equal(url.hostname,'127.0.0.1');headers=options.headers;return {ok:true,json:async()=>({...policy,balance:999})};}});
  assert.deepEqual(await gate.context('token','account'),policy);
  assert.equal(headers.Cookie,'__Host-school_session=token');assert.equal(headers['X-Webpril-Account'],'account');
  for(const result of [null,{...policy,accountId:'other'},{...policy,enforced:undefined},{...policy,preservedWeeks:[999]}]){
    const broken=createLocalStarsAccess({fetchImpl:async()=>({ok:true,json:async()=>result})});
    await assert.rejects(broken.context('token','account'),e=>e.code==='weekly_access_unavailable');
  }
  await assert.rejects(createLocalStarsAccess({fetchImpl:async()=>{throw Error('offline');}}).context('token','account'),e=>e.status===503);
  assert.throws(()=>createLocalStarsAccess({url:'https://external.invalid/api/auth/internal/weekly-access'}));
});
test('initial due date bounds survive incremental edits and motherhood roundtrip',()=>{
  const now=Date.parse('2026-11-12T10:00:00Z');
  const original=normalizeProfile({name:'Имя',stage:'pregnancy',method:'due',due:'2027-03-01',goals:[0]},now);
  const edited=normalizeProfileEdit(original,{dueDate:'2027-03-15'},false,now);
  assert.throws(()=>normalizeProfileEdit(edited,{dueDate:'2027-03-16'},false,now),e=>e.code==='invalid_profile');
  const mother=normalizeProfileEdit(edited,{stage:'mother',birthDate:'2026-11-11',goals:[0]},true,now);
  assert.equal(mother.initialDueDate,'2027-03-01');
  const legacy={...original};delete legacy.initialDueDate;
  const legacyMother=normalizeProfileEdit(legacy,{stage:'mother',birthDate:'2026-11-11',goals:[0]},true,now);
  assert.equal(legacyMother.initialDueDate,'2027-03-01');
  assert.throws(()=>normalizeProfileEdit(legacyMother,{stage:'pregnancy',dueDate:'2027-04-01',goals:[0]},false,now),e=>e.code==='invalid_profile');
  assert.throws(()=>normalizeProfileEdit(mother,{stage:'pregnancy',dueDate:'2027-04-01',goals:[0]},false,now),e=>e.code==='invalid_profile');
  assert.equal(normalizeProfileEdit(mother,{stage:'pregnancy',dueDate:'2027-02-15',goals:[0]},false,now).initialDueDate,'2027-03-01');
});
