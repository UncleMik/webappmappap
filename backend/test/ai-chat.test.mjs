import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { createAiChat } from '../auth/ai-chat.mjs';
import { createStore } from '../auth/store.mjs';
import { hashToken, randomToken } from '../auth/security.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { validateAiAttachment, MAX_AI_FILE_BYTES } from '../auth/ai-attachment.mjs';
import { validateAiAudio, MAX_AI_AUDIO_BYTES } from '../auth/ai-voice.mjs';

let db, pool, folder, sourceMapPath, now, user, token, service, context, calls, chat, respond;
before(async () => {
  db = await testPool(); pool = db.pool;
  await pool.query(await readFile(new URL('../auth/ai-chat-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/ai-failure-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/ai-conversations-migration.sql', import.meta.url), 'utf8'));
  folder = await mkdtemp(join(tmpdir(), 'webpril-ai-test-'));
  sourceMapPath = join(folder, 'source-map.json');
  await writeFile(sourceMapPath, JSON.stringify({ version: 1, sources: [] }));
});
after(async () => { await db?.close(); await rm(folder, { recursive: true, force: true }); });
async function setup() {
  await pool.query('TRUNCATE ai_chat_requests,ai_chat_conversations,ai_chat_daily_usage,auth_sessions,auth_users,auth_rate_limits');
  now = Date.parse('2026-11-04T20:59:00Z'); user = randomUUID(); token = randomToken(); calls = 0;
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$3,$4)',
    [user, 'ai@example.invalid', 11, JSON.stringify({ stage: 'pregnancy', dueDate: '2027-03-01', completedAt: new Date(now).toISOString() })]);
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashToken(token), user, new Date(now + 86_400_000)]);
  const store = createStore(pool, { secret: 'test-secret-longer-than-thirty-two-bytes', clock: () => now });
  service = { session: t => store.session(t) };
  context = { courses: [{ productId: 1, title: 'Курс' }],
    lessons: [{ productId: 1, course: 'Курс', lessonId: 2, sectionId: 3,
      title: 'Урок', contentHash: 'abc', text: 'Материал урока' }] };
  respond = async () => ({ ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ',
    sourcePolicy: 'used_v1', sources: [{ id: '2', title: 'подмена', url: 'https://evil.invalid' }] }) });
  chat = createAiChat({ pool, service, courseMaterials: { aiContext: async () => context }, sourceMapPath,
    url: 'https://admin.legkie-rody.ru/internal/lara-web/reply', secret: 'test-lara-secret-longer-than-32-bytes',
    clock: () => now, fetchImpl: async (...args) => { calls++; return respond(...args); } });
}
let currentId;
const ask = (text = 'Вопрос', id = currentId) => chat.send(token, user, { requestId: id, text });
const pdf = (suffix = 'synthetic test fixture') => ({ name: 'Анализы.pdf', mimeType: 'application/pdf',
  data: Buffer.from(`%PDF-1.7\n${suffix}`).toString('base64') });
const audio = (suffix = 'synthetic-audio-fixture') => ({ mimeType: 'audio/ogg', data: Buffer.from(`OggS${suffix}`).toString('base64') });
const transcribe = (id = currentId, recorded = audio(), limiter = async () => {}) =>
  chat.transcribe(token, user, { requestId: id, audio: recorded }, limiter);

test('read-only quota refresh restores free and paid availability exactly at Moscow midnight without touching history', async () => {
  for(const limit of [5,30]){
    await setup();if(limit===5)context.courses=[];now=Date.parse('2026-11-04T20:59:59.000Z');
    await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,$3)',[user,'2026-11-04',limit]);
    const requestId=randomUUID(),a=await chat.authorize(token,user);
    const legacyId=randomUUID();
    await pool.query(`INSERT INTO ai_chat_conversations(id,user_id,title,legacy,created_at,updated_at) VALUES($1,$2,'Предыдущая переписка',true,$3,$3)`,[legacyId,user,new Date(now)]);
    await pool.query(`INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status,accepted_at,conversation_id)
      VALUES($1,$2,$3,$4,$5,'pending',$6,$7)`,[user,requestId,'History must remain unchanged','qa-hash',a.rightsHash,new Date(now-90_000),legacyId]);
    const before=(await pool.query('SELECT * FROM ai_chat_requests')).rows;
    const old=await chat.readQuota(token,user);
    assert.deepEqual(old,{accountId:user,quota:{limit,used:limit,remaining:0,resetsAt:'2026-11-04T21:00:00.000Z',serverTime:'2026-11-04T20:59:59.000Z'}});
    now+=1000;
    const fresh=await chat.readQuota(token,user);
    assert.deepEqual(fresh,{accountId:user,quota:{limit,used:0,remaining:limit,resetsAt:'2026-11-05T21:00:00.000Z',serverTime:'2026-11-04T21:00:00.000Z'}});
    assert.deepEqual((await pool.query('SELECT * FROM ai_chat_requests')).rows,before);
    assert.equal((await pool.query('SELECT * FROM ai_chat_daily_usage')).rows.length,1);assert.equal(calls,0);
  }
});

test('quota read spanning midnight returns a fresh current-day snapshot with a consistent timestamp and reset', async () => {
  await setup();context.courses=[];now=Date.parse('2026-11-04T20:59:59.000Z');
  await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,5)',[user,'2026-11-04']);
  let advance=true;
  const observingPool={connect:()=>pool.connect(),async query(sql,args){const result=await pool.query(sql,args);
    if(advance&&sql.startsWith('SELECT used FROM ai_chat_daily_usage')){advance=false;now+=1000;}return result;}};
  const observed=createAiChat({pool:observingPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
    url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now,
    fetchImpl:async()=>{throw new Error('must_not_call');}});
  const fresh=(await observed.readQuota(token,user)).quota;
  assert.equal(fresh.serverTime,'2026-11-04T21:00:00.000Z');assert.equal(fresh.resetsAt,'2026-11-05T21:00:00.000Z');assert.equal(fresh.remaining,5);
  assert.equal((await observed.readQuota(token,user)).quota.remaining,5);assert.equal(calls,0);
});

test('quota refresh rejects late session revocation and returns the current tier after a legitimate purchase expiry', async () => {
  for(const change of ['session','tier']){
    await setup();let armed=true;
    const observingPool={connect:()=>pool.connect(),async query(sql,args){const result=await pool.query(sql,args);
      if(armed&&sql.startsWith('SELECT used FROM ai_chat_daily_usage')){armed=false;
        if(change==='session')await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2',[new Date(now),hashToken(token)]);
        else context.courses=[];
      }return result;}};
    const observed=createAiChat({pool:observingPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
      url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now,
      fetchImpl:async()=>{throw new Error('must_not_call');}});
    if(change==='session')await assert.rejects(observed.readQuota(token,user),e=>e.code==='sign_in_required');
    else{const current=await observed.readQuota(token,user);assert.equal(current.accountId,user);assert.equal(current.quota.limit,5);assert.equal(current.quota.remaining,5);}
    assert.equal(calls,0);assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
  }
});

