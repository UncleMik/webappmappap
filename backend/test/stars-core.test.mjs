import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { createStars, starsWeek, starsDay } from '../auth/stars-core.mjs';
import { createPoints } from '../auth/points.mjs';
import { createWeeklyPoll, starsPollSchedule } from '../auth/weekly-poll.mjs';
import { hashToken } from '../auth/security.mjs';

const DAY=86400000;
test('Moscow calendar and reviewed 8+4 poll schedule',()=>{
 assert.equal(starsDay('2026-11-12T21:00:00Z'),'2026-11-13');
 assert.equal(starsWeek({stage:'pregnancy',dueDate:'bad',completedAt:'yes'}),null);
 assert.equal(starsWeek({stage:'mother',dueDate:'2026-11-12',completedAt:'yes'}),null);
 assert.equal(starsWeek({stage:'pregnancy',dueDate:'2026-11-12'},'2026-11-12'),null);
 const polls=starsPollSchedule();assert.equal(polls.length,12);
 assert.equal(polls[0].opensAt.toISOString(),'2026-11-16T07:00:00.000Z');
 assert.equal(polls[0].closesAt.toISOString(),'2026-11-22T15:00:00.000Z');
 for(const p of polls){assert.equal(p.options.length,4);assert.ok(p.options.every(s=>!/^\d\)/.test(s)));}
});

