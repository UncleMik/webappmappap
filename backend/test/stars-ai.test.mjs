import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { transaction } from '../auth/store.mjs';
import { createStarsAi } from '../auth/stars-ai.mjs';
import { createAiChat } from '../auth/ai-chat.mjs';
import { DEFAULT_GAMIFICATION_SETTINGS } from '../auth/gamification-settings.mjs';
import { hashToken, randomToken } from '../auth/security.mjs';
let db,pool,now,config,settings,ai,folder,sourceMapPath, gc=0;
before(async()=>{
  db=await testPool();pool=db.pool;
  for(const file of ['ai-chat-migration.sql','ai-failure-migration.sql','ai-conversations-migration.sql','stars-ai-migration.sql']) await pool.query(await readFile(new URL('../auth/'+file,import.meta.url),'utf8'));
  await pool.query('CREATE TABLE auth_stars_ai_credits(user_id uuid PRIMARY KEY REFERENCES auth_users(id),balance integer NOT NULL DEFAULT 0 CHECK(balance>=0))');
  folder=await mkdtemp(join(tmpdir(),'stars-ai-unit-'));sourceMapPath=join(folder,'sources.json');await writeFile(sourceMapPath,JSON.stringify({version:1,sources:[]}));
});
after(async()=>{await db?.close();if(folder)await rm(folder,{recursive:true,force:true});});
async function setup(){
  now=new Date('2026-11-12T20:59:59Z');config=structuredClone(DEFAULT_GAMIFICATION_SETTINGS);config.enabled=true;config.audience={mode:'all',userIds:[]};config.features.aiPacks=true;config.aiBudgetApproved=true;
  settings={get:async()=>config};ai=createStarsAi({pool,settings,clock:()=>now});
  const userId=randomUUID();await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$4,$3)',[userId,userId+'@example.invalid',JSON.stringify({name:'Имя',stage:'pregnancy',dueDate:'2027-03-01',completedAt:now.toISOString()}),++gc]);
  await pool.query('INSERT INTO auth_stars_ai_credits(user_id,balance) VALUES($1,10)',[userId]);return {userId,tier:'free',now};
}
const reserve=(ctx,id=randomUUID())=>transaction(pool,client=>ai.reserve(client,ctx,{requestId:id}));
test('one remaining free question accepts a reservation; duplicate and refund are idempotent across Moscow midnight',async()=>{
  const ctx=await setup(),id=randomUUID();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,4)',[ctx.userId,'2026-11-12']);
  const row=await reserve(ctx,id);assert.equal(row.free_units,1);assert.equal(row.paid_units,0);
  assert.equal((await reserve(ctx,id)).duplicate,true);let q=await ai.quota(pool,ctx);assert.equal(q.used,5);assert.equal(q.paidUsed,0);assert.equal(q.paidRemaining,10);assert.equal(q.resetsAt,'2026-11-12T21:00:00.000Z');
  now=new Date('2026-11-12T21:00:00Z');assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:id})),true);
  assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:id})),false);
  q=await ai.quota(pool,{...ctx,now});assert.equal(q.used,0);assert.equal(q.paidUsed,0);assert.equal(q.paidRemaining,10);
  assert.equal((await pool.query('SELECT used FROM ai_chat_daily_usage WHERE user_id=$1 AND day_moscow=$2',[ctx.userId,'2026-11-12'])).rows[0].used,4);
});
test('historical two-unit reservation still refunds free and bought units exactly once',async()=>{
  const ctx=await setup(),id=randomUUID();
  await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,5)',[ctx.userId,'2026-11-12']);
  await pool.query('INSERT INTO auth_stars_ai_daily_usage VALUES($1,$2,1)',[ctx.userId,'2026-11-12']);
  await pool.query('UPDATE auth_stars_ai_credits SET balance=9 WHERE user_id=$1',[ctx.userId]);
  await pool.query('INSERT INTO auth_stars_ai_reservations(user_id,request_id,day_moscow,free_units,paid_units) VALUES($1,$2,$3,1,1)',[ctx.userId,id,'2026-11-12']);
  assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:id})),true);
  assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:id})),false);
  const q=await ai.quota(pool,ctx);assert.equal(q.used,4);assert.equal(q.paidUsed,0);assert.equal(q.paidRemaining,10);
});
test('parallel reservations cannot overspend and tier changes share the same usage',async()=>{
  const ctx=await setup();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,5)',[ctx.userId,'2026-11-12']);
  const results=await Promise.allSettled(Array.from({length:8},()=>reserve(ctx)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,6);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='ai_daily_limit').length,2);
  let q=await ai.quota(pool,{...ctx,tier:'course'});assert.equal(q.used,5);assert.equal(q.paidUsed,6);assert.equal(q.freeRemaining,25);assert.equal(q.paidDailyRemaining,4);
  q=await ai.quota(pool,ctx);assert.equal(q.totalRemaining,0);assert.equal(q.paidRemaining,4);
});
test('settings change actual limits; disabled budget never destroys accumulated stock',async()=>{
  const ctx=await setup();config.ai.freeDaily=2;config.ai.freePaidDaily=1;
  assert.equal((await ai.quota(pool,ctx)).maximum,3);
  await reserve(ctx);await reserve(ctx);await reserve(ctx);await assert.rejects(reserve(ctx),e=>e.code==='ai_daily_limit');
  config.aiBudgetApproved=false;let q=await ai.quota(pool,ctx);assert.equal(q.paidRemaining,9);assert.equal(q.paidDailyRemaining,0);
  config.aiBudgetApproved=true;config.features.aiPacks=false;q=await ai.quota(pool,ctx);assert.equal(q.paidRemaining,9);assert.equal(q.totalRemaining,0);
  // Reapplying migration does not reset old free or bought spending.
  await pool.query(await readFile(new URL('../auth/stars-ai-migration.sql',import.meta.url),'utf8'));
  assert.equal((await ai.quota(pool,ctx)).used,2);
});
async function chatFor(ctx,{urgent,fail=false,afterReply}={}){
  await pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL',[now,ctx.userId]);
  const token=randomToken();await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),ctx.userId,new Date(+now+86400000)]);
  let calls=0;
  const chat=createAiChat({pool,settings,starsAi:ai,sourceMapPath,clock:()=>now,urgent,
    service:{session:async t=> t===token?(await pool.query('SELECT id,profile FROM auth_users WHERE id=$1',[ctx.userId])).rows[0]:null},
    courseMaterials:{aiContext:async()=>({courses:[],lessons:[]})},url:'https://admin.legkie-rody.ru/internal/lara-web/reply',secret:'test-secret-longer-than-thirty-two-bytes',
    fetchImpl:async(_url,{body})=>{calls++;if(fail)throw Error('synthetic failure');if(afterReply)await afterReply();return {ok:true,json:async()=>({requestId:JSON.parse(body).requestId,answer:'Ответ',sources:[]})};}});
  return {chat,token,calls:()=>calls};
}
test('text and file each spend one question across the free and bought boundary',async()=>{
  const ctx=await setup();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,4)',[ctx.userId,'2026-11-12']);
  const {chat,token,calls}=await chatFor(ctx);
  const file={requestId:randomUUID(),text:'Проверь файл',attachment:{name:'synthetic.pdf',mimeType:'application/pdf',data:Buffer.from('%PDF-1.4 synthetic').toString('base64')}};
  const first=await chat.send(token,ctx.userId,file);assert.equal(first.status,'completed');assert.equal(first.quota.used,5);assert.equal(first.quota.paidUsed,0);
  const text={requestId:randomUUID(),text:'Следующий вопрос'};
  const second=await chat.send(token,ctx.userId,text);assert.equal(second.status,'completed');assert.equal(second.quota.used,5);assert.equal(second.quota.paidUsed,1);
  assert.equal(second.quota.paidRemaining,9);
  const duplicate=await chat.send(token,ctx.userId,file);assert.equal(duplicate.quota.paidUsed,1);assert.equal(calls(),2);
  const rows=(await pool.query('SELECT free_units,paid_units FROM auth_stars_ai_reservations WHERE user_id=$1 ORDER BY request_id',[ctx.userId])).rows;
  assert.equal(rows.length,2);assert.equal(rows.reduce((sum,row)=>sum+row.free_units+row.paid_units,0),2);
});
test('pre-migration stale pending refunds only its old free unit and preserves spent usage',async()=>{
  const ctx=await setup();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,3)',[ctx.userId,'2026-11-12']);
  await pool.query("INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status,accepted_at) VALUES($1,$2,'old','old','old','pending',$3)",[ctx.userId,randomUUID(),new Date(+now-120000)]);
  const {chat,token}=await chatFor(ctx,{fail:true});
  let result=await chat.send(token,ctx.userId,{requestId:randomUUID(),text:'Вопрос'});assert.equal(result.status,'failed');assert.equal(result.quota.used,2);
  await chat.history(token,ctx.userId);assert.equal((await chat.readQuota(token,ctx.userId)).quota.used,2);
  assert.equal((await pool.query('SELECT status FROM ai_chat_requests WHERE user_id=$1',[ctx.userId])).rows.every(r=>r.status==='failed'),true);
});
test('urgent preview is free; explicit continuation charges once, a new message screens again and retained UUID cannot bypass billing',async()=>{
  const ctx=await setup(),{chat,token,calls}=await chatFor(ctx,{urgent:{evaluate:async()=>({contentId:'synthetic',revision:1,title:'Synthetic warning',free:true})}});
  const message={requestId:randomUUID(),text:'Synthetic symptom'};
  const warning=await chat.send(token,ctx.userId,message);assert.equal(warning.status,'urgent');assert.equal(warning.quota.used,0);assert.equal(calls(),0);
  assert.equal((await pool.query('SELECT * FROM ai_chat_requests WHERE user_id=$1',[ctx.userId])).rows.length,0);
  assert.equal((await chat.send(token,ctx.userId,{...message,urgentContinue:true})).status,'urgent');
  const accepted={...message,urgentContinue:warning.urgent.continueToken};
  assert.equal((await chat.send(token,ctx.userId,accepted)).status,'completed');assert.equal((await chat.send(token,ctx.userId,accepted)).quota.used,1);assert.equal(calls(),1);
  assert.equal((await chat.send(token,ctx.userId,{...message,requestId:randomUUID(),urgentContinue:warning.urgent.continueToken})).status,'urgent');
  await pool.query('DELETE FROM ai_chat_requests WHERE user_id=$1',[ctx.userId]);
  await assert.rejects(chat.send(token,ctx.userId,accepted),e=>e.code==='request_id_conflict');assert.equal(calls(),1);
});