test('GET quota requires its current session, account and completed profile and returns no conversation', async () => {
  await setup();context.courses=[];
  const store=createStore(pool,{secret:'test-secret-longer-than-thirty-two-bytes',clock:()=>now});
  const server=createAuthServer({service,store,aiChat:chat,enabled:true,origin:'https://app.legkie-rody.ru'});
  server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}/api/auth/ai/quota`;
  const headers={Cookie:`__Host-school_session=${token}`,'X-Webpril-Account':user};
  try{
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{headers:{Cookie:headers.Cookie}})).status,409);
    assert.equal((await fetch(endpoint,{headers:{...headers,'X-Webpril-Account':randomUUID()}})).status,409);
    const valid=await fetch(endpoint,{headers}),body=await valid.json();assert.equal(valid.status,200);
    assert.equal(valid.headers.get('Cache-Control'),'no-store');assert.deepEqual(Object.keys(body).sort(),['accountId','quota']);
    assert.equal(body.quota.limit,5);assert.equal(body.quota.serverTime,new Date(now).toISOString());
    await pool.query('UPDATE auth_users SET profile=$1 WHERE id=$2',[JSON.stringify({stage:'pregnancy',dueDate:'2027-03-01'}),user]);
    const incomplete=await fetch(endpoint,{headers});assert.equal(incomplete.status,403);assert.equal((await incomplete.json()).error,'onboarding_required');
    assert.equal(calls,0);assert.equal((await pool.query('SELECT * FROM ai_chat_daily_usage')).rows.length,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('free accounts get five shared daily questions, safe retry and a Moscow midnight reset', async () => {
  await setup();context.courses=[];
  for(let i=0;i<5;i++){
    currentId=randomUUID();const sent=await ask(`Бесплатный вопрос ${i}`);
    assert.equal(sent.quota.limit,5);assert.equal(sent.quota.used,i+1);assert.equal(sent.quota.remaining,4-i);
    assert.equal((await ask(`Бесплатный вопрос ${i}`)).quota.used,i+1);
    assert.equal((await chat.status(token,user,{requestId:currentId})).quota.limit,5);
  }
  assert.equal(calls,5);currentId=randomUUID();await assert.rejects(ask(),e=>e.code==='ai_daily_limit');
  assert.equal((await chat.history(token,user)).quota.remaining,0);
  now+=60_000;const next=await ask();assert.equal(next.quota.used,1);assert.equal(next.quota.limit,5);assert.equal(calls,6);
});

test('free concurrent retries and distinct UUIDs cannot exceed five accepted questions', async () => {
  await setup();context.courses=[];
  for(let i=0;i<4;i++){currentId=randomUUID();await ask(`Вопрос ${i}`);}
  currentId=randomUUID();const acceptedId=currentId;let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});const hold=new Promise(resolve=>{release=resolve;});
  respond=async()=>{entered();await hold;return new Response(JSON.stringify({requestId:acceptedId,answer:'Ответ',sources:[]}));};
  const first=ask('Пятый вопрос');await ready;
  const retry=await ask('Пятый вопрос');assert.equal(retry.status,'pending');assert.equal(retry.quota.used,5);
  await assert.rejects(ask('Другой вопрос',randomUUID()),e=>['ai_busy','ai_daily_limit'].includes(e.code));
  release();assert.equal((await first).quota.used,5);
  await assert.rejects(ask('Шестой вопрос',randomUUID()),e=>e.code==='ai_daily_limit');
  assert.equal(calls,5);assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,5);
});

test('waiting for the account lock across Moscow midnight charges the new day using its accepted timestamp', async () => {
  await setup();context.courses=[];currentId=randomUUID();now=Date.parse('2026-11-04T20:59:59.999Z');
  await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,5)',[user,'2026-11-04']);
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});const hold=new Promise(resolve=>{release=resolve;});
  const delayedPool={query:(...args)=>pool.query(...args),async connect(){const client=await pool.connect();return{
    async query(sql,args){if(sql==='SELECT id FROM auth_users WHERE id=$1 FOR UPDATE'){entered();await hold;}return client.query(sql,args);},
    release:()=>client.release()};}};
  const delayed=createAiChat({pool:delayedPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
    url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now,
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify({requestId:currentId,answer:'Ответ',sources:[]}));}});
  const pending=delayed.send(token,user,{requestId:currentId,text:'Первый вопрос нового дня'});
  await ready;now+=1;release();
  const result=await pending;assert.equal(result.status,'completed');assert.equal(result.quota.limit,5);assert.equal(result.quota.used,1);
  assert.equal(result.quota.remaining,4);assert.equal(result.messages[0].createdAt,new Date(now).toISOString());
  const rows=(await pool.query('SELECT day_moscow::text,used FROM ai_chat_daily_usage ORDER BY day_moscow')).rows;
  assert.deepEqual(rows,[{day_moscow:'2026-11-04',used:5},{day_moscow:'2026-11-05',used:1}]);assert.equal(calls,1);
});

test('free retrieval has readable inline lessons only and never broad knowledge or paid references', async () => {
  await setup();currentId=randomUUID();context.courses=[];
  context.lessons[0].text='Дыхание в родах';
  context.lessons.push({...context.lessons[0],lessonId:4,title:'Второй бесплатный урок'});
  await writeFile(sourceMapPath,JSON.stringify({version:1,sources:[
    {course:'Курс',source:'free-match.md',lessonIds:[2]},{course:'Платный курс',source:'paid.md',lessonIds:[999]}]}));
  let payload;
  respond=async(_url,options)=>{payload=JSON.parse(options.body.toString());return new Response(JSON.stringify({requestId:currentId,answer:'Ответ',sourcePolicy:'used_v1',sources:[{id:'999'},{id:'Курс:free-match.md'},{id:'2'}]}));};
  const result=await ask('Дыхание в родах');
  assert.deepEqual(payload.allowedKnowledgeSources,[]);assert.deepEqual(payload.allowedLessons.map(l=>l.lessonId),[2,4]);
  assert.ok(payload.sources.every(s=>['2','4'].includes(s.id)));assert.ok(payload.sources.length>0);
  assert.deepEqual(result.messages[1].sources.map(s=>s.id),['2']);assert.equal(result.quota.limit,5);
});

test('upgrade and downgrade retain the shared counter, clamp free remaining and recheck cached rights', async () => {
  await setup();context.courses=[];let freeId;
  for(let i=0;i<5;i++){currentId=randomUUID();await ask(`Вопрос ${i}`);freeId=currentId;}
  context.courses=[{productId:1}];
  let q=(await chat.history(token,user)).quota;assert.equal(q.used,5);assert.equal(q.limit,30);assert.equal(q.remaining,25);
  await assert.rejects(chat.status(token,user,{requestId:freeId}),e=>e.code==='ai_access_changed');
  await assert.rejects(ask('Вопрос 4',freeId),e=>e.code==='ai_access_changed');
  currentId=randomUUID();const paidId=currentId;const paid=await ask('Платный вопрос');assert.equal(paid.quota.used,6);assert.equal(paid.quota.remaining,24);
  context.courses=[];
  q=(await chat.history(token,user)).quota;assert.equal(q.used,6);assert.equal(q.limit,5);assert.equal(q.remaining,0);
  assert.equal((await chat.status(token,user,{requestId:freeId})).quota.remaining,0);
  await assert.rejects(chat.status(token,user,{requestId:paidId}),e=>e.code==='ai_access_changed');
  await assert.rejects(chat.authorizeVoice(token,user),e=>e.code==='ai_daily_limit'&&e.quota.limit===5&&e.quota.used===6&&e.quota.remaining===0);
  await assert.rejects(ask('Новый вопрос',randomUUID()),e=>e.code==='ai_daily_limit'&&e.quota.limit===5&&e.quota.used===6&&e.quota.remaining===0);
  context.courses=[{productId:1}];assert.equal((await chat.status(token,user,{requestId:paidId})).quota.limit,30);
  assert.equal(calls,6);
});

test('free voice uses five-question availability but does not persist or consume a question', async () => {
  await setup();context.courses=[];currentId=randomUUID();
  respond=async()=>new Response(JSON.stringify({requestId:currentId,text:'Бесплатный вопрос'}));
  assert.equal((await transcribe()).text,'Бесплатный вопрос');assert.equal(calls,1);
  assert.equal((await chat.history(token,user)).quota.used,0);assert.equal((await chat.history(token,user)).quota.limit,5);
  await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,5)',[user,'2026-11-04']);
  await assert.rejects(transcribe(),e=>e.code==='ai_daily_limit');assert.equal(calls,1);
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
});

test('free failed file consumes one question while inaccessible ACL context errors still fail closed', async () => {
  await setup();context.courses=[];currentId=randomUUID();respond=async()=>new Response('{}',{status:502});
  const data={requestId:currentId,text:'Помоги с анализом',attachment:pdf()};
  const first=await chat.send(token,user,data),retry=await chat.send(token,user,data);
  assert.equal(first.status,'failed');assert.equal(first.quota.limit,5);assert.equal(retry.quota.used,1);assert.equal(calls,1);
  const closed=createAiChat({pool,service,courseMaterials:{aiContext:async()=>{throw new Error('upstream_context_unavailable');}},sourceMapPath,
    url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now,fetchImpl:async()=>{throw new Error('must_not_call');}});
  await assert.rejects(closed.history(token,user),/upstream_context_unavailable/);
  await assert.rejects(closed.send(token,user,{requestId:randomUUID(),text:'Вопрос'}),/upstream_context_unavailable/);
  assert.equal((await chat.history(token,user)).quota.used,1);
});

test('HTTP cap errors carry only current structured free-tier quota for send and early voice', async () => {
  await setup();context.courses=[];currentId=randomUUID();
  await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,8)',[user,'2026-11-04']);
  const store=createStore(pool,{secret:'test-secret-longer-than-thirty-two-bytes',clock:()=>now});
  const server=createAuthServer({service,store,aiChat:chat,enabled:true,origin:'https://app.legkie-rody.ru'});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Cookie:`__Host-school_session=${token}`,'X-Webpril-Account':user,Origin:'https://app.legkie-rody.ru','Content-Type':'application/json'};
  try{
    for(const [path,data] of [['messages',{requestId:currentId,text:'Вопрос'}],['voice',{requestId:currentId,audio:audio()}]]){
      const response=await fetch(`${base}/api/auth/ai/${path}`,{method:'POST',headers,body:JSON.stringify(data)}),body=await response.json();
      assert.equal(response.status,429);assert.equal(body.error,'ai_daily_limit');
      assert.deepEqual(body.quota,{limit:5,used:8,remaining:0,resetsAt:'2026-11-04T21:00:00.000Z',serverTime:new Date(now).toISOString()});
      assert.deepEqual(Object.keys(body.quota).sort(),['limit','remaining','resetsAt','serverTime','used']);
    }
    assert.equal(calls,0);assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('personal identity question has no retrieval or links in send/history/status/retry; old stored links stay intact', async () => {
  await setup();
  await writeFile(sourceMapPath,JSON.stringify({version:1,sources:[{course:'Курс',source:'lesson.md',lessonIds:[2]}]}));
  currentId=randomUUID();await ask('Меня зовут Михаил.');
  const profileBefore=(await pool.query('SELECT profile FROM auth_users WHERE id=$1',[user])).rows[0].profile;
  let payload;
  currentId=randomUUID();
  respond=async(_url,options)=>{payload=JSON.parse(options.body.toString());return new Response(JSON.stringify({requestId:currentId,
    answer:'Тебя зовут Михаил.',sourcePolicy:'used_v1',sources:[{id:'2'},{id:'Курс:lesson.md'}]}));};
  const sent=await ask('Как меня зовут?');
  assert.deepEqual(payload.allowedLessons,[]);assert.deepEqual(payload.allowedKnowledgeSources,[]);assert.deepEqual(payload.sources,[]);
  assert.equal(payload.question,'Как меня зовут?');assert.equal(payload.profile.stage,'pregnant');
  assert.equal(payload.history[0].content,'Меня зовут Михаил.');assert.equal(payload.history[1].content,'Ответ');
  assert.deepEqual(sent.messages[1].sources,[]);assert.equal(sent.messages[1].content,'Тебя зовут Михаил.');
  const initiallyStored=(await pool.query('SELECT sources FROM ai_chat_requests WHERE request_id=$1',[currentId])).rows[0].sources;
  assert.deepEqual(initiallyStored,[]);
  const old=Array.from({length:15},(_,i)=>({id:String(i+1),title:`Старый материал ${i+1}`,url:`/my-courses.html?course=${i+1}`,selection:'answer'}));
  await pool.query('UPDATE ai_chat_requests SET sources=$1::jsonb WHERE request_id=$2',[JSON.stringify(old),currentId]);
  const history=await chat.history(token,user),status=await chat.status(token,user,{requestId:currentId}),retry=await ask('Как меня зовут?');
  for(const response of [status,retry]){assert.deepEqual(response.messages[1].sources,[]);assert.equal(response.messages[1].content,'Тебя зовут Михаил.');}
  assert.deepEqual(history.messages.find(m=>m.requestId===currentId&&m.role==='assistant').sources,[]);
  const stored=(await pool.query('SELECT question,answer,sources FROM ai_chat_requests WHERE request_id=$1',[currentId])).rows[0];
  assert.deepEqual(stored.sources,old);assert.equal(stored.question,'Как меня зовут?');assert.equal(stored.answer,'Тебя зовут Михаил.');
  assert.deepEqual((await pool.query('SELECT profile FROM auth_users WHERE id=$1',[user])).rows[0].profile,profileBefore);
  assert.equal(calls,2);assert.equal(retry.quota.used,2);
});

test('whole-message personal and courtesy variants remove all material candidates and response references', async () => {
  await setup();
  const variants=['как меня зовут','помнишь как меня зовут?','Ты помнишь, как меня зовут?','кто я?','Сколько мне лет?',
    'Что обо мне помнишь?','Что ты обо мне знаешь?','Что знаешь обо мне?','Лара, привет! Как меня зовут?',
    'Здравствуйте, помнишь, как меня зовут, Лара?','Добрый день! Кто я?','Привет!','Спасибо за помощь!','Лара, как дела?',
    'Как меня зовут?🙂','Ты знаешь как меня зовут？','Ты помнишь моё имя?','Напомни моё имя','Какое у меня имя?',
    'Ты меня помнишь?','Ты помнишь меня?','Лара — привет! Как меня зовут?'];
  for(const text of variants){
    currentId=randomUUID();let payload;
    respond=async(_url,options)=>{payload=JSON.parse(options.body.toString());return new Response(JSON.stringify({requestId:currentId,
      answer:'Ответ',sourcePolicy:'used_v1',sources:[{id:'2'}]}));};
    const result=await ask(text);
    assert.deepEqual(payload.allowedLessons,[],text);assert.deepEqual(payload.allowedKnowledgeSources,[],text);assert.deepEqual(payload.sources,[],text);
    assert.deepEqual(result.messages[1].sources,[],text);
  }
  assert.equal(calls,variants.length);
});

test('greeting plus medical or mixed personal/medical question and attachments retain normal readable materials', async () => {
  await setup();
  await writeFile(sourceMapPath,JSON.stringify({version:1,sources:[{course:'Курс',source:'lesson.md',lessonIds:[2]}]}));
  context.lessons[0].text='Дыхание в родах и что делать при давлении во время беременности';
  for(const [text,attachment] of [['Привет, что делать при давлении?',undefined],['Как меня зовут? Подскажи дыхание в родах.',undefined],
    ['Лара, привет! Сколько мне лет и что делать при давлении?',undefined],['Как меня зовут?🙂 Что делать при давлении?',undefined],
    ['Ты помнишь моё имя? Дыхание в родах',undefined],['Как меня зовут?',pdf()],['Привет!',pdf()]]){
    currentId=randomUUID();let payload;
    respond=async(_url,options)=>{payload=JSON.parse(options.body.toString());return new Response(JSON.stringify({requestId:currentId,
      answer:'Ответ',sourcePolicy:'used_v1',sources:[{id:'2'}]}));};
    const result=await chat.send(token,user,{requestId:currentId,text,...(attachment?{attachment}:{})});
    assert.equal(payload.allowedLessons.length,1,text);assert.equal(payload.allowedKnowledgeSources.length,1,text);
    if(!attachment)assert.ok(payload.sources.length>0,text);else assert.deepEqual(payload.attachment,attachment);
    assert.deepEqual(result.messages[1].sources.map(s=>s.id),['2'],text);
    assert.deepEqual((await chat.status(token,user,{requestId:currentId})).messages[1].sources.map(s=>s.id),['2']);
  }
});

test('voice validator accepts allowed container magic and rejects noncanonical, oversized and mismatched audio', () => {
  for (const [mimeType, bytes] of [['audio/ogg', Buffer.from('OggSfixture')], ['audio/webm', Buffer.from([26,69,223,163,0])],
    ['audio/mp4', Buffer.from([0,0,0,12,102,116,121,112])], ['audio/wav', Buffer.from('RIFF1234WAVE')]])
    assert.equal(typeof validateAiAudio({mimeType,data:bytes.toString('base64')}), 'string');
  for (const recorded of [null, {...audio(),mimeType:'audio/ogg;codecs=opus'}, {...audio(),mimeType:'audio/wav'},
    {...audio(),data:audio().data+'\n'}, {...audio(),data:''}, {...audio(),extra:'forbidden'},
    {...audio(),data:Buffer.alloc(MAX_AI_AUDIO_BYTES+1).toString('base64')}])
    assert.throws(()=>validateAiAudio(recorded), e=>e.code==='invalid_ai_audio');
});

test('voice is authorized and quota gated; invalid inputs never call DO or reserve a question', async () => {
  await setup(); currentId=randomUUID();
  await assert.rejects(transcribe(currentId,{...audio(),data:'bad'}),e=>e.code==='invalid_ai_audio');
  context.courses=[]; assert.equal((await chat.authorizeVoice(token,user)).dailyLimit,5);
  context.courses=[{productId:1}];
  await assert.rejects(chat.transcribe(token,randomUUID(),{requestId:currentId,audio:audio()},async()=>{}),e=>e.code==='account_changed');
  await assert.rejects(chat.transcribe('',user,{requestId:currentId,audio:audio()},async()=>{}),e=>e.code==='sign_in_required');
  await pool.query('INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,30)',[user,'2026-11-04']);
  await assert.rejects(transcribe(),e=>e.code==='ai_daily_limit');
  assert.equal(calls,0); assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
});

test('voice retries bind audio bytes, share one call and cache text without saving transcript or spending question quota', async () => {
  await setup(); currentId=randomUUID(); let release,entered,rateHits=0;
  const held=new Promise(resolve=>{release=resolve;}); const ready=new Promise(resolve=>{entered=resolve;});
  respond=async (url,options)=>{assert.equal(String(url),'https://admin.legkie-rody.ru/internal/lara-web/transcribe');
    const payload=JSON.parse(options.body.toString()); assert.deepEqual(payload.audio,audio());
    assert.equal(options.headers['X-Lara-Signature'],createHmac('sha256','test-lara-secret-longer-than-32-bytes')
      .update(options.headers['X-Lara-Timestamp']).update('\n').update(options.body).digest('hex')); entered(); await held;
    return new Response(JSON.stringify({requestId:currentId,text:'  Распознанный вопрос  '}));};
  const limit=async()=>{rateHits++;}; const first=transcribe(currentId,audio(),limit); await ready;
  const second=transcribe(currentId,audio(),limit); release();
  const [one,two]=await Promise.all([first,second]); assert.deepEqual(one,two); assert.equal(one.text,'Распознанный вопрос');
  assert.equal((await transcribe(currentId,audio(),limit)).text,one.text); assert.equal(rateHits,1); assert.equal(calls,1);
  await assert.rejects(transcribe(currentId,audio('changed')),e=>e.code==='request_id_conflict');
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
  assert.equal((await pool.query('SELECT * FROM ai_chat_daily_usage')).rows.length,0);
  context.lessons=[]; await assert.rejects(transcribe(),e=>e.code==='ai_access_changed');
  context.courses=[]; await assert.rejects(transcribe(),e=>e.code==='ai_access_changed');
  assert.equal(calls,1);
});

test('recognized speech becomes a charged history question only after the normal text send', async () => {
  await setup();currentId=randomUUID();
  respond=async()=>new Response(JSON.stringify({requestId:currentId,text:'Распознанный вопрос'}));
  const recognized=await transcribe();
  assert.equal((await chat.history(token,user)).quota.used,0);
  currentId=randomUUID();
  respond=async()=>new Response(JSON.stringify({requestId:currentId,answer:'Ответ',sources:[]}));
  const result=await ask(recognized.text);
  assert.equal(result.status,'completed');assert.equal(result.quota.used,1);
  assert.equal(result.messages[0].content,recognized.text);assert.equal(calls,2);
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,1);
});

test('voice failures are bounded and private, release shared file slot and cached retries do not call again', async () => {
  await setup();
  for (const [status,body,code] of [[422,{error:'audio_too_long',details:'PRIVATE_AUDIO_PROVIDER'},'ai_audio_too_long'],
    [422,{error:'audio_unrecognized'},'ai_audio_unrecognized'],[502,{error:'upstream_failed'},'ai_voice_unavailable'],
    [200,{text:'A'.repeat(33000)},'ai_voice_unavailable']]) {
    currentId=randomUUID(); respond=async()=>new Response(JSON.stringify(body),{status});
    await assert.rejects(transcribe(),e=>e.code===code&&!e.message.includes('PRIVATE_AUDIO_PROVIDER'));
    const prior=calls; await assert.rejects(transcribe(),e=>e.code===code); assert.equal(calls,prior);
  }
  currentId=randomUUID(); respond=async()=>new Response(JSON.stringify({requestId:currentId,text:'Вопрос'}));
  assert.equal((await transcribe()).text,'Вопрос');
  assert.equal((await chat.history(token,user)).quota.used,0);
});

test('DO busy does not accept audio UUID: same-ID retry can succeed without spending question quota', async () => {
  await setup();currentId=randomUUID();
  respond=async()=>new Response(JSON.stringify({error:'busy'}),{status:503});
  await assert.rejects(transcribe(),e=>e.code==='ai_voice_busy');assert.equal(calls,1);
  respond=async()=>new Response(JSON.stringify({requestId:currentId,text:'Распознанный вопрос'}));
  assert.equal((await transcribe()).text,'Распознанный вопрос');assert.equal(calls,2);
  assert.equal((await transcribe()).text,'Распознанный вопрос');assert.equal(calls,2);
  assert.equal((await chat.history(token,user)).quota.used,0);
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
  assert.equal((await pool.query('SELECT * FROM ai_chat_daily_usage')).rows.length,0);
});

test('voice late session revocation is denied and voice jobs share the attachment processing slot', async () => {
  await setup(); currentId=randomUUID(); let release,entered;
  const held=new Promise(resolve=>{release=resolve;}); const ready=new Promise(resolve=>{entered=resolve;});
  respond=async()=>{entered();await held;return new Response(JSON.stringify({requestId:currentId,text:'Вопрос'}));};
  const first=transcribe();await ready;
  await assert.rejects(chat.send(token,user,{requestId:randomUUID(),text:'Файл',attachment:pdf()}),e=>e.code==='ai_upload_busy');
  await assert.rejects(transcribe(randomUUID()),e=>e.code==='ai_voice_busy');
  await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2',[new Date(now),hashToken(token)]);
  release(); await assert.rejects(first,e=>e.code==='sign_in_required');
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0); assert.equal(calls,1);
});

test('voice HTTP requires authorization before body, limits STT six per minute and never charges cached retry', async () => {
  await setup(); currentId=randomUUID();
  const store=createStore(pool,{secret:'test-secret-longer-than-thirty-two-bytes',clock:()=>now});
  const server=createAuthServer({service,store,aiChat:chat,enabled:true,origin:'https://app.legkie-rody.ru'});
  server.listen(0,'127.0.0.1');await once(server,'listening'); const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Cookie:`__Host-school_session=${token}`,'X-Webpril-Account':user,Origin:'https://app.legkie-rody.ru','Content-Type':'application/json'};
  const post=(data,h=headers)=>fetch(`${base}/api/auth/ai/voice`,{method:'POST',headers:h,body:JSON.stringify(data)});
  respond=async (_url,options)=>new Response(JSON.stringify({requestId:JSON.parse(options.body.toString()).requestId,text:'Вопрос'}));
  try {
    const early=await new Promise((resolve,reject)=>{const req=httpRequest(`${base}/api/auth/ai/voice`,{method:'POST',headers:{...headers,Cookie:'','Content-Length':'7000000'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.flushHeaders();});
    assert.equal(early,401);
    assert.equal((await post({requestId:currentId,audio:audio()},{...headers,Origin:'https://evil.invalid'})).status,403);
    const data={requestId:currentId,audio:audio()}; assert.equal((await post(data)).status,200);
    assert.equal((await post(data)).status,200); assert.equal(calls,1);
    for(let i=0;i<5;i++)assert.equal((await post({...data,requestId:randomUUID()})).status,200);
    const limited=await post({...data,requestId:randomUUID()});assert.equal(limited.status,429);assert.equal(calls,6);
    assert.equal((await pool.query('SELECT * FROM ai_chat_requests')).rows.length,0);
    assert.equal((await pool.query('SELECT * FROM ai_chat_daily_usage')).rows.length,0);
    const rows=(await pool.query('SELECT * FROM auth_rate_limits')).rows;
    assert.ok(!JSON.stringify(rows).includes(audio().data)); assert.ok(!JSON.stringify(rows).includes('Вопрос'));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('file validation bounds bytes, canonical base64, filename and matching magic', () => {
  assert.ok(validateAiAttachment(pdf()));
  for (const attachment of [null, [], { ...pdf(), name: '../file.pdf' }, { ...pdf(), name: 'C:\\file.pdf' },
    { ...pdf(), name: 'a\u202efile.pdf' }, { ...pdf(), name: 'a'.repeat(151) },
    { ...pdf(), data: 'JVBERi0=\n' }, { ...pdf(), data: 'JVBERi1=' },
    { ...pdf(), mimeType: 'image/png' }, { ...pdf(), mimeType: 'text/plain' },
    { ...pdf(), data: Buffer.alloc(MAX_AI_FILE_BYTES + 1).toString('base64') }]) {
    assert.throws(() => validateAiAttachment(attachment), e => e.code === 'invalid_ai_attachment');
  }
  const bytes = Buffer.alloc(MAX_AI_FILE_BYTES); bytes.write('%PDF-1.7');
  assert.ok(validateAiAttachment({ ...pdf(), data: bytes.toString('base64') }));
  assert.ok(validateAiAttachment({ name: 'a.png', mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') }));
  assert.ok(validateAiAttachment({ name: 'a.jpg', mimeType: 'image/jpeg', data: Buffer.from([255,216,255,1]).toString('base64') }));
});

test('file goes only to signed Germany payload; history stores filename and retries bind exact bytes', async () => {
  await setup(); currentId = randomUUID();
  let sent;
  const original = respond;
  respond = async (...args) => { sent = JSON.parse(args[1].body.toString()); return original(...args); };
  const data = { requestId: currentId, text: 'Результаты', attachment: pdf() };
  const first = await chat.send(token, user, data);
  assert.deepEqual(sent.attachment, data.attachment);
  assert.equal(sent.question, 'Результаты');
  assert.equal(first.messages[0].content, 'Результаты\n\nФайл анализа: Анализы.pdf');
  const { rows: [row] } = await pool.query('SELECT * FROM ai_chat_requests WHERE request_id=$1', [currentId]);
  assert.ok(!JSON.stringify(row).includes(data.attachment.data));
  assert.deepEqual((await chat.send(token, user, data)).messages, first.messages);
  await assert.rejects(chat.send(token, user, { ...data, attachment: pdf('changed') }), e => e.code === 'request_id_conflict');
  await assert.rejects(chat.send(token, user, { ...data, attachment: { ...pdf(), name: 'other.pdf' } }), e => e.code === 'request_id_conflict');
  assert.equal(calls, 1); assert.equal(first.quota.used, 1);
});

test('invalid file cannot reserve quota and file semaphore is released after rejection', async () => {
  await setup(); currentId = randomUUID();
  await assert.rejects(chat.send(token, user, { requestId: currentId, text: 'Вопрос', attachment: { ...pdf(), data: 'bad' } }),
    e => e.code === 'invalid_ai_attachment');
  assert.equal((await chat.history(token, user)).quota.used, 0); assert.equal(calls, 0);
  assert.equal((await chat.send(token, user, { requestId: currentId, text: 'Вопрос', attachment: pdf() })).status, 'completed');
});

test('accepted DO file failures return only fixed public messages, charge once and never retry generation', async () => {
  await setup();
  const expected = [
    [422, 'invalid_attachment', 'Не удалось прочитать файл. Поддерживаются PDF до 10 страниц и фотографии JPG/PNG до 16 Мп, размером до 10 МБ.'],
    [422, 'attachment_unreadable', 'Не удалось уверенно прочитать показатели. Прикрепите более чёткий файл или фото.'],
    [503, 'busy', 'Лара сейчас обрабатывает другой файл. Попробуйте позже.'],
    [502, 'provider_unavailable', 'Сервис ответов Лары временно недоступен. Попробуйте немного позже.'],
    [504, 'timeout', 'Обработка заняла слишком много времени. Попробуйте ещё раз немного позже.'],
    [422, 'private_provider_error', 'Ларе не удалось подготовить ответ. Попробуйте немного позже.'],
    [502, 'invalid_attachment', 'Ларе не удалось подготовить ответ. Попробуйте немного позже.'],
  ];
  for (const [status, error, publicMessage] of expected) {
    currentId = randomUUID();
    respond = async () => new Response(JSON.stringify({ error, details: 'PRIVATE_PROVIDER_DETAILS' }), { status });
    const data = { requestId: currentId, text: 'Вопрос', attachment: pdf() };
    const result = await chat.send(token, user, data);
    assert.equal(result.status, 'failed'); assert.equal(result.failureMessage, publicMessage);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_DETAILS'));
    const stored = (await pool.query('SELECT * FROM ai_chat_requests WHERE request_id=$1', [currentId])).rows[0];
    assert.equal(stored.answer, null); assert.ok(!JSON.stringify(stored).includes('PRIVATE_PROVIDER_DETAILS'));
    assert.equal(stored.failure_code, result.failureCode);
    assert.equal(result.messages[0].failureMessage, publicMessage);
    const used = result.quota.used, callsBeforeRetry = calls;
    const statusResult = await chat.status(token, user, data), retry = await chat.send(token, user, data);
    assert.equal(statusResult.quota.used, used);
    assert.equal(statusResult.failureMessage, publicMessage);
    assert.equal(statusResult.messages[0].failureCode, result.failureCode);
    assert.equal(retry.status, 'failed'); assert.equal(retry.failureMessage, publicMessage);
    const history = await chat.history(token, user);
    assert.equal(history.messages.find(m => m.requestId === currentId).failureMessage, publicMessage);
    assert.equal(calls, callsBeforeRetry);
  }
  assert.equal(calls, expected.length); assert.equal((await chat.history(token, user)).quota.used, expected.length);
  currentId = randomUUID();
  respond = async () => new Response(JSON.stringify({ error: 'invalid_attachment', details: 'A'.repeat(128 * 1024) }), { status: 422 });
  const oversized = await chat.send(token, user, { requestId: currentId, text: 'Вопрос', attachment: pdf() });
  assert.equal(oversized.status, 'failed'); assert.equal(oversized.failureCode, 'invalid_response');
  assert.equal(oversized.failureMessage, 'Не удалось получить корректный ответ Лары. Попробуйте немного позже.');
});

test('network, timeout, invalid reply and expired pending reasons remain safe through history and UUID retry', async () => {
  for (const code of ['bridge_unavailable', 'timeout', 'invalid_response', 'request_expired']) {
    await setup(); currentId = randomUUID();
    respond = async () => {
      if (code === 'invalid_response') return new Response('{private-invalid-json', { status: 200 });
      if (code === 'timeout') throw new DOMException('PRIVATE_PROVIDER_DETAILS', 'TimeoutError');
      throw new Error('PRIVATE_PROVIDER_DETAILS');
    };
    let result;
    if (code === 'request_expired') {
      let release;
      const held = new Promise(resolve => { release = resolve; });
      respond = async () => { await held; throw new Error('private'); };
      const sending = ask();
      for (let i = 0; i < 100 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
      now += 71_000;
      result = (await chat.history(token, user)).messages[0];
      release(); assert.equal((await sending).failureCode, 'request_expired');
    } else result = (await ask()).messages[0];
    assert.equal(result.failureCode, code);
    for (const read of [await chat.status(token, user, { requestId: currentId }), await ask(), await chat.history(token, user)]) {
      assert.equal(read.messages[0].failureCode, code);
      assert.equal(read.messages[0].failureMessage, result.failureMessage);
      assert.ok(!JSON.stringify(read).includes('PRIVATE_PROVIDER_DETAILS'));
      assert.equal(read.quota.used, code === 'request_expired' ? 0 : 1);
    }
    assert.equal((await pool.query('SELECT sum(used)::integer AS used FROM ai_chat_daily_usage')).rows[0].used, 1);
    assert.equal(calls, 1);
  }
});

test('failed reasons are constrained to fixed codes and legacy failures receive a safe fallback', async () => {
  await setup(); currentId = randomUUID(); respond = async () => { throw new Error('private'); };
  await ask();
  await assert.rejects(pool.query('UPDATE ai_chat_requests SET failure_code=$1', ['PRIVATE_PROVIDER_DETAILS']));
  await pool.query('UPDATE ai_chat_requests SET failure_code=NULL');
  const old = await chat.status(token, user, { requestId: currentId });
  assert.equal(old.failureCode, 'unknown_failure');
  assert.equal(old.messages[0].failureMessage, 'Ларе не удалось подготовить ответ. Попробуйте немного позже.');
});

test('status polls pending/completed/stale without model, quota or original; checks account and rights', async () => {
  await setup(); currentId = randomUUID();
  await assert.rejects(chat.status(token, user, { requestId: currentId }), e => e.code === 'ai_request_not_found');
  assert.equal(calls, 0); assert.equal((await chat.history(token, user)).quota.used, 0);
  await chat.send(token, user, { requestId: currentId, text: 'Вопрос', attachment: pdf() });
  assert.equal((await chat.status(token, user, { requestId: currentId })).status, 'completed');
  await pool.query("UPDATE ai_chat_requests SET status='pending',answer=NULL WHERE request_id=$1", [currentId]);
  assert.equal((await chat.status(token, user, { requestId: currentId })).status, 'pending');
  now += 70_000;
  assert.equal((await chat.status(token, user, { requestId: currentId })).status, 'failed');
  await assert.rejects(chat.status(token, randomUUID(), { requestId: currentId }), e => e.code === 'account_changed');
  context.lessons = [];
  await assert.rejects(chat.status(token, user, { requestId: currentId }), e => e.code === 'ai_access_changed');
  context.courses = [];
  await assert.rejects(chat.status(token, user, { requestId: currentId }), e => e.code === 'ai_access_changed');
  assert.equal(calls, 1);
});

test('single file processor rejects parallel file before quota and releases after provider failure', async () => {
  await setup(); currentId = randomUUID();
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  respond = async () => { entered(); await hold; throw new Error('fixture failure'); };
  const data = { requestId: currentId, text: 'Вопрос', attachment: pdf() };
  const first = chat.send(token, user, data); await ready;
  await assert.rejects(chat.send(token, user, { ...data, requestId: randomUUID() }), e => e.code === 'ai_upload_busy');
  assert.equal((await chat.status(token, user, data)).quota.used, 1);
  release(); assert.equal((await first).status, 'failed');
  assert.equal((await chat.send(token, user, data)).status, 'failed');
  assert.equal(calls, 1);
});

test('HTTP large upload authorizes before receiving bytes, bounds one slot and offers body-free status', async () => {
  await setup(); currentId = randomUUID();
  const store = createStore(pool, { secret: 'test-secret-longer-than-thirty-two-bytes', clock: () => now });
  const server = createAuthServer({ service, store, aiChat: chat, enabled: true, origin: 'https://app.legkie-rody.ru' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `__Host-school_session=${token}`, 'X-Webpril-Account': user,
    Origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json' };
  const post = (path, data, h = headers) => fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(data) });
  try {
    const early = await new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/auth/ai/messages`, { method: 'POST', headers: {
        ...headers, Cookie: '', 'Content-Length': '20000' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.flushHeaders();
    });
    assert.equal(early, 401); assert.equal(calls, 0);
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    respond = async () => { entered(); await hold; return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sources: [] }) }; };
    const data = { requestId: currentId, text: 'Вопрос', attachment: pdf('fixture'.repeat(3000)) };
    const first = post('/api/auth/ai/messages', data); await ready;
    const busy = await post('/api/auth/ai/messages', { ...data, requestId: randomUUID() });
    assert.equal(busy.status, 503); assert.equal((await busy.json()).error, 'ai_upload_busy');
    const status = await post('/api/auth/ai/messages/status', { requestId: currentId });
    assert.equal(status.status, 200); assert.equal((await status.json()).status, 'pending');
    release(); assert.equal((await first).status, 200);
    const normalOversized = await post('/api/auth/ai/messages', { requestId: randomUUID(), text: ' '.repeat(17000) });
    assert.equal(normalOversized.status, 413);
    assert.equal(calls, 1); assert.equal((await chat.history(token, user)).quota.used, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('free history opens with five questions while account and session gates remain closed', async () => {
  await setup(); currentId = randomUUID(); context = { courses: [], lessons: [] };
  assert.equal((await chat.history(token,user)).quota.limit,5);
  await assert.rejects(chat.send(token,randomUUID(),{requestId:currentId,text:'Вопрос'}),e=>e.code==='account_changed');
  context = { courses: [{ productId: 1 }], lessons: [] };
  await assert.rejects(chat.history(token, randomUUID()), e => e.code === 'account_changed');
  await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2', [new Date(now), hashToken(token)]);
  await assert.rejects(ask(), e => e.code === 'sign_in_required');
  assert.equal(calls, 0);
});

test('one UUID gets one model call, a saved reply and safe source metadata', async () => {
  await setup(); currentId = randomUUID();
  const first = await ask();
  const second = await ask();
  assert.equal(calls, 1); assert.equal(first.status, 'completed'); assert.deepEqual(first.messages, second.messages);
  assert.equal(first.messages[0].status, 'completed');
  assert.equal(first.quota.used, 1); assert.equal(first.messages[1].sources[0].title, 'Урок');
  assert.equal(first.messages[1].sources[0].url, '/article.html?courseLesson=2&course=1&section=3');
  await assert.rejects(ask('Другой вопрос'), e => e.code === 'request_id_conflict');
  assert.equal((await chat.history(token, user)).messages.length, 2);
});

test('old mechanical sources stay stored but disappear from history and duplicate replies', async () => {
  await setup(); currentId = randomUUID(); await ask();
  const old = [{ id: '2', title: 'Старый список', url: '/article.html?courseLesson=2&course=1&section=3' }];
  await pool.query('UPDATE ai_chat_requests SET sources=$1::jsonb WHERE request_id=$2', [JSON.stringify(old), currentId]);
  const history = await chat.history(token, user);
  const duplicate = await ask();
  assert.deepEqual(history.messages[1].sources, []);
  assert.deepEqual(duplicate.messages[1].sources, []);
  assert.equal((await pool.query('SELECT sources FROM ai_chat_requests WHERE request_id=$1', [currentId])).rows[0].sources.length, 1);
  assert.equal(calls, 1); assert.equal(duplicate.quota.used, 1);
});

test('only used_v1 can save up to three allowlisted unique sources; metadata is not exposed', async () => {
  await setup(); currentId = randomUUID();
  for (let lessonId = 4; lessonId <= 7; lessonId++) context.lessons.push({ productId: 1, course: 'Курс',
    lessonId, sectionId: 3, title: `Урок ${lessonId}`, contentHash: String(lessonId), text: 'Материал' });
  respond = async () => ({ ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ',
    sourcePolicy: 'used_v1', sources: [
      { id: '2', title: 'Подмена', url: 'https://evil.invalid' }, { id: '2' }, { id: '999' },
      { id: '4' }, { id: '5' }, { id: '6' }, { id: '7' }] }) });
  const sent = await ask();
  assert.deepEqual(sent.messages[1].sources.map(s => s.id), ['2', '4', '5']);
  assert.ok(sent.messages[1].sources.every(s => !Object.hasOwn(s, 'selection') && s.url.startsWith('/article.html?')));
  const { rows: [stored] } = await pool.query('SELECT sources FROM ai_chat_requests WHERE request_id=$1', [currentId]);
  assert.equal(stored.sources.length, 3);
  assert.ok(stored.sources.every(s => s.selection === 'answer'));
  assert.deepEqual((await chat.history(token, user)).messages[1].sources, sent.messages[1].sources);
});

