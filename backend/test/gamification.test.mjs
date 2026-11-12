import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../database.mjs';
import {createStarsCatalog} from '../auth/stars-catalog.mjs';
import {testPool} from './auth-pool.mjs';
import {createStars} from '../auth/stars-core.mjs';
import {createGamification,pregnancyTiming,softStreak,selectRecommendations} from '../auth/gamification.mjs';
import {normalizeGamificationContent,loadGamificationCatalog,guessQuestion,parseMeasurements} from '../auth/gamification-content.mjs';
import {createGamificationNotifications} from '../auth/gamification-notifications.mjs';
import {createGamificationSettings} from '../auth/gamification-settings.mjs';
import {hashToken} from '../auth/security.mjs';
const DAY=86400000;
const pub=x=>({...x,status:'published',medical:false});
const flags={stars:true,daily:true,myths:true,quests:true,capsule:true,games:true};
test('normalization keeps all prepared medical texts unpublished; measurements and boundaries',async()=>{
 const source=JSON.parse(await readFile(new URL('../content/gamification-source.json',import.meta.url)));
 const cat=normalizeGamificationContent(source);
 assert.equal(cat.questions.length,126);assert.equal(cat.letters.length,42);assert.ok(cat.questions.every(x=>x.status==='unpublished'));assert.ok(cat.checklists.bag.length>20);assert.equal(cat.checklists.doctor.length,12);
 assert.deepEqual(parseMeasurements('Рост ≈ 38 см · Вес ≈ 1,5 кг'),{height:38,weight:1500});assert.equal(parseMeasurements('нет данных'),null);
 assert.equal(guessQuestion({week:22,measurements:'Рост ≈ 28 см · Вес ≈ 460 г'}).options.length,3);
 assert.deepEqual(pregnancyTiming({completedAt:'yes',stage:'pregnancy',dueDate:'2027-03-18'},'2026-11-12'),{week:22,days:154,day:1});
 assert.equal(softStreak([1,2,4],1,7).count,1);
 assert.deepEqual(selectRecommendations([{id:'random',week:22,accessible:true}],22,{},'anxious'),[]);
 const selected=selectRecommendations([{id:'closed',week:23,accessible:true},{id:'no',week:22},{id:'yes',week:22,accessible:true}],22);assert.deepEqual(selected.map(x=>x.id),['yes']);
});
async function setup(t,{week=22,day=1,draft=false}={}) {
 const db=await testPool();t.after(()=>db.close());const {pool}=db;
 for(const name of ['club-chat-migration.sql','points-migration.sql','points-article-migration.sql','points-video-migration.sql','weekly-poll.sql','stars-migration.sql','gamification-admin-migration.sql','gamification-migration.sql'])await pool.query(await readFile(new URL('../auth/'+name,import.meta.url),'utf8'));
 let now=Date.parse('2026-11-12T09:00:00Z');const clock=()=>now,id=randomUUID(),token=randomUUID();
 const due=new Date(Date.parse('2026-11-12')+(280-week*7-(day-1))*DAY).toISOString().slice(0,10);
 let profile={name:'Тест',stage:'pregnancy',completedAt:new Date(now).toISOString(),dueDate:due};
 await pool.query('INSERT INTO auth_users(id,email,profile,getcourse_id) VALUES($1,$2,$3,1)',[id,id+'@example.invalid',profile]);
 await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(now+365*DAY)]);
 const service={session:async()=>({id,profile})},config={enabled:true,medicalApproved:true,features:{...flags}};
 const catalog=loadGamificationCatalog();
 const cat={...catalog,letters:catalog.letters.map(pub),questions:catalog.questions.map(pub),weekly:Object.fromEntries(Object.entries(catalog.weekly).map(([k,x])=>[k,pub(x)])),care:catalog.care.map(x=>pub({...x,babyRelated:false})),ideas:catalog.ideas.map(pub),practices:catalog.practices.map(pub),quests:catalog.quests.map(pub),checklists:{bag:catalog.checklists.bag.map(pub),doctor:catalog.checklists.doctor.map(pub)}};
 const stars=createStars({pool,service,settings:config,clock,catalog:{materials:[]}});
 const api=createGamification({pool,service,stars,settings:config,clock,catalog:draft?catalog:cat});
 const action=body=>api.action(token,id,{requestId:randomUUID(),...body});
 const set=async value=>{await pool.query('UPDATE auth_gamification_state SET data=data || $2::jsonb WHERE user_id=$1',[id,value]);};
 const age=async days=>pool.query('UPDATE auth_gamification_state SET first_day=$2 WHERE user_id=$1',[id,new Date(now-days*DAY).toISOString().slice(0,10)]);
 return {pool,id,token,api,cat,config,stars,action,set,age,advance:days=>{now+=days*DAY;},profile:async patch=>{profile={...profile,...patch};await pool.query('UPDATE auth_users SET profile=$2 WHERE id=$1',[id,profile]);}};
}
test('daily real SQL: authentication, capped rewards, persistence, retries and conflicts',async t=>{
 const x=await setup(t);let s=await x.api.state(x.token,x.id);assert.equal(s.wallet.balance,100);assert.equal(s.today.question,null);
 await assert.rejects(x.api.state(x.token,randomUUID()),e=>e.code==='account_changed');
 const body={type:'checkin',mood:'anxious',requestId:randomUUID()};const a=await x.api.action(x.token,x.id,body);assert.equal(a.reward.actualAmount,5);assert.equal(a.state.today.offerCourse,false);
 const duplicate=await x.api.action(x.token,x.id,body);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.state.wallet.balance,105);
 await assert.rejects(x.api.action(x.token,x.id,{...body,mood:'good'}),e=>e.code==='request_conflict');
 await x.action({type:'checkin',mood:'good'});assert.equal((await x.api.state(x.token,x.id)).wallet.balance,105);
 await x.age(4);s=await x.api.state(x.token,x.id);assert.ok(s.today.question);assert.equal('answer' in s.today.question,false);assert.equal('explanation' in s.today.question,false);
 const sourceQuestion=x.cat.questions.find(q=>q.id===s.today.question.id);x.cat.inventory=[{id:sourceQuestion.articleId,kind:'article',week:22}];
 const result=await x.action({type:'myth_answer',questionId:s.today.question.id,answer:x.cat.questions.find(q=>q.id===s.today.question.id).answer});assert.equal(result.reward.actualAmount,10);assert.equal(result.result.answered,true);assert.equal(result.result.article.id,sourceQuestion.articleId);
 const before=result.state.wallet.balance;await x.action({type:'myth_answer',questionId:s.today.question.id,answer:0});assert.equal((await x.api.state(x.token,x.id)).wallet.balance,before);
 await x.stars.withAccount(x.token,x.id,(client,c)=>x.stars.credit(client,c,{code:'test_daily',ref:'one',amount:82,capped:true}));
 const capped=await x.action({type:'surprise'});assert.equal(capped.reward.actualAmount,3);assert.equal(capped.state.wallet.dailyRemaining,0);
 x.advance(1);const next=await x.action({type:'checkin',mood:'calm'});assert.equal(next.reward.actualAmount,5);
});
test('guess-size fourth question schedule; 41-42 reserve and draft guard',async t=>{
 const x=await setup(t,{day:3});await x.api.state(x.token,x.id);await x.age(20);await x.set({unlocked:{guess_size:1},lastNoveltyDay:20});
 let s=await x.api.state(x.token,x.id);assert.equal(s.today.question.kind,'guess_size');assert.equal(s.today.questions.length,2);assert.equal('answer' in s.today.question,false);
 x.advance(4);s=await x.api.state(x.token,x.id);assert.equal(s.today.questions.length,4);assert.equal(s.today.question.id,'myth-22-2');
 await x.profile({dueDate:new Date(Date.parse('2026-11-16')+(280-41*7)*DAY).toISOString().slice(0,10)});s=await x.api.state(x.token,x.id);assert.equal(s.currentWeek,41);assert.equal(s.today.question,null);assert.equal(s.today.surprise,null);assert.ok(s.today.care);
 const y=await setup(t,{draft:true});await y.api.state(y.token,y.id);await y.age(20);s=await y.api.state(y.token,y.id);assert.equal(s.today.question,null);assert.equal(s.today.surprise,null);await assert.rejects(y.action({type:'myth_answer',questionId:'myth-22-1',answer:1}));
});
test('checklists share bag reward, doctor notes, first kick window and capsule lifecycle',async t=>{
 const x=await setup(t,{week:35});await x.api.state(x.token,x.id);await x.age(30);await x.set({unlocked:{time_capsule:10}});
 let s=await x.api.state(x.token,x.id);const bag=s.checklists.bag;
 for(const item of bag.slice(0,Math.ceil(bag.length*.8)))await x.action({type:'checklist_update',list:'bag',itemId:item.id,status:'done'});
 const before=(await x.api.state(x.token,x.id)).wallet.balance;
 await x.action({type:'checklist_update',list:'bag',itemId:bag.at(-1).id,status:'done'});assert.equal((await x.api.state(x.token,x.id)).wallet.balance,before);
 await x.action({type:'checklist_update',list:'doctor',itemId:s.checklists.doctor[0].id,status:'done',note:'Мой ответ'});assert.equal((await x.api.state(x.token,x.id)).checklists.doctor[0].note,'Мой ответ');
 await assert.rejects(x.action({type:'first_kick'}));
 const cap=await x.action({type:'capsule_save',text:'Личное письмо'});assert.equal(cap.reward.actualAmount,15);assert.equal('text' in cap.state.capsule,false);
 await x.api.preferences(x.token,x.id,{quiet:true});await x.profile({stage:'mother',birthDate:'2026-10-01'});s=await x.api.state(x.token,x.id);assert.equal(s.capsule.opened,false);assert.equal(s.today.surprise,null);
 await x.api.preferences(x.token,x.id,{quiet:false});s=await x.api.state(x.token,x.id);assert.equal(s.capsule.text,'Личное письмо');await assert.rejects(x.action({type:'capsule_delete'}));
 await x.api.preferences(x.token,x.id,{babyPause:true});s=await x.api.state(x.token,x.id);assert.equal('text' in s.capsule,false);assert.deepEqual(s.letters,[]);
});
test('dynamic approved content replaces only correct id and draft edit revokes publication',async t=>{
 const x=await setup(t);const loader=loadGamificationCatalog({pool:x.pool});
 await x.pool.query("INSERT INTO gamification_content(id,kind,body,medical,revision,status,updated_by,updated_at,approved_by,approved_at,evidence) VALUES('myth-22-1','question',$1,true,1,'approved',$2,now(),$2,now(),'review')",[{prompt:'Approved'},x.id]);
 let cat=await loader();assert.equal(cat.questions.find(q=>q.id==='myth-22-1').status,'published');assert.equal(cat.questions.find(q=>q.id==='myth-22-1').medicalApproved,true);assert.equal(cat.questions.find(q=>q.id==='myth-22-2').status,'unpublished');
 await x.pool.query("UPDATE gamification_content SET status='draft',approved_by=NULL,approved_at=NULL WHERE id='myth-22-1'");cat=await loader();assert.equal(cat.questions.find(q=>q.id==='myth-22-1').status,'unpublished');
});

