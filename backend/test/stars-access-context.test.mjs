import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { createStarsAccess } from '../auth/stars-access.mjs';
import { createStars } from '../auth/stars-core.mjs';
import { createGamificationSettings, DEFAULT_GAMIFICATION_SETTINGS } from '../auth/gamification-settings.mjs';
import { randomToken, hashToken } from '../auth/security.mjs';
let db,pool,settings,now,gc=0;
const launch='2026-11-01T00:00:00Z';
before(async()=>{
  db=await testPool();pool=db.pool;
  await pool.query(`CREATE TABLE auth_stars_launch(id integer PRIMARY KEY,launched_at timestamptz NOT NULL);
    CREATE TABLE auth_stars_wallet(user_id uuid PRIMARY KEY REFERENCES auth_users(id),legacy boolean NOT NULL,preserved_weeks integer[] NOT NULL DEFAULT '{}');
    CREATE TABLE auth_stars_week_purchases(user_id uuid NOT NULL REFERENCES auth_users(id),week integer NOT NULL,PRIMARY KEY(user_id,week));
    CREATE TABLE gamification_settings(id integer PRIMARY KEY,value jsonb NOT NULL);
    CREATE TABLE auth_points_ledger(user_id uuid NOT NULL,amount integer NOT NULL);
    INSERT INTO auth_stars_launch VALUES(1,'2026-11-01T00:00:00Z');
    INSERT INTO gamification_settings VALUES(1,'{}');`);
  settings=createGamificationSettings({pool});
});
after(async()=>db?.close());
async function fixture({createdAt='2026-11-02T00:00:00Z',completed=true}={}){
  now=new Date('2026-11-12T20:59:59Z');
  const userId=randomUUID(),token=randomToken();
  const profile={stage:'pregnancy',dueDate:'2027-03-26',...(completed?{completedAt:now.toISOString()}:{})};
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,created_at,profile) VALUES($1,$2,$3,$4,$5)',[userId,userId+'@example.invalid',++gc,createdAt,JSON.stringify(profile)]);
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),userId,new Date(+now+86400000)]);
  const config=structuredClone(DEFAULT_GAMIFICATION_SETTINGS);config.enabled=true;config.features.stars=true;config.features.weekLocks=true;config.audience={mode:'all',userIds:[]};
  await pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[JSON.stringify(config)]);
  return {userId,token,config};
}
function observedReader(){
  const calls={session:0,getcourse:0,wallet:0},queries=[];
  const service={session:async()=>{calls.session++;throw Error('Unexpected service.session');}};
  const stars=createStars({pool,service,settings,courseMaterials:{aiContext:async()=>{calls.getcourse++;throw Error('GetCourse offline');}}});
  const original=stars.withAccount;stars.withAccount=async(...args)=>{calls.wallet++;return original(...args);};
  const readPool={async connect(){const client=await pool.connect();return {query:(sql,args)=>{queries.push(sql);return client.query(sql,args);},release:()=>client.release()};}};
  return {gate:createStarsAccess({stars,pool:readPool,service,settings,clock:()=>now}),calls,queries};
}
test('repeated list/media policy is local and read-only: no GetCourse, wallet lifecycle, welcome or writes',async()=>{
  const f=await fixture(),{gate,calls,queries}=observedReader();
  await pool.query('INSERT INTO auth_points_ledger VALUES($1,17)',[f.userId]);
  await pool.query('INSERT INTO auth_stars_week_purchases VALUES($1,21)',[f.userId]);
  for(let i=0;i<6;i++){
    const policy=await gate.context(f.token,f.userId);assert.equal(policy.currentWeek,20);assert.equal(policy.legacy,false);
    assert.equal(policy.enforced,true);assert.equal(gate.canWeek(policy,21),true);assert.equal(gate.canWeek(policy,22),false);
    assert.equal(gate.filter(policy,[{week:20},{week:22}]).length,1);
    gate.assertWeek(policy,gate.videoWeek(60));
  }
  assert.deepEqual(calls,{session:0,getcourse:0,wallet:0});
  assert.equal(queries.some(sql=>/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)),false);
  assert.equal(queries.filter(sql=>/FOR SHARE OF s,u/.test(sql)).length,6);
  assert.equal((await pool.query('SELECT * FROM auth_stars_wallet WHERE user_id=$1',[f.userId])).rows.length,0);
  assert.deepEqual((await pool.query('SELECT amount FROM auth_points_ledger WHERE user_id=$1',[f.userId])).rows,[{amount:17}]);
});
test('read-only policy rejects revoked/expired/missing sessions, foreign account and unfinished profile',async()=>{
  const f=await fixture(),{gate}=observedReader();
  await assert.rejects(gate.context(f.token,randomUUID()),e=>e.code==='account_changed');
  await assert.rejects(gate.context(null,f.userId),e=>e.code==='sign_in_required');
  await assert.rejects(gate.context(randomToken(),f.userId),e=>e.code==='sign_in_required');
  await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE user_id=$2',[now,f.userId]);
  await assert.rejects(gate.context(f.token,f.userId),e=>e.code==='sign_in_required');
  await pool.query('UPDATE auth_sessions SET revoked_at=NULL,expires_at=$1 WHERE user_id=$2',[now,f.userId]);
  await assert.rejects(gate.context(f.token,f.userId),e=>e.code==='sign_in_required');
  const unfinished=await fixture({completed:false});
  await assert.rejects(gate.context(unfinished.token,unfinished.userId),e=>e.code==='onboarding_required');
});
test('reviewed wallet overrides launch fallback and preserves purchases/explicit weeks without initialization',async()=>{
  const f=await fixture({createdAt:launch}),{gate}=observedReader();
  let policy=await gate.context(f.token,f.userId);assert.equal(policy.legacy,true);assert.equal(gate.canWeek(policy,42),true);
  await pool.query('INSERT INTO auth_stars_wallet(user_id,legacy,preserved_weeks) VALUES($1,false,ARRAY[30,35])',[f.userId]);
  await pool.query('INSERT INTO auth_stars_week_purchases VALUES($1,21)',[f.userId]);
  policy=await gate.context(f.token,f.userId);assert.equal(policy.legacy,false);assert.deepEqual(policy.preservedWeeks,[30,35]);assert.deepEqual(policy.purchasedWeeks,[21]);
  assert.equal(gate.canWeek(policy,30),true);assert.equal(gate.canWeek(policy,31),false);
  await pool.query('UPDATE auth_stars_wallet SET legacy=true WHERE user_id=$1',[f.userId]);
  assert.equal((await gate.context(f.token,f.userId)).legacy,true);
  const noMarker=await fixture();await pool.query('DELETE FROM auth_stars_launch');
  try{assert.equal((await gate.context(noMarker.token,noMarker.userId)).legacy,true);}
  finally{await pool.query('INSERT INTO auth_stars_launch VALUES(1,$1)',[launch]);}
});
test('fresh audience/settings/profile are read on every call and week boundary follows Moscow floor(days/7)',async()=>{
  const f=await fixture(),{gate}=observedReader();
  f.config.audience={mode:'selected',userIds:[]};
  await pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[JSON.stringify(f.config)]);
  assert.equal((await gate.context(f.token,f.userId)).enforced,false);
  f.config.audience.userIds=[f.userId];await pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[JSON.stringify(f.config)]);
  assert.equal((await gate.context(f.token,f.userId)).enforced,true);
  now=new Date('2026-11-12T21:00:00Z');assert.equal((await gate.context(f.token,f.userId)).currentWeek,21);
  await pool.query("UPDATE auth_users SET profile=profile || '{\"stage\":\"mother\"}'::jsonb WHERE id=$1",[f.userId]);
  const policy=await gate.context(f.token,f.userId);assert.equal(policy.currentWeek,0);assert.equal(gate.canWeek(policy,1),false);
});

test('session expiring while local policy is being read is closed before returning any content policy',async()=>{
  const f=await fixture();
  const advancingSettings={get:async client=>{const result=await settings.get(client);now=new Date(+now+86400000);return result;}};
  const gate=createStarsAccess({pool,settings:advancingSettings,clock:()=>now});
  await assert.rejects(gate.context(f.token,f.userId),e=>e.code==='sign_in_required');
});