test('missing or wrong sourcePolicy leaves answer and quota but hides proposed references', async () => {
  await setup();
  for (const policy of [undefined, 'candidate_v1']) {
    currentId = randomUUID();
    respond = async () => ({ ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ',
      ...(policy ? { sourcePolicy: policy } : {}), sources: [{ id: '2' }] }) });
    const sent = await ask(`Вопрос ${policy || 'missing'}`);
    assert.equal(sent.status, 'completed'); assert.deepEqual(sent.messages[1].sources, []);
    assert.deepEqual((await ask(`Вопрос ${policy || 'missing'}`)).messages[1].sources, []);
  }
  assert.equal(calls, 2); assert.equal((await chat.history(token, user)).quota.used, 2);
});

test('timeout becomes failed; retry never invokes the model or spends quota again', async () => {
  await setup(); currentId = randomUUID(); respond = async () => { throw new Error('unknown'); };
  const first = await ask(); assert.equal(first.status, 'failed');
  const retry = await ask();
  assert.equal(retry.status, 'failed'); assert.equal(retry.messages[0].status, 'failed');
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
  assert.equal(calls, 1); assert.equal(retry.quota.used, 1);
  currentId = randomUUID(); assert.equal((await ask('Новый вопрос')).status, 'failed'); assert.equal(calls, 2);
});