test('first kick is one lifetime bonus and zero cap still completes daily reward; concurrent retries',async t=>{
 const x=await setup(t,{week:20});await x.api.state(x.token,x.id);
 const first=await x.action({type:'first_kick'});assert.equal(first.reward.actualAmount,15);
 const before=first.state.wallet.balance;await x.action({type:'first_kick'});assert.equal((await x.api.state(x.token,x.id)).wallet.balance,before);
 await x.stars.withAccount(x.token,x.id,(client,c)=>x.stars.credit(client,c,{code:'fill',ref:'today',amount:100,capped:true}));
 const body={type:'checkin',mood:'good',requestId:randomUUID()};const results=await Promise.all([x.api.action(x.token,x.id,body),x.api.action(x.token,x.id,body)]);
 assert.equal(results[0].reward.actualAmount,0);assert.equal(results[1].duplicate,true);assert.ok((await x.api.state(x.token,x.id)).today.checkin);
});
test('novelty spacing, 37-week cutoff, 40-week unconditional letter and safe pause',async t=>{
 const x=await setup(t,{week:35});await x.api.state(x.token,x.id);await x.age(40);
 let s=await x.api.state(x.token,x.id);assert.equal(Object.values(s.features).filter(Boolean).length>0,true);
 let data=(await x.pool.query('SELECT data FROM auth_gamification_state WHERE user_id=$1',[x.id])).rows[0].data;assert.equal(Object.keys(data.unlocked).length,1);
 await x.api.state(x.token,x.id);data=(await x.pool.query('SELECT data FROM auth_gamification_state WHERE user_id=$1',[x.id])).rows[0].data;assert.equal(Object.keys(data.unlocked).length,1);
 x.advance(3);await x.api.state(x.token,x.id);data=(await x.pool.query('SELECT data FROM auth_gamification_state WHERE user_id=$1',[x.id])).rows[0].data;assert.equal(Object.keys(data.unlocked).length,2);
 await x.profile({dueDate:new Date(Date.parse('2026-11-15')+(280-40*7)*DAY).toISOString().slice(0,10)});s=await x.api.state(x.token,x.id);assert.ok(s.letters.some(x=>x.week===40));const count=Object.keys(data.unlocked).length;
 data=(await x.pool.query('SELECT data FROM auth_gamification_state WHERE user_id=$1',[x.id])).rows[0].data;assert.equal(Object.keys(data.unlocked).length,count);
 await x.api.preferences(x.token,x.id,{babyPause:true});s=await x.api.state(x.token,x.id);assert.deepEqual(s.letters,[]);assert.equal(s.today.surprise,null);assert.equal(s.today.question,null);assert.deepEqual(s.quests,[]);assert.deepEqual(s.checklists.bag,[]);
});
test('quest active window is enforced; doctor has no reward; capsule delete does not retain text in dedupe log',async t=>{
 const x=await setup(t,{week:22});await x.api.state(x.token,x.id);await x.age(30);let s=await x.api.state(x.token,x.id);
 const q=s.quests.find(q=>q.type!=='bag');assert.ok(q);const done=await x.action({type:'quest_done',questId:q.id});assert.equal(done.reward.actualAmount,15);
 await assert.rejects(x.action({type:'quest_done',questId:x.cat.quests.find(q=>q.week<18).id}),e=>e.code==='feature_unavailable');
 await x.set({unlocked:{time_capsule:10}});await x.action({type:'capsule_save',text:'Удалить меня'});await x.action({type:'capsule_delete'});
 const logs=(await x.pool.query('SELECT payload,result FROM auth_gamification_actions WHERE user_id=$1',[x.id])).rows;assert.equal(JSON.stringify(logs).includes('Удалить меня'),false);
 await x.action({type:'capsule_save',text:'Второе письмо'});assert.equal((await x.pool.query("SELECT count(*)::int AS n FROM auth_points_ledger WHERE user_id=$1 AND event_code='capsule'",[x.id])).rows[0].n,1);
});
test('25-week letter uses wallet dynamic material completion and early letters wait for term',async t=>{
 const x=await setup(t,{week:25});await x.api.state(x.token,x.id);
 const list=Array.from({length:5},(_,i)=>({kind:'article',id:'w25-'+i,week:25}));
 const stars=createStars({pool:x.pool,service:{session:async()=>({id:x.id})},settings:x.config,clock:()=>Date.parse('2026-11-12T09:00:00Z'),catalog:{materials:list}});
 const api=createGamification({pool:x.pool,stars,settings:x.config,clock:()=>Date.parse('2026-11-12T09:00:00Z'),catalog:x.cat});
 for(const m of list)await stars.withAccount(x.token,x.id,(client,c)=>stars.completeMaterial(client,c,{...m}));
 const s=await api.state(x.token,x.id);assert.ok(s.letters.some(l=>l.week===25));assert.equal(s.weeks.find(w=>w.week===25).letter,true);assert.equal(s.weeks.find(w=>w.week===25).total,5);assert.equal(s.weeks.find(w=>w.week===25).completedCount,5);
 await x.pool.query("INSERT INTO auth_stars_weeks(user_id,week,completed_at) VALUES($1,26,now())",[x.id]);assert.equal((await api.state(x.token,x.id)).letters.some(l=>l.week===26),false);
});

