import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fixture,subscription} from './gamification-admin-fixture.mjs';
import {subscriptionValue,notificationQuiet,localNotificationTime,createGamificationPushTransport} from '../auth/gamification-notifications.mjs';
import {generateVAPIDKeys,generateRequestDetails} from 'web-push';
import {hashToken} from '../auth/security.mjs';

test('push allowlist blocks SSRF and validates subscription keys; mandatory local quiet hours',()=>{
 for(const url of ['https://127.0.0.1/push','https://evil.test/push','https://fcm.googleapis.com.evil.test/push','https://fcm.googleapis.com:8443/push','http://fcm.googleapis.com/push','https://name:secret@fcm.googleapis.com/push'])assert.throws(()=>subscriptionValue(subscription(url)));
 assert.ok(subscriptionValue(subscription()).endpoint.startsWith('https://fcm.googleapis.com/'));assert.throws(()=>subscriptionValue({...subscription(),keys:{auth:'a',p256dh:'b'}}));
 assert.equal(notificationQuiet(Date.parse('2026-11-12T18:00Z'),{timezone:'Europe/Moscow',quietStart:0,quietEnd:0}),true);
 assert.equal(notificationQuiet(Date.parse('2026-11-12T06:00Z'),{timezone:'Europe/Moscow',quietStart:0,quietEnd:0}),false);
 assert.equal(localNotificationTime(Date.parse('2026-11-12T22:00Z'),'Asia/Tokyo').day,'2026-11-13');
});
test('installed web-push v4 constructs encrypted VAPID request completely offline',async()=>{
 const keys=generateVAPIDKeys(),sub=subscription();const send=await createGamificationPushTransport({...keys,subject:'mailto:test@example.invalid'});assert.equal(typeof send,'function');
 const request=generateRequestDetails(sub,JSON.stringify({title:'Лёгкие роды'}),{vapidDetails:{...keys,subject:'mailto:test@example.invalid'},TTL:3600,timeout:10000});
 assert.equal(request.method,'POST');assert.ok(request.body.length>0);assert.ok(request.headers.Authorization);assert.equal(request.endpoint,sub.endpoint);
});
test('notifications prefs cannot target another account; capsule survives birth but obeys pause; daily pause stays canonical',async t=>{
 const x=await fixture(t);await assert.rejects(x.notices.preferences(x.token,x.id,{userId:x.other,babyPause:true}),e=>e.code==='invalid_notifications');
 await x.pool.query('INSERT INTO auth_gamification_state(user_id,first_day) VALUES($1,$2)',[x.id,'2026-11-12']);
 await x.pool.query('UPDATE auth_users SET profile=$2 WHERE id=$1',[x.id,{stage:'mother',birthDate:'2026-10-01'}]);
 assert.equal(await x.enqueue('pregnancy','new_week',{babyRelated:true}),null);assert.ok(await x.enqueue('capsule','capsule',{babyRelated:true}));assert.equal((await x.notices.list(x.token,x.id)).items.length,1);
 await x.notices.preferences(x.token,x.id,{babyPause:true});assert.equal((await x.notices.list(x.token,x.id)).items.length,0);assert.equal((await x.pool.query('SELECT data FROM auth_gamification_state')).rows[0].data.preferences.babyPause,true);
 await assert.rejects(x.notices.list(x.token,x.other),e=>e.code==='account_changed');
});
test('one presentation per authenticated login regardless of forged sessionId',async t=>{
 const x=await fixture(t);assert.equal((await x.notices.claimPresentation(x.token,x.id,{kind:'celebration',sessionId:'a'.repeat(16)})).allowed,true);assert.equal((await x.notices.claimPresentation(x.token,x.id,{kind:'celebration',sessionId:'b'.repeat(16)})).allowed,false);
 assert.equal((await x.notices.claimPresentation(x.token,x.id,{kind:'hint'})).allowed,true);assert.equal((await x.notices.claimPresentation(x.token,x.id,{kind:'hint'})).allowed,false);
});
test('queue selects new-week priority once per local day; payload never carries private text',async t=>{
 const x=await fixture(t);await x.notices.subscribe(x.token,x.id,subscription());await x.enqueue('quest','quest');await x.enqueue('newweek','new_week');
 assert.deepEqual(await x.notices.processQueue(),{sent:1});assert.equal(x.sent.length,1);assert.equal(x.sent[0].payload.body,'Для вас есть новое уведомление в приложении.');assert.equal(x.sent[0].payload.title,'Лёгкие роды');
 assert.equal(x.sent[0].payload.accountId,x.id);assert.equal(x.sent[0].payload.sessionId,hashToken(hashToken(x.token)));
 const rows=(await x.pool.query('SELECT type,push_state FROM gamification_notifications')).rows;assert.equal(rows.find(x=>x.type==='new_week').push_state,'sent');assert.equal(rows.find(x=>x.type==='quest').push_state,'suppressed');
 await x.enqueue('later','feature');await x.notices.processQueue();assert.equal(x.sent.length,1);
});
test('quiet, visit, revoked-session, disabled consent and ambiguous sends never leak or retry',async t=>{
 const x=await fixture(t);await x.notices.subscribe(x.token,x.id,subscription());await x.enqueue('daily');await x.notices.visit(x.token,x.id);await x.notices.processQueue();assert.equal(x.sent.length,0);
 await x.enqueue('feature','feature');x.setTime('2026-11-12T18:00Z');await x.notices.processQueue();assert.equal(x.sent.length,0);x.setTime('2026-11-12T09:00Z');
 await x.pool.query('UPDATE auth_sessions SET revoked_at=now()');await x.notices.processQueue();assert.equal(x.sent.length,0);
});
test('ambiguous provider error consumes day and is never retried',async t=>{
 const x=await fixture(t);await x.notices.subscribe(x.token,x.id,subscription());await x.enqueue('feature','feature');let attempts=0;x.transport(async()=>{attempts++;throw new Error('Timeout after possible acceptance');});
 await x.notices.processQueue();await x.notices.processQueue();assert.equal(attempts,1);assert.equal((await x.pool.query('SELECT state FROM gamification_push_days')).rows[0].state,'ambiguous');
});
test('final outbound check suppresses consent revoked after reservation',async t=>{
 const x=await fixture(t);await x.notices.subscribe(x.token,x.id,subscription());await x.enqueue('feature','feature');
 const original=x.pool.connect.bind(x.pool);let commits=0;
 const wrapped={query:(...args)=>x.pool.query(...args),connect:async()=>{const client=await original(),query=client.query.bind(client);return {release:()=>client.release(),query:async(sql,args)=>{if(sql==='COMMIT'&&++commits===1)await query("UPDATE gamification_notification_preferences SET value=value || '{\"pushEnabled\":false}'::jsonb WHERE user_id=$1",[x.id]);return query(sql,args);}};}};
 await x.noticesWithPool(wrapped).processQueue();assert.equal(x.sent.length,0);
});
test('browser worker checks fresh session, consent and item visibility for delayed pushes',async()=>{
 const code=await readFile(new URL('../../Фронт/push-worker.js',import.meta.url),'utf8');
 for(const mode of ['ok','logout','different','paused','replaced','hidden','error']){
  let handler,task,shown=0;const payload={id:'1',accountId:'a',sessionId:'session'};
  const self={addEventListener:(name,fn)=>{if(name==='push')handler=fn;},registration:{showNotification:async()=>shown++}};
  const fetch=async url=>{if(mode==='error')throw new Error('Offline');return {ok:true,json:async()=>url.endsWith('/session')?{user:mode==='logout'?null:{id:mode==='different'?'b':'a'}}:{accountId:'a',pushSessionId:mode==='replaced'?'other':'session',pushPublicKey:'key',preferences:{pushEnabled:mode!=='paused',types:{feature:true},timezone:'Europe/Moscow',quietStart:21,quietEnd:9},items:mode==='hidden'?[]:[{id:'1',type:'feature'}]}};};
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:['2026-11-12T09:00Z']));}}
  vm.runInNewContext(code,{self,fetch,URL,Intl,Date:FixedDate});handler({data:{json:()=>payload},waitUntil:p=>task=p});await task;assert.equal(shown,mode==='ok'?1:0,mode);
 }
});