test('quota is 30 accepted questions per Moscow day and resets at midnight', async () => {
  await setup();
  for (let i = 0; i < 30; i++) { currentId = randomUUID(); await ask(`Вопрос ${i}`); }
  currentId = randomUUID();
  await assert.rejects(ask(), e => e.code === 'ai_daily_limit');
  assert.equal(calls, 30);
  now += 60_000;
  const next = await ask(); assert.equal(next.quota.used, 1); assert.equal(calls, 31);
});

test('revoked session during model call closes the late answer', async () => {
  await setup(); currentId = randomUUID();
  respond = async () => { await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2',
    [new Date(now), hashToken(token)]); return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sources: [] }) }; };
  await assert.rejects(ask(), e => e.code === 'sign_in_required');
  assert.equal((await pool.query('SELECT status FROM ai_chat_requests')).rows[0].status, 'pending');
});

test('changed lesson rights during model call cannot save or return a late answer', async () => {
  await setup(); currentId = randomUUID();
  respond = async () => { context = { ...context, lessons: [] };
    return { ok: true, json: async () => ({ requestId: currentId, answer: 'Старый ответ', sources: [] }) }; };
  await assert.rejects(ask(), e => e.code === 'ai_access_changed');
  assert.equal((await pool.query('SELECT status FROM ai_chat_requests')).rows[0].status, 'pending');
  await assert.rejects(ask(), e => e.code === 'ai_access_changed'); assert.equal(calls, 1);
});

