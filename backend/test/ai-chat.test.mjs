import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHmac } from 'node:crypto';
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
  folder = await mkdtemp(join(tmpdir(), 'webpril-ai-test-'));
  sourceMapPath = join(folder, 'source-map.json');
  await writeFile(sourceMapPath, JSON.stringify({ version: 1, sources: [] }));
});
after(async () => { await db?.close(); await rm(folder, { recursive: true, force: true }); });
async function setup() {
  await pool.query('TRUNCATE ai_chat_requests,ai_chat_daily_usage,auth_sessions,auth_users,auth_rate_limits');
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
  context.courses=[]; await assert.rejects(transcribe(),e=>e.code==='ai_purchase_required');
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
  context.courses=[]; await assert.rejects(transcribe(),e=>e.code==='ai_purchase_required');
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
    [422, 'private_provider_error', undefined],
    [502, 'invalid_attachment', undefined],
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
    const used = result.quota.used, callsBeforeRetry = calls;
    assert.equal((await chat.status(token, user, data)).quota.used, used);
    assert.equal((await chat.send(token, user, data)).status, 'failed');
    assert.equal(calls, callsBeforeRetry);
  }
  assert.equal(calls, expected.length); assert.equal((await chat.history(token, user)).quota.used, expected.length);
  currentId = randomUUID();
  respond = async () => new Response(JSON.stringify({ error: 'invalid_attachment', details: 'A'.repeat(128 * 1024) }), { status: 422 });
  const oversized = await chat.send(token, user, { requestId: currentId, text: 'Вопрос', attachment: pdf() });
  assert.equal(oversized.status, 'failed'); assert.equal(oversized.failureMessage, undefined);
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
  await assert.rejects(chat.status(token, user, { requestId: currentId }), e => e.code === 'ai_purchase_required');
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

test('purchase, account and session gate close both history and send', async () => {
  await setup(); currentId = randomUUID(); context = { courses: [], lessons: [] };
  await assert.rejects(chat.history(token, user), e => e.code === 'ai_purchase_required');
  await assert.rejects(ask(), e => e.code === 'ai_purchase_required');
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
  await assert.rejects(first, e => e.code === 'ai_unavailable');
  assert.equal((await chat.history(token, user)).messages[0].status, 'failed');
  assert.equal((await pool.query('SELECT answer FROM ai_chat_requests')).rows[0].answer, null);
});