test('transactional settings/catalog and notification babyPause/quiet bridge preserve opt-in preferences',async t=>{
 const x=await setup(t);const service={session:async()=>({id:x.id})},settings=createGamificationSettings({pool:x.pool});
 await x.pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[{enabled:true,audience:{mode:'all',userIds:[]},features:{...flags,notifications:true}}]);
 const notifications=createGamificationNotifications({pool:x.pool,service,settings,clock:()=>Date.parse('2026-11-12T09:00:00Z')});
 const api=createGamification({pool:x.pool,stars:x.stars,settings,catalog:loadGamificationCatalog({pool:x.pool}),notifications,clock:()=>Date.parse('2026-11-12T09:00:00Z')});
 await api.state(x.token,x.id);
 await notifications.preferences(x.token,x.id,{types:{daily:false}});
 await api.preferences(x.token,x.id,{babyPause:true,timezone:'Asia/Tokyo',quiet:true});
 let p=await notifications.preferences(x.token,x.id);assert.equal(p.babyPause,true);assert.equal(p.timezone,'Asia/Tokyo');assert.ok(Object.values(p.types).every(v=>v===false));
 await api.preferences(x.token,x.id,{babyPause:false,quiet:false});p=await notifications.preferences(x.token,x.id);assert.equal(p.babyPause,false);assert.equal(p.types.daily,false);assert.equal(p.types.quest,true);
});
test('guess-size ends at week 36 even when previously unlocked; unknown due date never unlocks content',async t=>{
 const x=await setup(t,{week:37,day:3});await x.api.state(x.token,x.id);await x.age(40);await x.set({unlocked:{guess_size:1}});let s=await x.api.state(x.token,x.id);assert.equal(s.features.guess_size,false);assert.equal(s.today.question.kind,'myth');
 await x.profile({dueDate:null});s=await x.api.state(x.token,x.id);assert.equal(s.currentWeek,null);assert.equal(s.today.question,null);assert.equal(s.today.surprise,null);await assert.rejects(x.action({type:'checkin',mood:'good'}),e=>e.code==='feature_unavailable');
});