test('concurrent retries with one request ID reserve one quota unit and call once', async () => {
  await setup(); currentId = randomUUID();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  respond = async () => { await hold; return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sources: [] }) }; };
  const first = ask();
  // The second request can race with the first reservation but must not reach the model.
  const second = ask();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(results[0].quota.used, 1);
  assert.ok(['pending', 'completed'].includes(results[1].status));
});

test('HTTP routes require the account header and same-origin JSON send', async () => {
  await setup(); currentId = randomUUID();
  const store = createStore(pool, { secret: 'test-secret-longer-than-thirty-two-bytes', clock: () => now });
  const server = createAuthServer({ service, store, aiChat: chat, enabled: true,
    origin: 'https://app.legkie-rody.ru' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { Cookie: `__Host-school_session=${token}`, 'X-Webpril-Account': user };
    const missing = await fetch(`${base}/api/auth/ai/history`, { headers: { Cookie: headers.Cookie } });
    assert.equal(missing.status, 409);
    const read = await fetch(`${base}/api/auth/ai/history`, { headers });
    assert.equal(read.status, 200); assert.equal((await read.json()).accountId, user);
    const rejected = await fetch(`${base}/api/auth/ai/messages`, { method: 'POST', headers: {
      ...headers, Origin: 'https://other.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: currentId, text: 'Вопрос' }) });
    assert.equal(rejected.status, 403); assert.equal(calls, 0);
    const sent = await fetch(`${base}/api/auth/ai/messages`, { method: 'POST', headers: {
      ...headers, Origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: currentId, text: 'Вопрос' }) });
    assert.equal(sent.status, 200); assert.equal((await sent.json()).status, 'completed');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('server passes only readable mapped sources, GC URL keys and relevant short excerpts', async () => {
  await setup(); currentId = randomUUID();
  context.lessons.push({ productId: 1, course: 'Курс', lessonId: 4, sectionId: 3,
    title: 'Дыхание', contentHash: 'def', text: 'Дыхание во время родов ' + 'дышите '.repeat(2000) });
  await writeFile(sourceMapPath, JSON.stringify({ version: 1, sources: [
    { course: 'Курс', source: 'breath.md', lessonIds: [4] },
    { course: 'Курс', source: 'breath.md', lessonIds: [4, 999] },
    { course: 'Курс', source: 'closed.md', lessonIds: [999] }],
    lessonUrls: [{ lessonId: 4, urls: ['https://school.getcourse.ru/pl/teach/control/lesson/view?id=4'] },
      { lessonId: 999, urls: ['https://school.getcourse.ru/closed'] }] }));
  let body;
  respond = async (_url, options) => {
    body = JSON.parse(options.body.toString());
    return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ',
      sourcePolicy: 'used_v1', sources: [{ id: 'Курс:breath.md' }, { id: '999' }] }) };
  };
  const answer = await ask('Дыхание во время родов?\nПодскажите');
  assert.equal(body.allowedKnowledgeSources.length, 1);
  assert.equal(body.allowedKnowledgeSources[0].url, '/my-courses.html?course=1');
  assert.equal(body.allowedLessons.find(l => l.lessonId === 4).gcUrls.length, 1);
  assert.equal(body.allowedLessons.find(l => l.lessonId === 2).gcUrls.length, 0);
  assert.deepEqual(body.sources.map(s => s.id), ['4']);
  assert.ok(body.sources[0].text.length <= 4000);
  assert.deepEqual(answer.messages[1].sources.map(s => s.id), ['Курс:breath.md']);
});

test('module sources open their readable common parent and normalize stored links without invalidating old UUIDs', async () => {
  await setup(); currentId = randomUUID();
  const course = 'Модуль 3. Организация ГВ', source = 'feeding.md', sourceId = `${course}:${source}`;
  context.lessons[0].sectionPath = [9, 3];
  context.lessons.push({ productId: 1, course: 'Курс', lessonId: 4, sectionId: 7,
    sectionPath: [9, 3, 7], title: 'Дополнительный урок', contentHash: 'child', text: 'Материал' });
  const mapping = { version: 1, sources: [{ course, source, title: `Материалы: ${course}`, lessonIds: [2, 4] }] };
  await writeFile(sourceMapPath, JSON.stringify(mapping));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const oldRightsHash = digest(JSON.stringify({ profile: ['pregnancy', '2027-03-01', null],
    courses: [1], lessons: [[2, 3, 1, 'abc'], [4, 7, 1, 'child']],
    sources: [{ course, source, title: `Материалы: ${course}`, url: '/my-courses.html?course=1' }],
    mapHash: digest(JSON.stringify(mapping)) }));
  let body;
  respond = async (_url, options) => {
    body = JSON.parse(options.body.toString());
    return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ о кормлении',
      sourcePolicy: 'used_v1', sources: [{ id: sourceId }] }) };
  };
  const sent = await ask('Подскажите про кормление');
  assert.equal(body.allowedKnowledgeSources[0].url, '/my-courses.html?course=1&section=3');
  assert.equal(sent.messages[1].sources[0].url, '/my-courses.html?course=1&section=3');
  const stored = (await pool.query('SELECT * FROM ai_chat_requests WHERE request_id=$1', [currentId])).rows[0];
  assert.equal(stored.rights_hash, oldRightsHash);
  stored.sources[0].url = '/my-courses.html?course=1';
  await pool.query('UPDATE ai_chat_requests SET sources=$1::jsonb WHERE request_id=$2', [JSON.stringify(stored.sources), currentId]);
  const preserved = (await pool.query('SELECT sources FROM ai_chat_requests WHERE request_id=$1', [currentId])).rows[0].sources;
  for (const read of [await chat.history(token, user), await chat.status(token, user, { requestId: currentId }), await ask('Подскажите про кормление')]) {
    assert.equal(read.messages[1].sources[0].url, '/my-courses.html?course=1&section=3');
    assert.equal(read.quota.used, 1);
  }
  assert.deepEqual((await pool.query('SELECT sources FROM ai_chat_requests WHERE request_id=$1', [currentId])).rows[0].sources, preserved);
  assert.equal(calls, 1);
});

