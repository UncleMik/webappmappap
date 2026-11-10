import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { openDatabase, readArticle } from '../database.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { createAdmin } from '../auth/admin.mjs';
import { openAdminArticles } from '../auth/admin-articles.mjs';
import { createAdminHttp } from '../auth/admin-http.mjs';
import { createWeeklyPoll } from '../auth/weekly-poll.mjs';
import { COOKIE_NAME, randomToken, hashToken } from '../auth/security.mjs';
import { testPool } from './auth-pool.mjs';

test('admin HTTP enforces roles, publishes shared content and freezes a poll at opening', async t => {
  const { pool, close } = await testPool();
  t.after(close);
  for (const migration of ['points-migration.sql', 'points-article-migration.sql', 'points-video-migration.sql', 'weekly-poll.sql', 'admin-migration.sql']) {
    await pool.query(await readFile(new URL('../auth/' + migration, import.meta.url), 'utf8'));
  }
  const dir = await mkdtemp(join(tmpdir(), 'webpril-admin-test-'));
  const file = join(dir, 'articles.sqlite');
  openDatabase(file, false).close();
  const articles = openAdminArticles(file, dir);
  const reader = openDatabase(file);
  t.after(async () => { reader.close(); articles.close(); await rm(dir, { force: true, recursive: true }); });
  const ownerEmail = 'owner@example.org', editorEmail = 'editor@example.org', studentEmail = 'student@example.org';
  const adminOrigin = 'https://129.101.119.250', appOrigin = 'https://app.example.org';
  async function account(email, n) {
    const id = randomUUID(), token = randomToken();
    await pool.query('INSERT INTO auth_users(id,email,getcourse_id,created_at) VALUES($1,$2,$3,now())', [id, email, n]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at)
      VALUES($1,$2,now()+interval '1 hour',now())`, [hashToken(token), id]);
    return { id, token };
  }
  const owner = await account(ownerEmail, '101'), editor = await account(editorEmail, '102'), student = await account(studentEmail, '103');
  const store = createStore(pool, { secret: 'a test secret never used in production' });
  const mail = [];
  const service = createAuthService({ store, makeCode: () => '024681', sendMail: async args => mail.push(args),
    ensureGetCourse: () => assert.fail('staff already exist') });
  const admin = createAdmin({ pool, articles, ownerEmail, appOrigin });
  const adminHttp = await createAdminHttp({ admin, service, store, origin: adminOrigin, uploads: dir,
    frontend: fileURLToPath(new URL('../../Фронт/admin/', import.meta.url)), mailPerMinute: 20 });
  const weeklyPoll = createWeeklyPoll(pool);
  const server = createAuthServer({ service, store, weeklyPoll, admin, adminHttp, origin: appOrigin, enabled: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, { user, body, origin = adminOrigin, accountId = user?.id, host = new URL(adminOrigin).host } = {}) {
    const headers = { Host: host };
    if (user) headers.Cookie = COOKIE_NAME + '=' + user.token;
    if (accountId) headers['X-Webpril-Account'] = accountId;
    if (body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json' });
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + path, { method: body === undefined ? 'GET' : 'POST', headers }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
        incoming.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  assert.equal((await request('/admin')).headers.get('location'), '/admin/login');
  assert.equal((await request('/admin', { user: student })).headers.get('location'), '/admin/login#access');
  assert.equal((await request('/api/admin/session', { user: student })).status, 403);
  assert.equal((await request('/api/admin/session', { user: owner, host: 'app.example.org' })).status, 404);
  assert.equal((await request('/api/admin/request', { body: { email: studentEmail } })).status, 403);
  assert.equal(mail.length, 0);
  const ownerCode = await request('/api/admin/request', { body: { email: ownerEmail } });
  assert.equal(ownerCode.status, 200);
  const { challenge } = await ownerCode.json();
  assert.equal(mail[0].email, ownerEmail);
  const verified = await request('/api/admin/verify', { body: { challenge, code: '024681' } });
  assert.equal(verified.status, 200);
  assert.match(verified.headers.get('set-cookie'), /HttpOnly; Secure/);
  owner.token = verified.headers.get('set-cookie').split(';')[0].slice(COOKIE_NAME.length + 1);
  assert.equal((await request('/admin', { user: owner })).status, 200);
  assert.equal((await request('/api/admin/staff', { user: owner, origin: appOrigin, body: { email: editorEmail, grant: true } })).status, 403);
  const granted = await request('/api/admin/staff', { user: owner, body: { email: editorEmail, grant: true } });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json())[0].email, editorEmail);
  assert.equal((await (await request('/api/admin/session', { user: editor })).json()).role, 'editor');
  assert.equal((await request('/api/admin/staff', { user: editor, body: { email: studentEmail, grant: true } })).status, 403);
  assert.equal((await request('/api/admin/staff', { user: editor })).status, 403);

  const cover = await readFile(new URL('../../Фронт/assets/auth-mother-v1.webp', import.meta.url));
  const draft = { week: 24, title: 'Новая статья', blocks: [{ type: 'paragraph', text: 'Учебный текст.' }],
    requestId: randomUUID(), cover: cover.toString('base64') };
  const created = await request('/api/admin/articles', { user: editor, body: draft });
  assert.equal(created.status, 200);
  const item = await created.json();
  assert.equal(readArticle(reader, item.id).title, draft.title);
  const coverPath = item.image.replace('/uploads/articles/', '/admin/cover/');
  assert.equal((await request(coverPath)).status, 401);
  assert.deepEqual(Buffer.from(await (await request(coverPath, { user: editor })).arrayBuffer()), cover);
  assert.equal((await (await request('/api/admin/articles', { user: editor, body: draft })).json()).id, item.id);
  const visibilityPath = '/api/admin/articles/' + item.id + '/visibility';
  const hidden = await request(visibilityPath, { user: editor, body: { visible: false, revision: item.revision, requestId: randomUUID() } });
  assert.equal(hidden.status, 200);
  assert.equal(readArticle(reader, item.id), null);
  assert.equal((await request(visibilityPath, { user: editor, body: { visible: true, revision: item.revision, requestId: randomUUID() } })).status, 409);
  assert.equal((await request(visibilityPath, { user: editor, body: { visible: true, revision: (await hidden.json()).revision, requestId: randomUUID() } })).status, 200);
  assert.ok(readArticle(reader, item.id));

  const announcement = { id: randomUUID(), title: 'Новости школы', body: 'Новый опрос.', link: '/club.html#events' };
  assert.equal((await request('/api/admin/announcements', { user: editor, body: { ...announcement, link: '//outside.example.org' } })).status, 400);
  assert.equal((await request('/api/admin/announcements', { user: editor, body: announcement })).status, 200);
  assert.equal((await request('/api/admin/announcements', { user: editor, body: announcement })).status, 200);
  const publicPath = '/api/auth/announcements';
  assert.equal((await request(publicPath)).status, 401);
  const feed = async () => (await (await request(publicPath, { user: student })).json()).announcements;
  assert.deepEqual((await feed()).map(row => row.id), [announcement.id]);
  assert.equal((await request('/api/admin/announcements/' + announcement.id + '/hide', { user: editor, body: {} })).status, 200);
  assert.deepEqual(await feed(), []);

  const current = new Date();
  const week = new Date(+current + (7 + ((8 - current.getUTCDay()) % 7)) * 86_400_000).toISOString().slice(0, 10);
  const poll = { week, question: 'Какая тема полезнее?', options: ['Первая', 'Вторая'] };
  const scheduled = await request('/api/admin/polls', { user: editor, body: poll });
  assert.equal(scheduled.status, 200);
  const next = await scheduled.json();
  assert.equal(next.status, 'scheduled');
  assert.equal(new Date(next.opensAt).toISOString(), new Date(week + 'T00:00:00+03:00').toISOString());
  assert.equal((await request('/api/admin/polls', { user: editor, body: poll })).status, 409);
  const changed = await request('/api/admin/polls', { user: editor, body: { ...poll, revision: next.revision, question: 'Уточнённый вопрос' } });
  assert.equal(changed.status, 200);
  const revised = await changed.json();
  const pollList = await request('/api/admin/polls', { user: editor });
  assert.equal(pollList.status, 200);
  assert.deepEqual((await pollList.json()).find(row => row.id === week).counts, [0, 0]);
  assert.notEqual((await weeklyPoll.read(student.id)).poll?.id, week);
  await pool.query(`UPDATE weekly_polls SET opens_at=now()-interval '1 minute',closes_at=now()+interval '1 minute' WHERE id=$1`, [week]);
  assert.equal((await weeklyPoll.read(student.id)).poll.id, week);
  assert.equal((await request('/api/admin/polls', { user: editor, body: { ...poll, revision: revised.revision } })).status, 409);
  assert.equal((await weeklyPoll.vote(student.token, student.id, { pollId: week, choice: 0 })).choice, 0);
  await pool.query("UPDATE weekly_polls SET closes_at=now()-interval '1 second' WHERE id=$1", [week]);
  await weeklyPoll.settle();
  await weeklyPoll.settle();
  const { rows: [reward] } = await pool.query('SELECT amount FROM auth_points_ledger WHERE poll_id=$1 AND user_id=$2', [week, student.id]);
  assert.equal(reward.amount, 100);

  assert.equal((await request('/api/admin/staff', { user: owner, body: { email: editorEmail, grant: false } })).status, 200);
  assert.equal((await request('/api/admin/articles', { user: editor, body: { ...draft, requestId: randomUUID() } })).status, 403);
  const history = await (await request('/api/admin/history', { user: owner })).json();
  assert.equal(history.filter(row => row.action === 'article_published').length, 1);
  assert.equal(history.filter(row => row.action === 'announcement_published').length, 1);
  assert.ok(history.some(row => row.action === 'staff_revoked' && row.actor === ownerEmail && row.target === editorEmail));
});