test('Moscow midnight and repeated weekday one week later produce distinct calendar events',async t=>{
 const x=await setup(t);await x.api.state(x.token,x.id);
 await x.action({type:'checkin',mood:'good'});
 x.advance((12*3600000-1)/DAY);let a=await x.action({type:'checkin',mood:'tired'});assert.equal(a.reward.actualAmount,0);
 x.advance(1/DAY);a=await x.action({type:'checkin',mood:'calm'});assert.equal(a.reward.actualAmount,5);
 x.advance(6);a=await x.action({type:'checkin',mood:'good'});assert.equal(a.reward.actualAmount,5);
 const refs=(await x.pool.query("SELECT event_ref FROM auth_points_ledger WHERE user_id=$1 AND event_code='checkin' ORDER BY event_ref",[x.id])).rows.map(x=>x.event_ref);
 assert.deepEqual(refs,['2026-11-12','2026-11-13','2026-11-19']);
});

test('wallet and purchased week survive daily rollback; saved capsule/letters survive individual game off',async t=>{
 const x=await setup(t,{week:22});await x.api.state(x.token,x.id);await x.age(30);
 await x.set({unlocked:{time_capsule:10}});await x.action({type:'capsule_save',text:'Сохранено'});
 await x.pool.query('INSERT INTO auth_stars_week_purchases(user_id,week,request_id,purchased_at) VALUES($1,23,$2,now())',[x.id,randomUUID()]);
 await x.pool.query('INSERT INTO auth_stars_weeks(user_id,week,completed_at,released_at,letter) VALUES($1,22,now(),now(),true)',[x.id]);
 x.config.features.daily=false;x.config.features.capsule=false;x.config.features.games=false;
 const s=await x.api.state(x.token,x.id);assert.equal(s.enabled,true);assert.equal(s.dailyEnabled,false);assert.equal(s.today,null);assert.equal(s.wallet.balance,115);assert.equal(s.weeks.length,42);assert.equal(s.weeks.find(w=>w.week===23).purchased,true);assert.equal(s.weeks.find(w=>w.week===23).available,true);assert.equal(s.features.time_capsule,true);assert.ok(s.letters.some(l=>l.week===22));
 await assert.rejects(x.action({type:'checkin',mood:'good'}),e=>e.code==='feature_unavailable');
});
test('background scheduler creates deduplicated events without token, visit or GetCourse and respects pauses/postpartum',async t=>{
 const x=await setup(t,{week:22});await x.api.state(x.token,x.id);await x.age(10);
 const settings=createGamificationSettings({pool:x.pool});await x.pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[{enabled:true,audience:{mode:'all',userIds:[]},features:{...flags,notifications:true}}]);
 await x.pool.query('INSERT INTO gamification_notification_preferences(user_id,value) VALUES($1,$2)',[x.id,{pushEnabled:true}]);
 const service={session:()=>{throw new Error('Background must not use session/GetCourse');}};
 let now=Date.parse('2026-11-19T09:00:00Z');const clock=()=>now;
 const notifications=createGamificationNotifications({pool:x.pool,service,settings,clock});
 x.cat.inventory=Array.from({length:5},(_,i)=>({kind:'article',id:'pending-'+i,week:23}));
 for(const m of x.cat.inventory.slice(0,4))await x.pool.query('INSERT INTO auth_stars_material_progress(user_id,kind,material_id,week,completed_at) VALUES($1,$2,$3,$4,$5)',[x.id,m.kind,m.id,m.week,new Date(now)]);
 const scheduler=createGamification({pool:x.pool,stars:{withAccount:service.session,materials:()=>{throw new Error('No remote inventory fallback in worker');}},service,settings,catalog:x.cat,notifications,clock});
 const before=(await x.pool.query('SELECT sum(amount)::int AS n FROM auth_points_ledger WHERE user_id=$1',[x.id])).rows[0].n;
 const tick=await scheduler.scheduleNotifications();assert.equal(tick.processed,1);await scheduler.scheduleNotifications();
 let rows=(await x.pool.query('SELECT event_key,type FROM gamification_notifications WHERE user_id=$1',[x.id])).rows;
 assert.equal(rows.filter(r=>r.event_key==='new-week-23').length,1);assert.equal(rows.filter(r=>r.event_key==='daily-2026-11-19').length,1);assert.equal(rows.filter(r=>r.event_key==='almost-23').length,1);assert.ok(rows.some(r=>r.type==='quest'));
 assert.equal((await x.pool.query('SELECT sum(amount)::int AS n FROM auth_points_ledger WHERE user_id=$1',[x.id])).rows[0].n,before);
 await x.set({preferences:{quiet:true,babyPause:false}});now+=DAY;assert.equal((await scheduler.scheduleNotifications()).processed,0);
 await x.set({preferences:{quiet:false,babyPause:true}});assert.equal((await scheduler.scheduleNotifications()).processed,0);
 await x.set({preferences:{quiet:false,babyPause:false},capsule:{text:'Личное письмо',opened:null,saved:'2026-10-01'}});await x.profile({stage:'mother',birthDate:'2026-10-01'});
 await scheduler.scheduleNotifications();rows=(await x.pool.query('SELECT event_key,type FROM gamification_notifications WHERE user_id=$1',[x.id])).rows;assert.equal(rows.filter(r=>r.event_key==='capsule').length,1);assert.equal(rows.filter(r=>r.event_key==='daily-2026-11-20').length,0);
});