test('module candidates without one readable existing parent never fall back to the whole course', async () => {
  for (const mode of ['unrelated', 'partial', 'mixed-products']) {
    await setup(); currentId = randomUUID();
    const course = 'Модуль. Проверенный материал', source = 'guide.md';
    context.lessons[0].sectionPath = [9, 3];
    context.lessons.push({ productId: mode === 'mixed-products' ? 5 : 1, course: 'Другой курс', lessonId: 4,
      sectionId: 7, sectionPath: [9, 7], title: 'Урок', contentHash: 'child', text: 'Материал' });
    if (mode === 'mixed-products') context.courses.push({ productId: 5, title: 'Другой курс' });
    await writeFile(sourceMapPath, JSON.stringify({ version: 1, sources: [{ course, source,
      lessonIds: mode === 'partial' ? [2, 999] : [2, 4] }] }));
    let body;
    respond = async (_url, options) => {
      body = JSON.parse(options.body.toString());
      return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sourcePolicy: 'used_v1',
        sources: [{ id: `${course}:${source}` }] }) };
    };
    const sent = await ask('Подскажите про кормление');
    assert.deepEqual(body.allowedKnowledgeSources, []);
    assert.deepEqual(sent.messages[1].sources, []);
  }
});

test('one active question blocks a different UUID briefly, then stale crash pending becomes failed', async () => {
  await setup(); currentId = randomUUID();
  await ask('Вопрос');
  await pool.query("UPDATE ai_chat_requests SET status='pending',answer=NULL WHERE request_id=$1", [currentId]);
  const second = randomUUID();
  await assert.rejects(ask('Новый', second), e => e.code === 'ai_busy');
  now += 71_000;
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
  assert.equal((await chat.history(token, user, '999999')).messages[0].status, 'failed');
  assert.equal((await ask('Вопрос')).status, 'failed');
  respond = async () => ({ ok: true, json: async () => ({ requestId: second, answer: 'Ответ', sources: [] }) });
  assert.equal((await ask('Новый', second)).status, 'completed'); assert.equal(calls, 2);
});