test('wallet SQL, migrations, domain hooks and verified course progress',async t=>{
 const db=await testPool(),{pool}=db;
 let now=Date.parse('2026-11-16T09:00:00Z'),counter=0,paid=false;
 const settings={enabled:true,features:{stars:true,weekLocks:true,peekNextWeek:true,aiPacks:true},aiBudgetApproved:true,rewards:{},prices:{},limits:{},ai:{}};
 const inventory=[...Array.from({length:42},(_,i)=>i+1)].flatMap(week=>Array.from({length:week===25?5:6},(_,i)=>({kind:i<3?'article':'video',id:`w${week}-${i}`,week})));
 let videos=[{type:'video',videos:[{url:'https://synthetic.invalid/one'},{url:'https://synthetic.invalid/two'}]}];
 let manifest=[{key:'0:0',durationMs:10000,contentHash:'a'.repeat(64)},{key:'0:1',durationMs:10000,contentHash:'a'.repeat(64)}];
 const courses={async aiContext(){return {courses:paid?[{productId:1},{productId:2}]:[]};},async lesson(){return {lesson:{blocks:videos},validUntil:new Date(now+DAY).toISOString()};}};
 const catalog={materials:()=>inventory,courseVideos:()=>manifest};
 const sql=name=>readFile(new URL(`../auth/${name}`,import.meta.url),'utf8');
 const migration=await sql('stars-migration.sql');
 async function account(week=10,{created='2026-11-11T00:00:00Z',profile=true}={}){
  const id=randomUUID(),token=randomUUID(),dueDate=new Date(Date.parse(starsDay(now))+(280-week*7)*DAY).toISOString().slice(0,10);
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,created_at,profile) VALUES($1,$2,$3,$4,$5)',[id,`stars-${++counter}@example.invalid`,counter,created,profile?{stage:'pregnancy',dueDate,completedAt:new Date(now).toISOString()}:{}]);
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(now+100*DAY)]);
  return {id,token};
 }
 const service={async session(token){return (await pool.query('SELECT u.id,u.profile FROM auth_users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2',[hashToken(token),new Date(now)])).rows[0]||null;}};
 const stars=createStars({pool,service,settings,catalog,courseMaterials:courses,clock:()=>new Date(now)});
 const state=u=>stars.state(u.token,u.id);
 const run=(u,fn)=>stars.withAccount(u.token,u.id,fn);
 const earn=(u,ref,amount=1,capped=true)=>run(u,(client,c)=>stars.credit(client,c,{code:'synthetic',ref,amount,capped}));
 const complete=(u,m)=>run(u,(client,c)=>stars.completeMaterial(client,c,m));
 try{
  for(const name of ['club-chat-migration.sql','points-migration.sql','points-article-migration.sql','points-video-migration.sql','weekly-poll.sql'])await pool.query(await sql(name));
  const legacy=await account(10,{created:'2026-11-01T00:00:00Z'});
  await pool.query("INSERT INTO auth_points_ledger(user_id,article_id,occurred_at,moscow_day,amount) VALUES($1,'w10-0',$2,'2026-11-16',20)",[legacy.id,new Date(now)]);
  await pool.query('CREATE TABLE auth_stars_launch(id integer PRIMARY KEY CHECK(id=1),launched_at timestamptz NOT NULL)');
  await pool.query("INSERT INTO auth_stars_launch VALUES(1,'2026-11-10T00:00:00Z')");
  await pool.query(migration);await pool.query(await sql('stars-ai-migration.sql'));

  await t.test('migration reruns preserve ledger, marker, reviewed flags, and new accounts',async()=>{
   const newer=await account();await pool.query(migration);
   assert.equal((await state(legacy)).wallet.balance,120);
   assert.equal((await state(legacy)).wallet.balance,120);
   assert.equal((await state(legacy)).legacy,true);
   assert.equal((await state(newer)).legacy,false);
   assert.equal((await pool.query('SELECT launched_at FROM auth_stars_launch')).rows[0].launched_at.toISOString(),'2026-11-10T00:00:00.000Z');
   await complete(legacy,inventory.find(m=>m.id==='w10-0'));
   assert.equal((await state(legacy)).wallet.balance,120);
   await pool.query('UPDATE auth_stars_wallet SET legacy=false,preserved_weeks=ARRAY[20] WHERE user_id=$1',[legacy.id]);
   await pool.query(migration);assert.equal((await state(legacy)).legacy,false);
   await run(legacy,(client,c)=>stars.materialAccess(client,c,'article','w20-0'));
   await assert.rejects(run(legacy,(client,c)=>stars.materialAccess(client,c,'article','w21-0')),{code:'week_locked'});
  });
  await t.test('sessions and account binding, no welcome before PDR',async()=>{
   const u=await account(10,{profile:false});assert.equal((await state(u)).wallet.balance,0);
   await assert.rejects(stars.state(u.token,randomUUID()),{code:'account_changed'});
   await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1',[u.id,new Date(now)]);
   await assert.rejects(state(u),{code:'sign_in_required'});
  });
  await t.test('partial/zero capped rewards finish permanently, bonus and debit excluded',async()=>{
   const u=await account();await earn(u,'cap',95);
   assert.equal((await complete(u,inventory.find(m=>m.id==='w10-3'))).reward.actualAmount,5);
   assert.equal((await complete(u,inventory.find(m=>m.id==='w10-4'))).reward.actualAmount,0);
   assert.equal((await state(u)).wallet.dailyEarned,100);
   await run(u,(client,c)=>stars.debit(client,c,{code:'spend',ref:'one',amount:25}));
   assert.equal((await state(u)).wallet.dailyEarned,100);
   now+=DAY;
   assert.equal((await complete(u,inventory.find(m=>m.id==='w10-4'))).reward,null);
   assert.equal((await state(u)).wallet.dailyEarned,0);
   assert.equal((await state(u)).wallet.balance,175);
  });
  await t.test('concurrent idempotency and insufficient balance roll back purchases',async()=>{
   const u=await account();const results=await Promise.all([earn(u,'same',7),earn(u,'same',7)]);
   assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal((await state(u)).wallet.balance,107);
   await assert.rejects(run(u,(client,c)=>stars.debit(client,c,{code:'spend',ref:'large',amount:108})),{code:'insufficient_stars'});
   const id=randomUUID();await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId:id});
   assert.equal((await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId:id})).duplicate,true);
   await assert.rejects(stars.purchase(u.token,u.id,{kind:'peek_next_week',week:12,requestId:randomUUID()}),{code:'invalid_week'});
   assert.equal((await state(u)).wallet.balance,7);
  });
  await t.test('early unlock requires account age, no chain, reached week pays newly studied materials',async()=>{
   const newcomer=await account(10,{created:new Date(now).toISOString()});
   await assert.rejects(stars.purchase(newcomer.token,newcomer.id,{kind:'peek_next_week',week:11,requestId:randomUUID()}),{code:'peek_unavailable'});
   const u=await account(10);await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId:randomUUID()});
   await complete(u,inventory.find(m=>m.id==='w11-0'));now+=7*DAY;
   assert.equal((await complete(u,inventory.find(m=>m.id==='w11-0'))).reward,null);
   assert.equal((await complete(u,inventory.find(m=>m.id==='w11-1'))).reward.actualAmount,10);
   // There is no inherited weekly 180 cap in the new ledger.
   await earn(u,'day1',100);now+=DAY;await earn(u,'day2',100);now+=DAY;
   assert.equal((await earn(u,'day3',100)).actualAmount,100);
  });
  await t.test('never sell an already free next week: legacy, preserved, or locks disabled',async()=>{
   const u=await account();assert.equal((await state(u)).purchaseOptions.peekNextWeek.available,true);
   for(const mode of ['legacy','preserved','locks-off']){
    await pool.query('UPDATE auth_stars_wallet SET legacy=$2,preserved_weeks=$3 WHERE user_id=$1',[u.id,mode==='legacy',mode==='preserved'?[11]:[]]);
    settings.features.weekLocks=mode!=='locks-off';
    const option=(await state(u)).purchaseOptions.peekNextWeek;
    assert.deepEqual(option,{available:false,week:11,price:100,reason:'week_already_available'});
    await assert.rejects(stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId:randomUUID()}),{code:'week_already_available'});
    assert.equal((await state(u)).wallet.balance,100);
    assert.equal((await pool.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1',[u.id])).rows.length,0);
   }
   settings.features.weekLocks=true;
   const requestId=randomUUID();await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId});
   await pool.query('UPDATE auth_stars_wallet SET legacy=true WHERE user_id=$1',[u.id]);
   const replay=await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId});
   assert.equal(replay.duplicate,true);assert.equal(replay.wallet.balance,0);assert.equal(replay.purchaseOptions.peekNextWeek.available,false);
  });
  await t.test('all 42 weeks, actual fifth material week25, early completion and old weeks',async()=>{
   const u=await account(24);await stars.purchase(u.token,u.id,{kind:'peek_next_week',week:25,requestId:randomUUID()});
   for(const m of inventory.filter(m=>m.week===25))assert.equal((await complete(u,m)).reward,null);
   let s=await state(u);assert.equal(s.weeks.length,42);assert.equal(s.weeks[24].total,5);assert.equal(s.weeks[24].rewardPending,true);assert.equal(s.weeks[25].locked,true);
   now+=7*DAY;s=await state(u);assert.equal(s.currentWeek,25);assert.equal(s.weeks[24].letter,true);assert.equal(s.wallet.balance,50);
   for(const m of inventory.filter(m=>m.week===23))await complete(u,m);
   s=await state(u);assert.equal(s.weeks[22].letter,true);
   assert.equal(s.wallet.history.filter(h=>h.kind==='week_complete').length,1);
   // Adding a material cannot revoke the recorded completion or duplicate its bonus.
   inventory.push({kind:'article',id:'w25-added',week:25});s=await state(u);assert.equal(s.weeks[24].completed,true);
   assert.equal(s.weeks[24].total,6);inventory.pop();
  });
  await t.test('settings change rewards, prices, limits, flags and shared AI bank',async()=>{
   const u=await account();settings.limits.freeDaily=9;settings.rewards.article=17;
   assert.equal((await complete(u,inventory.find(m=>m.id==='w10-0'))).reward.actualAmount,9);
   settings.prices.aiPackFree=12;settings.ai.freePack=4;
   const requestId=randomUUID();await stars.purchase(u.token,u.id,{kind:'ai_pack',requestId});
   await stars.purchase(u.token,u.id,{kind:'ai_pack',requestId});
   assert.equal((await state(u)).aiCredits,4);assert.equal((await state(u)).wallet.balance,97);
   await stars.purchase(u.token,u.id,{kind:'ai_pack',requestId:randomUUID()});
   await assert.rejects(stars.purchase(u.token,u.id,{kind:'ai_pack',requestId:randomUUID()}),{code:'ai_purchase_limit'});
   paid=true;assert.equal((await state(u)).aiCredits,8);paid=false;
   settings.aiBudgetApproved=false;await assert.rejects(stars.purchase(u.token,u.id,{kind:'ai_pack',requestId:randomUUID()}),{code:'ai_packs_unavailable'});settings.aiBudgetApproved=true;
   settings.features.weekLocks=false;await run(u,(client,c)=>stars.materialAccess(client,c,'article','w42-0'));settings.features.weekLocks=true;
   settings.limits={};settings.rewards={};settings.prices={};settings.ai={};
  });
  await t.test('AI purchase daily-use guard, rollback and immutable request payload',async()=>{
   const u=await account();await pool.query('INSERT INTO auth_stars_ai_daily_usage(user_id,day_moscow,used) VALUES($1,$2,6)',[u.id,starsDay(now)]);
   await assert.rejects(stars.purchase(u.token,u.id,{kind:'ai_pack',requestId:randomUUID()}),{code:'ai_paid_daily_limit'});
   assert.equal((await state(u)).wallet.balance,100);assert.equal((await state(u)).aiCredits,0);
   await pool.query('DELETE FROM auth_stars_ai_daily_usage WHERE user_id=$1',[u.id]);
   const requestId=randomUUID();await stars.purchase(u.token,u.id,{kind:'ai_pack',requestId});
   await assert.rejects(stars.purchase(u.token,u.id,{kind:'peek_next_week',week:11,requestId}),{code:'request_conflict'});
  });
  await t.test('one progress read and no per-material normalization on repeated state',async()=>{
   const u=await account();await state(u);
   const queries=[];
   // Keep pg.Pool.connect's callback API intact: Pool.query uses it internally.
   // Instrument only the promise-only transaction facade consumed by createStars.
   const measuredPool={async connect(){
    const client=await pool.connect();
    return {query(sql,args){queries.push(sql);return client.query(sql,args);},release(){client.release();}};
   }};
   const measuredStars=createStars({pool:measuredPool,service,settings,catalog,courseMaterials:courses,clock:()=>new Date(now)});
   await measuredStars.state(u.token,u.id);
   assert.equal(queries.filter(s=>s.startsWith('SELECT kind,material_id,week,completed_at FROM auth_stars_material_progress')).length,1);
   assert.equal(queries.filter(s=>s.startsWith('UPDATE auth_stars_material_progress')).length,0);
   assert.ok(queries.length<25,`Expected bounded queries independent of catalog size; got ${queries.length}`);
  });
  await t.test('trimester crossings occur once, course ending changes cap without resetting spend',async()=>{
   const u=await account(13);await state(u);now+=7*DAY;
   assert.equal((await state(u)).wallet.balance,130);await state(u);assert.equal((await state(u)).wallet.balance,130);
   paid=true;await earn(u,'paid',140);assert.equal((await state(u)).wallet.dailyRemaining,10);
   paid=false;assert.equal((await state(u)).wallet.dailyRemaining,0);
  });
  await t.test('legacy points open mode, wrong account and revoked session without HTTP',async()=>{
   settings.enabled=false;
   const u=await account();const points=createPoints({pool,userIds:[],forAll:true,clock:()=>new Date(now),stars});
   assert.equal((await points.read(u.token,u.id)).enabled,true);
   await assert.rejects(points.read(u.token,randomUUID()),{code:'account_changed'});
   await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1',[u.id,new Date(now)]);
   await assert.rejects(points.read(u.token,u.id),{code:'sign_in_required'});settings.enabled=true;
  });
  await t.test('existing points API paginates the full shared history under stars',async()=>{
   const u=await account(),points=createPoints({pool,userIds:[],stars,clock:()=>now});
   for(let n=0;n<23;n++)await earn(u,`history-${n}`,1,false);
   const newest=await points.read(u.token,u.id),oldest=await points.read(u.token,u.id,newest.nextCursor);
   assert.equal(newest.history.length,20);assert.equal(oldest.history.length,4);assert.equal(oldest.nextCursor,null);
   assert.equal(newest.balance,123);assert.equal(oldest.balance,123);
   assert.equal(new Set([...newest.history,...oldest.history].map(row=>row.id)).size,24);
  });
  await t.test('Club hook reaches stars users outside pilot, isolates pooled clients and respects historical day',async()=>{
   const users=await Promise.all([account(),account()]),points=createPoints({pool,userIds:[],stars,clock:()=>now});
   for(const u of users)assert.equal(points.includes(u.id),true);
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    for(const u of [...users,users[0]]){
     await points.lockAccount(client,u.id);
     const {rows:[message]}=await client.query("INSERT INTO club_messages(room,author_id,request_id,body) VALUES('pregnancy-students',$1,$2,'synthetic') RETURNING id",[u.id,randomUUID()]);
     await points.awardClubMessage(client,u.id,message.id,new Date(now));
    }
    await client.query('COMMIT');
   }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   for(const u of users)assert.equal((await state(u)).wallet.balance,105);
   const historical=await account();await pool.query('INSERT INTO auth_points_ledger(user_id,source_message_id,amount,occurred_at,moscow_day) VALUES($1,987654321,5,$2,$3)',[historical.id,new Date(now),starsDay(now)]);
   await run(historical,(c)=>points.awardClubMessage(c,historical.id,987654321,new Date(now)));
   assert.equal((await state(historical)).wallet.balance,105);
  });
  await t.test('all course videos mandatory, trusted hash invalidation and lessonId once across products',async()=>{
   paid=true;const u=await account();
   const pulse=(productId,videoKey,data={})=>stars.courseVideoWatching(u.token,u.id,{productId,lessonId:111,videoKey,...data});
   const a=await pulse(1,'0:0');now+=5000;assert.equal((await pulse(1,'0:0',{attemptId:a.attemptId,ranges:[[0,8000]]})).status,'watching');
   const b=await pulse(1,'0:1');now+=5000;const earned=await pulse(1,'0:1',{attemptId:b.attemptId,ranges:[[0,8000]]});assert.equal(earned.amount,30);
   const again=await pulse(2,'0:1');now+=5000;assert.equal((await pulse(2,'0:1',{attemptId:again.attemptId,ranges:[[0,8000]]})).amount,0);
   const original=videos;videos=[{type:'video',videos:[{url:null},{url:'available'}]}];
   await assert.rejects(pulse(1,'0:1'),{code:'video_progress_unsupported'});videos=original;
   const prev=manifest;manifest=[{key:'0:0',durationMs:10000}];await assert.rejects(pulse(1,'0:0'),{code:'video_duration_unverified'});manifest=prev;
   const fresh=await pulse(1,'0:0');manifest=manifest.map(v=>({...v,contentHash:'b'.repeat(64)}));now+=5000;
   await assert.rejects(pulse(1,'0:0',{attemptId:fresh.attemptId,ranges:[[0,8000]]}),{code:'video_attempt_expired'});
   paid=false;
  });
  await t.test('poll participation immediate, tie majority once, existing settled awards retained',async()=>{
   const users=await Promise.all([account(),account()]);const polls=createWeeklyPoll(pool,{stars});
   // DB wall-clock is only used by the existing poll domain; closed synthetic polls avoid HTTP/timers.
   await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('tie','synthetic',ARRAY['a','b'],now()-interval '2 days',now()+interval '1 day')");
   for(const [i,u] of users.entries())await polls.vote(u.token,u.id,{pollId:'tie',choice:i});
   for(const u of users)assert.equal((await state(u)).wallet.balance,120);
   await pool.query("UPDATE weekly_polls SET closes_at=now()-interval '1 hour' WHERE id='tie'");
   await polls.settle();await polls.settle();
   for(const u of users){assert.equal((await state(u)).wallet.balance,130);assert.equal((await pool.query("SELECT points FROM weekly_poll_votes WHERE poll_id='tie' AND user_id=$1",[u.id])).rows[0].points,30);}
   await polls.vote(users[0].token,users[0].id,{pollId:'tie',choice:0});assert.equal((await state(users[0])).wallet.balance,130);
   const old=await account();await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at,settled_at) VALUES('legacy-settled','synthetic',ARRAY['a','b'],now()-interval '2 days',now()-interval '1 day',now())");
   await pool.query("INSERT INTO weekly_poll_votes(poll_id,user_id,choice,points) VALUES('legacy-settled',$1,0,100)",[old.id]);
   await pool.query("INSERT INTO auth_points_ledger(user_id,poll_id,amount,occurred_at,moscow_day,capped) VALUES($1,'legacy-settled',100,$2,$3,false)",[old.id,new Date(now),starsDay(now)]);
   await polls.vote(old.token,old.id,{pollId:'legacy-settled',choice:0});await polls.settle();assert.equal((await state(old)).wallet.balance,200);
   const rollback=await account();await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('rollback','synthetic',ARRAY['a','b'],now()-interval '2 days',now()+interval '1 day')");
   await polls.vote(rollback.token,rollback.id,{pollId:'rollback',choice:0});await pool.query("UPDATE weekly_polls SET closes_at=now()-interval '1 hour' WHERE id='rollback'");
   settings.enabled=false;await polls.settle();assert.equal((await pool.query("SELECT settled_at FROM weekly_polls WHERE id='rollback'")).rows[0].settled_at,null);
   settings.enabled=true;await polls.settle();assert.equal((await state(rollback)).wallet.balance,130);
  });
  await t.test('selected audience uses stars; non-pilot points and mixed polls retain legacy rules',async()=>{
   const selected=await account(),outside=await account();settings.audience={mode:'selected',userIds:[selected.id]};
   assert.equal(await stars.isEnabled(),true);assert.equal(await stars.isEnabled(selected.id),true);assert.equal(await stars.isEnabled(outside.id),false);
   assert.equal((await state(selected)).wallet.balance,100);assert.equal((await state(outside)).enabled,false);
   const points=createPoints({pool,userIds:[],forAll:true,stars,clock:()=>now});
   assert.deepEqual(await points.read(outside.token,outside.id),{accountId:outside.id,enabled:true,balance:0,history:[],nextCursor:null});
   const client=await pool.connect();
   try{await client.query('BEGIN');await points.lockAccount(client,outside.id);
    const {rows:[message]}=await client.query("INSERT INTO club_messages(room,author_id,request_id,body) VALUES('pregnancy-students',$1,$2,'synthetic') RETURNING id",[outside.id,randomUUID()]);
    await points.awardClubMessage(client,outside.id,message.id,new Date(now));await client.query('COMMIT');
   }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   assert.equal((await points.read(outside.token,outside.id)).balance,5);
   const polls=createWeeklyPoll(pool,{stars});
   await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('mixed','synthetic',ARRAY['a','b'],now()-interval '2 days',now()+interval '1 day')");
   await polls.vote(selected.token,selected.id,{pollId:'mixed',choice:0});await polls.vote(outside.token,outside.id,{pollId:'mixed',choice:1});
   assert.equal((await points.read(outside.token,outside.id)).balance,5);assert.equal((await state(selected)).wallet.balance,120);
   await pool.query("UPDATE weekly_polls SET closes_at=now()-interval '1 hour' WHERE id='mixed'");await polls.settle();await polls.settle();
   assert.equal((await state(selected)).wallet.balance,130);assert.equal((await points.read(outside.token,outside.id)).balance,105);
   delete settings.audience;
  });
  await t.test('poll results enqueue only for selected voters atomically after settlement, once',async()=>{
   const selected=await account(),outside=await account();settings.audience={mode:'selected',userIds:[selected.id]};
   await pool.query('CREATE TABLE test_poll_outbox(user_id uuid,event_key text,event jsonb,PRIMARY KEY(user_id,event_key))');
   let reject=true;
   const notifications={async enqueue(client,event){
    assert.equal(event.userId,selected.id);
    const {rows:[poll]}=await client.query("SELECT settled_at FROM weekly_polls WHERE id='notify-results'");assert.ok(poll.settled_at);
    await client.query('INSERT INTO test_poll_outbox(user_id,event_key,event) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[event.userId,event.key,event]);
    if(reject)throw new Error('synthetic enqueue failure');
   }};
   const polls=createWeeklyPoll(pool,{stars,notifications});
   await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('notify-results','synthetic',ARRAY['a','b'],now()-interval '2 days',now()+interval '1 day')");
   await polls.vote(selected.token,selected.id,{pollId:'notify-results',choice:0});await polls.vote(outside.token,outside.id,{pollId:'notify-results',choice:1});
   await pool.query("UPDATE weekly_polls SET closes_at=now()-interval '1 hour' WHERE id='notify-results'");
   await assert.rejects(polls.settle(),/synthetic enqueue failure/);
   assert.equal((await state(selected)).wallet.balance,120);
   assert.equal((await pool.query('SELECT * FROM test_poll_outbox')).rows.length,0);
   assert.equal((await pool.query("SELECT settled_at FROM weekly_polls WHERE id='notify-results'")).rows[0].settled_at,null);
   reject=false;await polls.settle();await polls.settle();
   assert.equal((await state(selected)).wallet.balance,130);
   const {rows}=await pool.query('SELECT event FROM test_poll_outbox');assert.equal(rows.length,1);
   assert.deepEqual(rows[0].event,{userId:selected.id,key:'poll-results-notify-results',type:'poll_results',title:'Голосование завершено',body:'',url:'/club.html?poll=1#events',babyRelated:false,medical:false});
   delete settings.audience;
  });
  await t.test('prelaunch and exact-launch pilot accounts retain active poll on day0 regardless of material review',async()=>{
   const {rows:[launch]}=await pool.query('SELECT launched_at FROM auth_stars_launch WHERE id=1');
   const start=+new Date(launch.launched_at);now=start;
   const existing=await account(10,{created:new Date(start-1).toISOString()}),boundary=await account(10,{created:new Date(start).toISOString()});
   settings.audience={mode:'selected',userIds:[existing.id,boundary.id]};
   const polls=createWeeklyPoll(pool,{stars});
   await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('prelaunch-active','synthetic',ARRAY['a','b'],now()-interval '1 hour',now()+interval '1 day')");
   for(const u of [existing,boundary]){
    await state(u);
    // Explicit owner review state cannot remove this old poll entitlement.
    await pool.query('UPDATE auth_stars_wallet SET legacy=false WHERE user_id=$1',[u.id]);
    const result=await polls.read(u.id);assert.equal(result.accountId,u.id);assert.equal(result.enabled,true);assert.equal(result.available,true);assert.ok(result.poll);
    const firstVote=await polls.vote(u.token,u.id,{pollId:'prelaunch-active',choice:0});
    assert.equal(firstVote.accountId,u.id);
    assert.equal(firstVote.choice,0);
    const repeatedVote=await polls.vote(u.token,u.id,{pollId:'prelaunch-active',choice:1});
    assert.equal(repeatedVote.accountId,u.id);
    assert.equal(repeatedVote.choice,0,'repeat must preserve the original answer');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM weekly_poll_votes WHERE poll_id='prelaunch-active' AND user_id=$1",[u.id])).rows[0].count,1);
    const {rows}=await pool.query("SELECT amount FROM auth_points_ledger WHERE user_id=$1 AND event_code='poll_vote' AND event_ref='prelaunch-active'",[u.id]);
    assert.equal(rows.length,1);assert.equal(rows[0].amount,20);assert.equal((await state(u)).wallet.balance,120);
   }
   delete settings.audience;
  });
  await t.test('postlaunch pilot poll onboarding is enforced on Moscow day0/day1 and opens on day2',async()=>{
   now=Date.parse(starsDay(now)+'T20:59:59.999Z');
   const start=now,selected=await account(10,{created:new Date(now).toISOString()}),outside=await account(10,{created:new Date(now).toISOString()});
   settings.audience={mode:'selected',userIds:[selected.id]};
   const polls=createWeeklyPoll(pool,{stars});
   await pool.query("INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('onboarding-clock','synthetic',ARRAY['a','b'],now()-interval '1 hour',now()+interval '1 day')");
   let result=await polls.read(selected.id);
   assert.equal(result.accountId,selected.id);assert.equal(result.enabled,false);assert.equal(result.available,false);assert.equal(result.poll,null);assert.equal(result.reason,'poll_onboarding');
   assert.equal(result.availableAt,new Date(Date.parse(starsDay(start))+2*DAY-3*3600000).toISOString());
   await assert.rejects(polls.vote(selected.token,selected.id,{pollId:'onboarding-clock',choice:0}),{code:'poll_onboarding'});
   assert.equal((await pool.query('SELECT user_id FROM weekly_poll_votes WHERE user_id=$1',[selected.id])).rows.length,0);
   assert.equal((await pool.query('SELECT id FROM auth_points_ledger WHERE user_id=$1',[selected.id])).rows.length,0);
   result=await polls.read(outside.id);assert.equal(result.accountId,outside.id);assert.equal(result.enabled,true);assert.equal(result.available,true);assert.ok(result.poll);
   const outsideVote=await polls.vote(outside.token,outside.id,{pollId:'onboarding-clock',choice:1});
   assert.equal(outsideVote.accountId,outside.id,'new account outside pilot can vote immediately');
   assert.equal(outsideVote.choice,1);
   assert.equal((await polls.read(outside.id)).poll.choice,1,'vote remains after a fresh read');
   now=start+1; // One millisecond later is Moscow day1, still locked.
   assert.equal((await polls.read(selected.id)).enabled,false);
   await assert.rejects(polls.vote(selected.token,selected.id,{pollId:'onboarding-clock',choice:0}),{code:'poll_onboarding'});
   now=start+DAY+1; // Exactly the next Moscow midnight: day2, not 48 elapsed hours.
   result=await polls.read(selected.id);assert.equal(result.enabled,true);assert.equal(result.available,true);assert.ok(result.poll);
   await polls.vote(selected.token,selected.id,{pollId:'onboarding-clock',choice:0});
   assert.equal((await pool.query("SELECT amount FROM auth_points_ledger WHERE user_id=$1 AND event_code='poll_vote'",[selected.id])).rows[0].amount,20);
   // Generating the reviewed schedule never changes an existing voted poll.
   const scheduledId=starsPollSchedule()[0].id;
   await pool.query("UPDATE weekly_polls SET question='Existing voted question' WHERE id=$1",[scheduledId]);
   await pool.query('INSERT INTO weekly_poll_votes(poll_id,user_id,choice) VALUES($1,$2,1) ON CONFLICT DO NOTHING',[scheduledId,outside.id]);
   await polls.read(selected.id);
   assert.equal((await pool.query('SELECT question FROM weekly_polls WHERE id=$1',[scheduledId])).rows[0].question,'Existing voted question');
   delete settings.audience;
  });
 }finally{await db.close();}
});