test('visits are unique Moscow days, disabled rollout and scheduler do not fabricate retention',async t=>{
 const x=await setup(t);
 await x.pool.query('CREATE TABLE IF NOT EXISTS auth_gamification_visits(user_id uuid NOT NULL REFERENCES auth_users(id),moscow_day date NOT NULL,PRIMARY KEY(user_id,moscow_day))');
 await x.api.state(x.token,x.id);await x.api.state(x.token,x.id);x.advance(1);await x.api.state(x.token,x.id);
 assert.equal((await x.pool.query('SELECT count(*)::int AS n FROM auth_gamification_visits WHERE user_id=$1',[x.id])).rows[0].n,2);
 x.config.enabled=false;x.advance(1);await x.api.state(x.token,x.id);
 assert.equal((await x.pool.query('SELECT count(*)::int AS n FROM auth_gamification_visits WHERE user_id=$1',[x.id])).rows[0].n,2);
});

test('care pool does not repeat until exhausted, practice uses available video and day seven derives real summary',async t=>{
 const x=await setup(t,{week:22,day:2});await x.api.state(x.token,x.id);await x.age(4);
 x.cat.care=[pub({id:'care-a',text:'Карточка А',trimester:'II'}),pub({id:'care-b',text:'Карточка Б',trimester:'II'})];x.cat.ideas=[];
 const first=await x.action({type:'surprise'});assert.equal(first.state.today.surprise.id,first.result.card.id);
 x.advance(2);const second=await x.action({type:'surprise'});assert.notEqual(first.result.card.id,second.result.card.id);assert.equal(second.state.today.surprise.id,second.result.card.id);
 x.cat.inventory=[{id:'practice-22',kind:'video',week:22}];x.cat.materials=[{...x.cat.inventory[0],title:'Дыхание и расслабление',accessible:true}];
 x.advance(2);let s=await x.api.state(x.token,x.id);assert.equal(s.today.surprise.material.id,'practice-22');
 x.advance(1);s=await x.api.state(x.token,x.id);assert.equal(s.today.day,7);assert.equal(s.today.surprise.summary.total,1);assert.equal(s.today.surprise.summary.earned,110);assert.match(s.today.surprise.text,/0 из 1/);
});