test('postpartum age uses completed calendar months in Moscow', async () => {
  await setup(); currentId = randomUUID(); now = Date.parse('2026-02-28T12:00:00Z');
  await pool.query('UPDATE auth_users SET profile=$1 WHERE id=$2',
    [JSON.stringify({ stage: 'mother', birthDate: '2026-01-31', completedAt: new Date(now).toISOString() }), user]);
  let profile;
  respond = async (_url, options) => { profile = JSON.parse(options.body.toString()).profile;
    return { ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sources: [] }) }; };
  await ask();
  assert.equal(profile.stage, 'postpartum'); assert.equal(profile.childAgeMonths, 0);
});

test('DO endpoint is pinned to the approved HTTPS origin', async () => {
  await setup();
  for (const url of ['https://other.invalid/internal/lara-web/reply',
    'https://admin.legkie-rody.ru:444/internal/lara-web/reply',
    'https://user:pass@admin.legkie-rody.ru/internal/lara-web/reply']) {
    assert.throws(() => createAiChat({ pool, service, courseMaterials: { aiContext: async () => context },
      sourceMapPath, url, secret: 'test-lara-secret-longer-than-32-bytes' }));
  }
});

test('model history stays within 20,000 characters while stored history remains intact', async () => {
  await setup();
  let modelHistory;
  respond = async (_url, options) => { modelHistory = JSON.parse(options.body.toString()).history;
    return { ok: true, json: async () => ({ requestId: currentId, answer: 'А'.repeat(3000), sources: [] }) }; };
  for (let i = 0; i < 8; i++) { currentId = randomUUID(); await ask(`Вопрос ${i}`); }
  assert.ok(modelHistory.reduce((sum, entry) => sum + entry.content.length, 0) <= 20_000);
  assert.equal(modelHistory.at(-2).content, 'Вопрос 6');
  assert.equal((await chat.history(token, user)).messages.length, 16);
});

test('oversized DO response stream becomes failed and never saves an answer', async () => {
  await setup(); currentId = randomUUID();
  respond = async () => new Response(JSON.stringify({ requestId: currentId, answer: 'А'.repeat(70_000), sources: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await ask()).status, 'failed');
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
});

test('DO 502 and 504 are terminal failures with no automatic retry', async () => {
  await setup();
  for (const status of [502, 504]) {
    currentId = randomUUID(); respond = async () => ({ ok: false, status });
    const result = await ask(`Ошибка ${status}`);
    assert.equal(result.status, 'failed'); assert.equal((await ask(`Ошибка ${status}`)).status, 'failed');
  }
  assert.equal(calls, 2); assert.equal((await chat.history(token, user)).quota.used, 2);
});

test('late DO success cannot overwrite a stale request already marked failed', async () => {
  await setup(); currentId = randomUUID();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  respond = async () => { await hold; return { ok: true, json: async () => ({ requestId: currentId, answer: 'Поздний ответ', sources: [] }) }; };
  const first = ask();
  while (!(await pool.query('SELECT id FROM ai_chat_requests')).rows.length) await new Promise(resolve => setTimeout(resolve, 5));
  now += 71_000;
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
  release();
  assert.equal((await first).failureCode, 'request_expired');
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
  assert.equal((await pool.query('SELECT answer FROM ai_chat_requests')).rows[0].answer, null);
});

test('conversation creation is idempotent, empty and does not spend shared quota', async () => {
  await setup(); const id=randomUUID();
  const created=await Promise.all([chat.createConversation(token,user,{conversationId:id}),chat.createConversation(token,user,{conversationId:id})]);
  assert.deepEqual(created[0],created[1]);assert.equal(created[0].conversation.title,'Новый чат');
  assert.equal((await chat.conversations(token,user)).conversations.length,1);
  assert.deepEqual((await chat.history(token,user,undefined,id)).messages,[]);
  assert.equal((await chat.history(token,user)).conversationId,null);
  assert.equal((await chat.readQuota(token,user)).quota.used,0);assert.equal(calls,0);
});

test('conversation history and model context are isolated while quota and request IDs stay per account', async () => {
  await setup();context.courses=[];const ids=[randomUUID(),randomUUID()];
  for(const id of ids)await chat.createConversation(token,user,{conversationId:id});
  const payloads=[];respond=async(_,options)=>{const body=JSON.parse(options.body);payloads.push(body);return new Response(JSON.stringify({requestId:body.requestId,answer:'Synthetic answer '+body.question,sources:[]}));};
  const requests=[];
  for(let i=0;i<5;i++){
    const conversationId=ids[i%2],requestId=randomUUID();requests.push(requestId);
    const result=await chat.send(token,user,{conversationId,requestId,text:'Thread '+i%2+' question '+i});
    assert.equal(result.conversationId,conversationId);assert.equal(result.conversation.id,conversationId);assert.equal(result.conversation.title,'Thread '+i%2+' question '+i%2);assert.equal(result.quota.used,i+1);
  }
  assert.deepEqual(payloads[0].history,[]);assert.deepEqual(payloads[1].history,[]);
  assert.equal(payloads[2].history.length,2);assert.match(payloads[2].history[0].content,/Thread 0/);
  assert.equal(payloads[3].history.length,2);assert.match(payloads[3].history[0].content,/Thread 1/);
  const read=await chat.history(token,user,undefined,ids[0]);assert.equal(read.messages.length,6);assert.equal(read.conversation.title,'Thread 0 question 0');
  assert.equal((await chat.history(token,user)).messages.length,0);
  await assert.rejects(chat.send(token,user,{conversationId:ids[1],requestId:requests[0],text:'Thread 0 question 0'}),e=>e.code==='request_id_conflict');
  const state=await chat.status(token,user,{requestId:requests[0]});assert.equal(state.conversationId,ids[0]);assert.equal(state.conversation.title,'Thread 0 question 0');
  await assert.rejects(chat.status(token,user,{conversationId:ids[1],requestId:requests[0]}),e=>e.status===404);
  await assert.rejects(chat.send(token,user,{conversationId:ids[1],requestId:randomUUID(),text:'Sixth'}),e=>e.code==='ai_daily_limit');
  assert.equal(calls,5);assert.equal((await chat.readQuota(token,user)).quota.used,5);
});

test('conversation ownership is enforced on create, read, send and database references', async () => {
  await setup();const mine=randomUUID(),other=randomUUID(),foreign=randomUUID();await chat.createConversation(token,user,{conversationId:mine});
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,22,$3)',[other,'foreign@example.invalid','{}']);
  await pool.query("INSERT INTO ai_chat_conversations(id,user_id,title,created_at,updated_at) VALUES($1,$2,'Foreign',$3,$3)",[foreign,other,new Date(now)]);
  await assert.rejects(chat.createConversation(token,user,{conversationId:foreign}),e=>e.status===404);
  await assert.rejects(chat.history(token,user,undefined,foreign),e=>e.status===404);
  await assert.rejects(chat.send(token,user,{conversationId:foreign,requestId:randomUUID(),text:'Synthetic'}),e=>e.status===404);
  assert.deepEqual((await chat.conversations(token,user)).conversations.map(c=>c.id),[mine]);
  await assert.rejects(pool.query(`INSERT INTO ai_chat_requests(user_id,conversation_id,request_id,question,question_hash,rights_hash,status,accepted_at)
    VALUES($1,$2,$3,'Synthetic','hash','rights','pending',$4)`,[user,foreign,randomUUID(),new Date(now)]));
  assert.equal(calls,0);assert.equal((await chat.readQuota(token,user)).quota.used,0);
});

test('conversation pagination has stable ties and viewing or retrying does not reorder chats', async () => {
  await setup();const ids=[];for(let i=0;i<32;i++){const id=randomUUID();ids.push(id);await chat.createConversation(token,user,{conversationId:id});}
  const page=await chat.conversations(token,user);assert.equal(page.conversations.length,30);assert.equal(page.hasMore,true);
  const second=await chat.conversations(token,user,page.nextBefore);assert.equal(second.conversations.length,2);assert.equal(second.hasMore,false);
  assert.equal(new Set([...page.conversations,...second.conversations].map(c=>c.id)).size,32);
  await assert.rejects(chat.conversations(token,user,'bad cursor'),e=>e.code==='invalid_cursor');
  const target=ids[0];currentId=randomUUID();now+=1000;
  await chat.send(token,user,{requestId:currentId,conversationId:target,text:'Title\n '+ 'а'.repeat(70)});
  const title=(await chat.conversations(token,user)).conversations[0];assert.equal(title.id,target);assert.equal([...title.title].length,60);
  now+=1000;await chat.history(token,user,undefined,target);
  await chat.send(token,user,{requestId:currentId,conversationId:target,text:'Title\n '+ 'а'.repeat(70)});
  assert.equal((await chat.conversations(token,user)).conversations[0].updatedAt,title.updatedAt);
});

test('late response remains bound to its original conversation and pending retries spend once', async () => {
  await setup();const ids=[randomUUID(),randomUUID()];for(const id of ids)await chat.createConversation(token,user,{conversationId:id});
  currentId=randomUUID();const requestId=currentId;let release,entered;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  respond=async()=>{entered();await hold;return new Response(JSON.stringify({requestId,answer:'Original thread answer',sources:[]}));};
  const data={requestId,conversationId:ids[0],text:'Original thread question'};
  const pending=chat.send(token,user,data);await ready;
  const retry=await chat.send(token,user,data);assert.equal(retry.status,'pending');assert.equal(retry.conversation.id,ids[0]);assert.equal(retry.conversation.title,'Original thread question');
  assert.equal((await chat.history(token,user,undefined,ids[1])).messages.length,0);
  await assert.rejects(chat.send(token,user,{...data,conversationId:ids[1]}),e=>e.code==='request_id_conflict');
  release();assert.equal((await pending).conversationId,ids[0]);assert.equal(calls,1);
  assert.equal((await chat.history(token,user,undefined,ids[0])).messages.length,2);
  assert.equal((await chat.history(token,user,undefined,ids[1])).messages.length,0);
});

