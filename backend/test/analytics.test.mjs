import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testPool} from './auth-pool.mjs';
import {createAnalytics,validateAnalyticsBatch} from '../auth/analytics.mjs';
import {hashToken,COOKIE_NAME,randomToken} from '../auth/security.mjs';
import {createAuthServer} from '../auth/http.mjs';
import {createAdmin} from '../auth/admin.mjs';
import {createAdminHttp} from '../auth/admin-http.mjs';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';

const event=(extra={})=>({eventId:randomUUID(),visitId:randomUUID(),type:'page_view',page:'index.html',...extra});
async function fixture(t) {
  const db=await testPool();t.after(()=>db.close());const {pool}=db;
  await pool.query('CREATE TABLE admin_editors(user_id uuid PRIMARY KEY REFERENCES auth_users(id))');
  const migration=await readFile(new URL('../auth/analytics-migration.sql',import.meta.url),'utf8');await pool.query(migration);
  const id=randomUUID(),other=randomUUID(),owner=randomUUID(),token=randomToken(),ownerToken=randomToken();
  for (const [i,uid] of [id,other,owner].entries()) await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$3,$4)',[uid,uid+'@example.invalid',i+1,{completedAt:'yes'}]);
  for (const [uid,key] of [[id,token],[owner,ownerToken]]) await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(key),uid,new Date('2099-01-01')]);
  let now=Date.parse('2026-11-14T21:30:00Z'),role='owner';
  const limits=[],analytics=createAnalytics({pool,clock:()=>now,ownerEmail:owner+'@example.invalid',store:{rateLimit:async(...args)=>limits.push(args)},admin:{session:async()=>({id:owner,role})},titleForResource:(type,id)=>type==='article'&&id==='pregnancy-001'?'Название статьи':null});
  return {pool,id,other,owner,token,ownerToken,analytics,limits,migration,setTime:v=>now=Date.parse(v),setRole:v=>role=v};
}

test('strict codes reject raw URLs, text, identity, bad fields and oversized batches',()=>{
  assert.equal(validateAnalyticsBatch({events:[event()]}).length,1);
  for(const patch of [{userId:randomUUID()},{text:'private'},{page:'article.html?name=private'},{resourceType:'article',resourceId:'https://private'},{activeMs:1},{type:'active_time',activeMs:60001},{type:'error',action:'raw_error'},{type:'transition'},{type:'article_progress',resourceType:'video',resourceId:'v',progress:100},{type:'ai_request',format:'image',outcome:'accepted'},{progress:43}])assert.throws(()=>validateAnalyticsBatch({events:[event(patch)]}));
  assert.throws(()=>validateAnalyticsBatch({events:Array.from({length:31},()=>event())}));
  assert.throws(()=>validateAnalyticsBatch({events:[],name:'private'}));
  assert.throws(()=>validateAnalyticsBatch({events:[event()],accountId:randomUUID()}));
});

test('ingest binds live session/profile, atomically validates batch, deduplicates retries and excludes staff/tests',async t=>{
  const x=await fixture(t),batch={events:[event(),event({type:'active_time',activeMs:60000})]};
  assert.deepEqual(await x.analytics.ingest(x.token,x.id,batch),{accepted:2});
  assert.deepEqual(await x.analytics.ingest(x.token,x.id,batch),{accepted:0});
  assert.equal(x.limits[0][0],'analytics_user');
  await assert.rejects(x.analytics.ingest(x.token,x.other,batch),e=>e.code==='account_changed');
  await assert.rejects(x.analytics.ingest(null,x.id,batch),e=>e.code==='sign_in_required');
  await assert.rejects(x.analytics.ingest(x.token,x.id,{events:[event(),event({text:'secret'})]}),e=>e.code==='invalid_analytics');
  assert.equal((await x.pool.query('SELECT COUNT(*)::int AS n FROM auth_analytics_events')).rows[0].n,2);
  assert.equal((await x.analytics.ingest(x.ownerToken,x.owner,{events:[event()]})).excluded,true);
  await x.pool.query('INSERT INTO admin_editors(user_id) VALUES($1)',[x.id]);
  assert.equal((await x.analytics.ingest(x.token,x.id,{events:[event()]})).excluded,true);
  await x.pool.query('DELETE FROM admin_editors');await x.pool.query('INSERT INTO auth_analytics_exclusions(user_id) VALUES($1)',[x.id]);
  assert.equal((await x.analytics.ingest(x.token,x.id,{events:[event()]})).excluded,true);
  await x.pool.query('UPDATE auth_users SET profile=NULL WHERE id=$1',[x.id]);
  await assert.rejects(x.analytics.ingest(x.token,x.id,batch),e=>e.code==='profile_required');
  await x.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1',[x.id]);
  await assert.rejects(x.analytics.ingest(x.token,x.id,batch),e=>e.code==='sign_in_required');
});