test('pre-existing notification babyPause is inherited before the first daily visit',async t=>{
 const x=await setup(t);await x.pool.query('INSERT INTO gamification_notification_preferences(user_id,value) VALUES($1,$2)',[x.id,{babyPause:true,timezone:'Asia/Tokyo'}]);
 const s=await x.api.state(x.token,x.id);assert.equal(s.preferences.babyPause,true);assert.equal(s.preferences.timezone,'Asia/Tokyo');assert.equal(s.today.surprise,null);assert.deepEqual(s.letters,[]);
});
test('checkin symptoms use only approved urgent source, each new action is checked and revoked source cannot replay',async t=>{
 const x=await setup(t);const source=JSON.parse(await readFile(new URL('../content/gamification-source.json',import.meta.url)));
 let a=await x.action({type:'checkin',mood:'anxious',tags:['кровь']});assert.equal(a.result,null);assert.equal(a.state.today.urgent,null);
 await x.pool.query("INSERT INTO gamification_content(id,kind,body,medical,revision,status,updated_by,updated_at,approved_by,approved_at,evidence) VALUES('urgent-help','urgent',$1,true,1,'approved',$2,now(),$2,now(),'medical-review')",[{paragraphs:source.urgent_help_source},x.id]);
 const request={type:'checkin',mood:'unwell',tags:['кровь'],requestId:randomUUID()};a=await x.api.action(x.token,x.id,request);assert.equal(a.result.urgent.free,true);assert.equal(a.state.today.urgent.contentId,'urgent-help');assert.equal(a.reward.actualAmount,0);
 a=await x.action({type:'checkin',mood:'unwell',tags:['сильная боль']});assert.equal(a.result.urgent.free,true);
 await x.pool.query("UPDATE gamification_content SET status='draft',approved_by=NULL,approved_at=NULL WHERE id='urgent-help'");
 a=await x.api.action(x.token,x.id,request);assert.equal(a.result,null);assert.equal(a.state.today.urgent,null);
});