test('session revoked after provider success fails pending request and refunds paid/free exactly once',async()=>{
  const ctx=await setup();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,5)',[ctx.userId,'2026-11-12']);
  const {chat,token}=await chatFor(ctx,{afterReply:()=>pool.query('UPDATE auth_sessions SET revoked_at=$1 WHERE user_id=$2',[now,ctx.userId])});
  const message={requestId:randomUUID(),text:'Файл',attachment:{name:'synthetic.pdf',mimeType:'application/pdf',data:Buffer.from('%PDF-1.4\nsynthetic\n%%EOF').toString('base64')}};
  await assert.rejects(chat.send(token,ctx.userId,message),e=>e.code==='sign_in_required');
  const q=await ai.quota(pool,ctx);assert.equal(q.used,5);assert.equal(q.paidUsed,0);assert.equal(q.paidRemaining,10);
  const row=(await pool.query('SELECT status FROM ai_chat_requests WHERE user_id=$1 AND request_id=$2',[ctx.userId,message.requestId])).rows[0];assert.equal(row.status,'failed');
  assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:message.requestId})),false);
});

test('selected pilot changes only included account: all files charge one question',async()=>{
  const included=await setup(),excluded=await setup();
  config.audience={mode:'selected',userIds:[included.userId]};config.ai.freeDaily=2;config.ai.courseDaily=8;
  assert.equal((await ai.quota(pool,included)).limit,2);assert.equal((await ai.quota(pool,excluded)).limit,5);
  assert.equal((await ai.quota(pool,{...excluded,tier:'course'})).limit,30);assert.equal((await ai.quota(pool,excluded)).paidDailyRemaining,0);
  const attachment={name:'synthetic.pdf',mimeType:'application/pdf',data:Buffer.from('%PDF-1.4 synthetic').toString('base64')};
  for(const ctx of [included,excluded]){
    const {chat,token}=await chatFor(ctx,{fail:true});
    const result=await chat.send(token,ctx.userId,{requestId:randomUUID(),text:'Файл',attachment});assert.equal(result.status,'failed');
    assert.equal(result.quota.used,ctx===included?0:1);
    const reservations=(await pool.query('SELECT * FROM auth_stars_ai_reservations WHERE user_id=$1',[ctx.userId])).rows;
    assert.equal(reservations.length,ctx===included?1:0);if(ctx===included)assert.equal(reservations[0].free_units,1);
  }
  config.enabled=false;assert.equal((await ai.quota(pool,included)).limit,5);
  const {chat,token}=await chatFor(included,{fail:true});
  assert.equal((await chat.send(token,included.userId,{requestId:randomUUID(),text:'Ещё файл',attachment})).quota.used,1);
});
test('removing account from pilot preserves stock and still refunds an existing accepted reservation',async()=>{
  const ctx=await setup(),id=randomUUID();await pool.query('INSERT INTO ai_chat_daily_usage VALUES($1,$2,4)',[ctx.userId,'2026-11-12']);
  await reserve(ctx,id);config.audience={mode:'selected',userIds:[]};
  assert.equal((await ai.quota(pool,ctx)).paidRemaining,10);assert.equal((await ai.quota(pool,ctx)).paidDailyRemaining,0);
  assert.equal(await transaction(pool,c=>ai.refund(c,{userId:ctx.userId,requestId:id})),true);
  assert.equal((await ai.quota(pool,ctx)).paidRemaining,10);assert.equal((await ai.quota(pool,ctx)).used,4);
});