test('revocation between preliminary authorization and transaction fails closed',async t=>{
  const x=await fixture(t);
  const analytics=createAnalytics({pool:x.pool,store:{rateLimit:()=>x.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1',[x.id])}});
  await assert.rejects(analytics.ingest(x.token,x.id,{events:[event()]}),e=>e.code==='sign_in_required');
  assert.equal((await x.pool.query('SELECT COUNT(*)::int AS n FROM auth_analytics_events')).rows[0].n,0);
});

test('owner report uses Moscow calendar, true uniques, trusted titles, milestone dedup and live exclusions',async t=>{
  const x=await fixture(t),visitId=randomUUID(),resource={visitId,resourceType:'article',resourceId:'pregnancy-001'};
  await x.analytics.ingest(x.token,x.id,{events:[event({visitId}),event({...resource,type:'content_open'}),event({...resource,type:'active_time',activeMs:60000}),event({...resource,type:'article_progress',progress:100}),event({...resource,type:'article_progress',progress:100}),event({visitId,type:'transition',fromPage:'index.html',page:'article.html'}),event({visitId,type:'ai_request',page:'ai.html',format:'text',outcome:'accepted'}),event({visitId,type:'ai_result',page:'ai.html',format:'text',outcome:'completed'}),event({visitId,type:'error',action:'network'})]});
  const video={visitId,resourceType:'video',resourceId:'week-video-004'};
  await x.analytics.ingest(x.token,x.id,{events:[event({...video,type:'content_open'}),event({...video,type:'video_start'}),event({...video,type:'video_progress',progress:90}),event({...video,type:'video_progress',progress:100}),event({...video,type:'video_completed'})]});
  const r=await x.analytics.report(x.ownerToken,x.owner,7);
  assert.deepEqual(r.period,{days:7,timezone:'Europe/Moscow',from:'2026-11-09',to:'2026-11-15'});
  assert.equal(r.overview.users,1);assert.equal(r.overview.visits,1);assert.equal(r.overview.activeMs,60000);assert.equal(r.daily[0].day,'2026-11-15');
  assert.equal(r.content.find(v=>v.type==='article').title,'Название статьи');assert.equal(r.content.find(v=>v.type==='article').completed,1);
  assert.equal(r.videos[0].completed,1);assert.equal(r.videos[0].progress90,1);assert.equal(r.videos[0].starts,1);
  assert.deepEqual(r.errors,[{action:'network',count:1,users:1}]);assert.equal(r.ai.length,2);assert.equal(r.transitions[0].from,'index.html');
  assert.ok(!JSON.stringify(r).includes(x.id));assert.ok(!JSON.stringify(r).includes('@example.invalid'));
  x.setRole('editor');await assert.rejects(x.analytics.report(x.ownerToken,x.owner),e=>e.code==='admin_forbidden');x.setRole('owner');
  await assert.rejects(x.analytics.report(x.ownerToken,x.owner,14),e=>e.code==='invalid_analytics');
  await x.pool.query('INSERT INTO auth_analytics_exclusions(user_id) VALUES($1)',[x.id]);
  assert.equal((await x.analytics.report(x.ownerToken,x.owner)).overview.users,0);
});

test('period boundaries exclude earlier Moscow day and retention preserves metadata and unrelated business data',async t=>{
  const x=await fixture(t);
  x.setTime('2026-11-08T20:59:59Z');await x.analytics.ingest(x.token,x.id,{events:[event()]});
  x.setTime('2026-11-08T21:00:00Z');await x.analytics.ingest(x.token,x.id,{events:[event()]});
  x.setTime('2026-11-14T21:30:00Z');const r=await x.analytics.report(x.ownerToken,x.owner);assert.equal(r.overview.screenViews,1);
  await x.pool.query("UPDATE auth_analytics_events SET recorded_at='2026-07-01'");
  assert.equal((await x.analytics.report(x.ownerToken,x.owner,90)).overview.users,0);
  await x.analytics.cleanup();await x.pool.query(x.migration);
  assert.equal((await x.pool.query('SELECT COUNT(*)::int AS n FROM auth_analytics_events')).rows[0].n,0);
  assert.equal((await x.analytics.report(x.ownerToken,x.owner)).collectionStartedAt,r.collectionStartedAt);
  assert.equal((await x.pool.query('SELECT COUNT(*)::int AS n FROM auth_users')).rows[0].n,3);
});

function invoke(server,body,headers={}) {
  const request=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);Object.assign(request,{url:'/api/auth/analytics/events',method:'POST',headers:{'content-type':'application/json',origin:'https://app.legkie-rody.ru','x-webpril-account':'test',...headers},socket:{remoteAddress:'127.0.0.1'}});
  return new Promise(resolve=>{const response=Object.assign(new EventEmitter(),{destroyed:false,setHeader(){},writeHead(status){this.status=status;},end(raw){resolve({status:this.status,body:JSON.parse(raw)});}});server.emit('request',request,response);});
}
test('HTTP ingest enforces origin, account, JSON bounds and remains available without gamification',async()=>{
  const calls=[],server=createAuthServer({enabled:true,origin:'https://app.legkie-rody.ru',service:{session:async()=>({id:'test'})},store:{rateLimit:async()=>{}},analytics:{ingest:async(...args)=>{calls.push(args);return {accepted:1};}}});
  assert.equal((await invoke(server,{events:[event()]})).status,200);
  assert.equal((await invoke(server,{events:[event()]},{origin:'https://other.invalid'})).status,403);
  assert.equal((await invoke(server,{events:[event()]},{'x-webpril-account':'changed'})).status,409);
  assert.equal((await invoke(server,' '.repeat(32769))).status,413);
  assert.equal((await invoke(server,'invalid')).status,400);
  assert.equal(calls.length,1);
});

test('admin HTTP exposes only owner aggregates with strict period/host/account and live cookie checks',async t=>{
  const x=await fixture(t),origin='https://admin.example.invalid';
  const admin=createAdmin({pool:x.pool,articles:{},ownerEmail:x.owner+'@example.invalid',appOrigin:'https://app.legkie-rody.ru'});
  const analytics=createAnalytics({pool:x.pool,admin,ownerEmail:x.owner+'@example.invalid'});
  const adminHttp=await createAdminHttp({admin,analytics,origin,frontend:fileURLToPath(new URL('../../Фронт/admin/',import.meta.url))});
  const server=createAuthServer({enabled:true,origin:'https://app.legkie-rody.ru',adminHttp});
  function get(path,token=x.ownerToken,account=x.owner,host='admin.example.invalid') {
    const request=Readable.from([]);Object.assign(request,{method:'GET',url:path,headers:{host,cookie:COOKIE_NAME+'='+token,'x-webpril-account':account},socket:{remoteAddress:'127.0.0.1'}});
    return new Promise(resolve=>{const response=Object.assign(new EventEmitter(),{destroyed:false,setHeader(){},writeHead(status,headers){this.status=status;this.headers=headers;},end(raw){resolve({status:this.status,headers:this.headers,body:JSON.parse(raw)});}});server.emit('request',request,response);});
  }
  assert.equal((await get('/api/admin/analytics?days=7')).status,200);
  assert.equal((await get('/api/admin/analytics?days=30')).body.period.days,30);
  assert.equal((await get('/api/admin/analytics?days=90')).body.period.days,90);
  for(const query of ['days=8','days=7&days=30','days=7&name=private','days=7&extra=1']) assert.equal((await get('/api/admin/analytics?'+query)).status,400);
  assert.equal((await get('/api/admin/analytics?days=7',x.ownerToken,x.other)).status,409);
  assert.equal((await get('/api/admin/analytics?days=7',x.ownerToken,x.owner,'other.invalid')).status,404);
  assert.equal((await get('/api/admin/analytics?days=7','missing')).status,401);
  assert.equal((await get('/api/admin/analytics?days=7',x.token,x.id)).status,403);
  await x.pool.query('INSERT INTO admin_editors(user_id) VALUES($1)',[x.id]);
  assert.equal((await get('/api/admin/analytics?days=7',x.token,x.id)).status,403);
  await x.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1',[x.owner]);
  assert.equal((await get('/api/admin/analytics?days=7')).status,401);
});