test('selected audience excludes state actions and background events while keeping the existing ledger',async t=>{
 const x=await setup(t);await x.api.state(x.token,x.id);
 x.config.audience={mode:'selected',userIds:[]};
 const s=await x.api.state(x.token,x.id);assert.equal(s.enabled,false);assert.equal(s.wallet.balance,100);
 await assert.rejects(x.action({type:'checkin',mood:'good'}),e=>e.code==='feature_unavailable');
 x.config.features.notifications=true;await x.pool.query('INSERT INTO gamification_notification_preferences(user_id,value) VALUES($1,$2)',[x.id,{pushEnabled:true}]);
 const events=[];const scheduler=createGamification({pool:x.pool,stars:x.stars,settings:x.config,catalog:x.cat,notifications:{enqueue:async(_client,e)=>events.push(e)},clock:()=>Date.parse('2026-11-12T09:00:00Z')});
 assert.equal((await scheduler.scheduleNotifications()).processed,0);assert.equal(events.length,0);
});

test('real root catalog keeps accessible metadata and preserved legacy weeks without future text leakage',async t=>{
 const x=await setup(t,{week:22});await x.api.state(x.token,x.id);await x.age(5);x.config.features.weekLocks=true;
 const db=openDatabase(':memory:',false);t.after(()=>db.close());
 const insert=db.prepare('INSERT INTO articles(id,number,week,title,minutes,blocks,status) VALUES(?,?,?,?,1,?,?)');
 insert.run('live-22',9001,22,'Дыхание и тревога','[]','published');insert.run('future-24',9002,24,'SECRET_FUTURE_TITLE','[]','published');
 const catalog=createStarsCatalog({db,contentCatalog:x.cat});
 const service={session:async()=>({id:x.id})},clock=()=>Date.parse('2026-11-12T09:00:00Z');
 const stars=createStars({pool:x.pool,service,settings:x.config,catalog,clock});
 const api=createGamification({pool:x.pool,service,stars,settings:x.config,catalog:catalog.daily,clock});
 let s=await api.state(x.token,x.id);assert.equal(s.weeks.length,42);assert.equal(s.weeks.find(w=>w.week===24).locked,true);
 assert.equal(s.today.recommendations.find(m=>m.id==='live-22').title,'Дыхание и тревога');assert.equal(JSON.stringify(s).includes('SECRET_FUTURE_TITLE'),false);
 const checked=await api.action(x.token,x.id,{type:'checkin',mood:'anxious',requestId:randomUUID()});assert.ok(checked.state.today.recommendations.some(m=>m.id==='live-22'));assert.ok(checked.state.today.recommendations.every(m=>m.title));
 await x.pool.query('UPDATE auth_stars_wallet SET preserved_weeks=ARRAY[24] WHERE user_id=$1',[x.id]);s=await api.state(x.token,x.id);
 assert.equal(s.weeks.find(w=>w.week===24).locked,false);assert.equal(s.weeks.find(w=>w.week===24).available,true);assert.equal(s.weeks.find(w=>w.week===25).locked,true);assert.equal(JSON.stringify(s).includes('SECRET_FUTURE_TITLE'),false);
});

test('scratch flip and choose persist their reveal and selected card with one daily reward',async t=>{
 const x=await setup(t,{week:32,day:2});await x.api.state(x.token,x.id);await x.age(40);await x.set({unlocked:{surprise_scratch:1,surprise_flip:4,surprise_pick3:7},lastNoveltyDay:40});
 let a=await x.action({type:'game_reveal',format:'choose',choice:2});assert.equal(a.reward.actualAmount,5);assert.deepEqual(a.state.today.reveal,{format:'choose',choice:2});
 a=await x.action({type:'game_reveal',format:'choose',choice:0});assert.equal(a.reward.actualAmount,0);assert.equal(a.state.today.reveal.choice,2);
 x.advance(1);a=await x.action({type:'game_reveal',format:'flip'});assert.equal(a.reward.actualAmount,5);assert.equal(a.state.today.reveal.format,'flip');
 x.advance(1);a=await x.action({type:'game_reveal',format:'scratch'});assert.equal(a.reward.actualAmount,5);assert.equal((await x.api.state(x.token,x.id)).today.reveal.format,'scratch');
});