test('title snippet expires after 90 days even when the thread remains active', async () => {
  await setup();const id=randomUUID();await chat.createConversation(token,user,{conversationId:id});currentId=randomUUID();
  await chat.send(token,user,{requestId:currentId,conversationId:id,text:'Private original title'});
  now+=89*86400000;await pool.query('UPDATE auth_sessions SET expires_at=$1',[new Date(now+3*86400000)]);currentId=randomUUID();
  await chat.send(token,user,{requestId:currentId,conversationId:id,text:'Recent question'});
  now+=2*86400000;
  assert.equal((await chat.conversations(token,user)).conversations[0].title,'Новый чат');
  assert.equal((await chat.history(token,user,undefined,id)).messages.length,2);
  await chat.cleanup();assert.equal((await pool.query('SELECT title FROM ai_chat_conversations WHERE id=$1',[id])).rows[0].title,'Новый чат');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM ai_chat_requests')).rows[0].n,1);
});

test('legacy insert compatibility and repeated migration preserve one owned conversation per account', async () => {
  await setup();const a=await chat.authorize(token,user),ids=[randomUUID(),randomUUID()];
  for(const requestId of ids)await pool.query(`INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status,accepted_at)
    VALUES($1,$2,'Old client synthetic','hash',$3,'completed',$4)`,[user,requestId,a.rightsHash,new Date(now)]);
  const first=(await chat.history(token,user)).conversationId;assert.ok(first);assert.equal((await chat.history(token,user)).messages.length,4);
  await pool.query(await readFile(new URL('../auth/ai-conversations-migration.sql',import.meta.url),'utf8'));
  assert.equal((await chat.history(token,user)).conversationId,first);assert.equal((await chat.conversations(token,user)).conversations.length,1);
  assert.equal((await pool.query('SELECT count(DISTINCT conversation_id)::integer AS n FROM ai_chat_requests')).rows[0].n,1);
});

test('conversation listing and creation reject session revoked during processing', async () => {
  for(const action of ['list','create']){
    await setup();let armed=true;
    const observingPool={connect:()=>pool.connect(),async query(sql,args){const result=await pool.query(sql,args);
      if(armed&&sql.startsWith('SELECT * FROM ai_chat_conversations')){armed=false;await pool.query('UPDATE auth_sessions SET revoked_at=$1',[new Date(now)]);}return result;}};
    const observed=createAiChat({pool:observingPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
      url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now});
    if(action==='list')await assert.rejects(observed.conversations(token,user),e=>e.code==='sign_in_required');
    else {await pool.query('UPDATE auth_sessions SET revoked_at=$1',[new Date(now)]);await assert.rejects(observed.createConversation(token,user,{conversationId:randomUUID()}),e=>e.code==='sign_in_required');}
  }
});

test('conversation HTTP routes enforce auth and origin and return the selected history', async () => {
  await setup();const store=createStore(pool,{secret:'test-secret-longer-than-thirty-two-bytes',clock:()=>now});
  const server=createAuthServer({service,store,aiChat:chat,enabled:true,origin:'https://app.legkie-rody.ru'});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Cookie:`__Host-school_session=${token}`,'X-Webpril-Account':user,'Content-Type':'application/json',Origin:'https://app.legkie-rody.ru'};
  const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  try{
    assert.equal((await fetch(base+'/api/auth/ai/conversations')).status,401);
    const conversationId=randomUUID();assert.equal((await post('/api/auth/ai/conversations',{conversationId},{Origin:'https://foreign.invalid'})).status,403);
    const created=await post('/api/auth/ai/conversations',{conversationId});assert.equal(created.status,200);assert.equal((await created.json()).conversation.id,conversationId);
    assert.equal((await (await fetch(base+'/api/auth/ai/conversations',{headers})).json()).conversations.length,1);
    assert.equal((await (await post('/api/auth/ai/conversations/read',{})).json()).conversations.length,1);
    currentId=randomUUID();const sent=await post('/api/auth/ai/messages',{conversationId,requestId:currentId,text:'HTTP synthetic question'});assert.equal(sent.status,200);assert.equal((await sent.json()).conversationId,conversationId);
    const read=await post('/api/auth/ai/history/read',{conversationId});assert.equal(read.status,200);assert.equal((await read.json()).messages.length,2);
    const legacy=await fetch(base+'/api/auth/ai/history',{headers});assert.equal((await legacy.json()).messages.length,0);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('existing request migration backfills metadata once without rewriting old requests', async () => {
  const isolated=await testPool();
  try{
    const q=(sql,args)=>isolated.pool.query(sql,args);await q(await readFile(new URL('../auth/ai-chat-migration.sql',import.meta.url),'utf8'));
    const owners=[randomUUID(),randomUUID()],requests=[];
    for(let i=0;i<2;i++){
      await q('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,$3)',[owners[i],`migration-${i}@example.invalid`,100+i]);
      for(let j=0;j<2;j++){const id=randomUUID(),at=new Date(Date.parse('2026-11-01T00:00:00Z')+j*1000);requests.push({id,at});
        await q(`INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status,accepted_at,answer)
          VALUES($1,$2,'Synthetic preserved question','hash','rights','completed',$3,'Synthetic preserved answer')`,[owners[i],id,at]);}
    }
    const prior=(await q('SELECT * FROM ai_chat_requests ORDER BY id')).rows;
    const migration=await readFile(new URL('../auth/ai-conversations-migration.sql',import.meta.url),'utf8');await q(migration);await q(migration);
    const after=(await q('SELECT * FROM ai_chat_requests ORDER BY id')).rows;
    assert.deepEqual(after.map(({conversation_id,...row})=>row),prior);
    const conversations=(await q('SELECT * FROM ai_chat_conversations')).rows;assert.equal(conversations.length,2);
    for(const row of conversations){assert.equal(row.title,'Предыдущая переписка');assert.equal(row.legacy,true);
      assert.equal(new Date(row.created_at).toISOString(),'2026-11-01T00:00:00.000Z');assert.equal(new Date(row.updated_at).toISOString(),'2026-11-01T00:00:01.000Z');
      assert.equal(after.filter(r=>r.conversation_id===row.id).length,2);}
  }finally{await isolated.close();}
});

test('history pagination never includes neighboring conversations and respects retention', async () => {
  await setup();const ids=[randomUUID(),randomUUID()];for(const id of ids)await chat.createConversation(token,user,{conversationId:id});
  const a=await chat.authorize(token,user);
  for(let i=0;i<33;i++)await pool.query(`INSERT INTO ai_chat_requests(user_id,conversation_id,request_id,question,question_hash,rights_hash,status,accepted_at)
    VALUES($1,$2,$3,$4,'hash',$5,'failed',$6)`,[user,ids[i===32?1:0],randomUUID(),`Page ${i}`,a.rightsHash,new Date(now-(i===31?91:0)*86400000)]);
  const first=await chat.history(token,user,undefined,ids[0]);assert.equal(first.messages.length,30);assert.equal(first.hasMore,true);
  const second=await chat.history(token,user,first.nextBefore,ids[0]);assert.equal(second.messages.length,1);assert.equal(second.hasMore,false);
  const all=[...second.messages,...first.messages];assert.equal(new Set(all.map(m=>m.id)).size,31);assert.equal(all.some(m=>m.content==='Page 31'||m.content==='Page 32'),false);
});


test('conversation creation checks revocation again after its database write', async () => {
  await setup();const id=randomUUID();let armed=true;
  const observingPool={query:(...args)=>pool.query(...args),async connect(){const client=await pool.connect();
    return {release:()=>client.release(),async query(sql,args){const result=await client.query(sql,args);
      if(armed&&sql.startsWith('INSERT INTO ai_chat_conversations')){armed=false;await client.query('UPDATE auth_sessions SET revoked_at=$1',[new Date(now)]);}return result;}};}};
  const observed=createAiChat({pool:observingPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
    url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now});
  await assert.rejects(observed.createConversation(token,user,{conversationId:id}),e=>e.code==='sign_in_required');
  assert.equal(armed,false);assert.equal(calls,0);
});

test('concurrent creation and send preserve the first title and one conversation', async () => {
  await setup();const id=randomUUID();let entered,release;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let armed=true;
  const observingPool={query:(...args)=>pool.query(...args),async connect(){const client=await pool.connect();
    return {release:()=>client.release(),async query(sql,args){const result=await client.query(sql,args);
      if(armed&&sql.startsWith('INSERT INTO ai_chat_conversations')){armed=false;entered();await hold;}return result;}};}};
  const observed=createAiChat({pool:observingPool,service,courseMaterials:{aiContext:async()=>context},sourceMapPath,
    url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-lara-secret-longer-than-32-bytes',clock:()=>now,
    fetchImpl:async(...args)=>{calls++;return respond(...args);}});
  const creating=observed.createConversation(token,user,{conversationId:id});await ready;currentId=randomUUID();
  const sending=observed.send(token,user,{conversationId:id,requestId:currentId,text:'First synthetic title'});release();await creating;
  const result=await sending;assert.equal(result.conversation.title,'First synthetic title');
  await observed.createConversation(token,user,{conversationId:id});assert.equal((await observed.conversations(token,user)).conversations[0].title,'First synthetic title');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM ai_chat_conversations')).rows[0].n,1);assert.equal(calls,1);
});
