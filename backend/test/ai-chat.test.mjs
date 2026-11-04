import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { createAiChat } from '../auth/ai-chat.mjs';
import { createStore } from '../auth/store.mjs';
import { hashToken, randomToken } from '../auth/security.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { once } from 'node:events';

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
  respond = async () => ({ ok: true, json: async () => ({ requestId: currentId, answer: 'Ответ', sources: [{ id: '2', title: 'подмена', url: 'https://evil.invalid' }] }) });
  chat = createAiChat({ pool, service, courseMaterials: { aiContext: async () => context }, sourceMapPath,
    url: 'https://admin.legkie-rody.ru/internal/lara-web/reply', secret: 'test-lara-secret-longer-than-32-bytes',
    clock: () => now, fetchImpl: async (...args) => { calls++; return respond(...args); } });
}
let currentId;
const ask = (text = 'Вопрос', id = currentId) => chat.send(token, user, { requestId: id, text });

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
      sources: [{ id: 'Курс:breath.md' }, { id: '999' }] }) };
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