test('approved source hints use settings, suppress drafts and never repeat a feature with one hint per Moscow day',async t=>{
 const x=await setup(t,{week:25});let s=await x.api.state(x.token,x.id);assert.equal(s.presentation.hint,null);
 x.cat.hints=x.cat.hints.map(pub);x.config.rewards={checkin:9,weekComplete:77,quest:21,kicks:6,welcome:222};
 s=await x.api.state(x.token,x.id);assert.equal(s.presentation.hint.feature,'checkin');assert.match(s.presentation.hint.text,/\+9 ★/);
 let a=await x.action({type:'feature_hint_seen',feature:'checkin'});assert.equal(a.result.shown,true);assert.equal(a.reward,null);assert.equal(a.state.presentation.hint,null);
 a=await x.action({type:'feature_hint_seen',feature:'week_ring'});assert.equal(a.result.shown,false);
 x.advance(1);s=await x.api.state(x.token,x.id);assert.equal(s.presentation.hint.feature,'week_ring');assert.match(s.presentation.hint.text,/все материалы недели/);assert.match(s.presentation.hint.text,/\+77 ★/);assert.equal(s.presentation.hint.text.includes('6 материалов'),false);
 await x.action({type:'feature_hint_seen',feature:'week_ring'});x.advance(1);s=await x.api.state(x.token,x.id);assert.notEqual(s.presentation.hint?.feature,'checkin');assert.notEqual(s.presentation.hint?.feature,'week_ring');
 const next=s.presentation.hint;x.cat.hints.find(h=>h.id===next.id).status='unpublished';s=await x.api.state(x.token,x.id);assert.notEqual(s.presentation.hint?.id,next.id);
});
test('celebrations acknowledge only own real ledger events, once per event and real login, without a reward',async t=>{
 const x=await setup(t);let s=await x.api.state(x.token,x.id),welcome=s.presentation.celebration;assert.equal(welcome.kind,'welcome');assert.match(welcome.body,/100 ★/);
 x.config.rewards={welcome:999};s=await x.api.state(x.token,x.id);assert.match(s.presentation.celebration.body,/100 ★/);
 await x.stars.withAccount(x.token,x.id,(client,c)=>x.stars.credit(client,c,{code:'week_complete',ref:'22',amount:50,capped:false}));
 const week=String((await x.pool.query("SELECT id FROM auth_points_ledger WHERE user_id=$1 AND event_code='week_complete'",[x.id])).rows[0].id);
 const other=randomUUID();await x.pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,2,$3)',[other,other+'@example.invalid',{}]);
 const foreign=String((await x.pool.query("INSERT INTO auth_points_ledger(user_id,event_code,event_ref,amount,capped,occurred_at,moscow_day) VALUES($1,'welcome','once',100,false,now(),'2026-11-12') RETURNING id",[other])).rows[0].id);
 await assert.rejects(x.action({type:'celebration_seen',eventId:foreign}),e=>e.code==='feature_unavailable');
 const before=(await x.api.state(x.token,x.id)).wallet.balance;let a=await x.action({type:'celebration_seen',eventId:welcome.eventId});assert.equal(a.result.shown,true);assert.equal(a.reward,null);assert.equal(a.state.wallet.balance,before);assert.equal(a.state.presentation.celebration,null);
 a=await x.action({type:'celebration_seen',eventId:week});assert.equal(a.result.shown,false);
 const nextToken=randomUUID();await x.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[x.id]);await x.pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(nextToken),x.id,new Date('2027-11-12')]);
 await x.api.preferences(nextToken,x.id,{babyPause:true});s=await x.api.state(nextToken,x.id);assert.equal(s.presentation.celebration,null);
 await x.api.preferences(nextToken,x.id,{babyPause:false});await x.profile({stage:'mother',birthDate:'2026-10-01'});assert.equal((await x.api.state(nextToken,x.id)).presentation.celebration,null);
 await x.profile({stage:'pregnancy',birthDate:null});s=await x.api.state(nextToken,x.id);assert.equal(s.presentation.celebration.eventId,week);
 a=await x.api.action(nextToken,x.id,{type:'celebration_seen',eventId:week,requestId:randomUUID()});assert.equal(a.result.shown,true);assert.equal(a.state.presentation.celebration,null);
 a=await x.api.action(nextToken,x.id,{type:'celebration_seen',eventId:week,requestId:randomUUID()});assert.equal(a.result.shown,false);
});
