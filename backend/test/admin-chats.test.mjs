import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createAdmin } from '../auth/admin.mjs';
import { createAdminHttp } from '../auth/admin-http.mjs';
import { hashToken, randomToken, COOKIE_NAME } from '../auth/security.mjs';

test('admin chat moderation uses current grants, isolated rooms and public deletion semantics', async t => {
  const { pool, close } = await testPool();
  t.after(close);
  for (const file of ['club-chat-migration.sql', 'club-delete-migration.sql', 'club-rooms-migration.sql',
    'chat-reactions-migration.sql', 'points-migration.sql', 'points-article-migration.sql',
    'points-video-migration.sql', 'weekly-poll.sql', 'admin-migration.sql']) {
    await pool.query(await readFile(new URL('../auth/' + file, import.meta.url), 'utf8'));
  }
  let accountNumber = 100;
  async function account(email) {
    const id = randomUUID(), token = randomToken();
    await pool.query('INSERT INTO auth_users(id,email,getcourse_id,created_at,profile) VALUES($1,$2,$3,now(),$4)',
      [id, email, ++accountNumber, JSON.stringify({ name: email.split('@')[0] })]);
    await pool.query(`INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,now()+interval '1 hour',now())`, [hashToken(token), id]);
    return { id, token };
  }
  const owner = await account('owner@example.org'), editor = await account('editor@example.org'), student = await account('student@example.org');
  await pool.query('INSERT INTO admin_editors(user_id) VALUES($1)', [editor.id]);
  const admin = createAdmin({ pool, ownerEmail: 'owner@example.org', articles: {}, appOrigin: 'https://app.example.org' });
  const room = 'experts-birth', pollRoom = 'weekly-poll:2026-01-05';
  await pool.query(`INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES('2026-01-05','Архив',$1,'2026-01-05','2026-01-06')`, [['A', 'B']]);
  await pool.query('INSERT INTO club_state(room,revision) VALUES($1,0)', [pollRoom]);
  async function message(roomId, body, reply = null, photo = null) {
    const { rows: [state] } = await pool.query('UPDATE club_state SET revision=revision+1 WHERE room=$1 RETURNING revision', [roomId]);
    const { rows: [row] } = await pool.query(`INSERT INTO club_messages(room,author_id,request_id,body,revision,reply_to_id,screenshot)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [roomId, student.id, randomUUID(), body, state.revision, reply, photo]);
    return String(row.id);
  }
  const photoBytes = Buffer.from([255, 216, 255, 217]);
  const original = await message(room, 'Секрет 100%_\\', null, photoBytes);
  const reply = await message(room, 'Ответ', original);
  const archived = await message(pollRoom, 'Закрытая дискуссия');
  await message('pregnancy-students', 'Legacy скрыто');
  for (let n = 0; n < 53; n++) await message(room, `Сообщение ${n}`);
  const list = user => admin.chats(user.token, user.id);
  const history = (user, data = {}) => admin.chatMessages(user.token, user.id, { room, ...data });
  const status = code => error => error.status === code;

  await t.test('owner and all editors see only approved rooms, including archived polls', async () => {
    for (const user of [owner, editor]) {
      const result = await list(user);
      assert.equal(result.rooms.length, 10);
      assert.equal(result.rooms.find(r => r.id === pollRoom).closed, true);
      assert.equal(result.rooms.some(r => r.id === 'pregnancy-students'), false);
      assert.equal((await history(user, { room: pollRoom })).messages[0].id, archived);
    }
    await assert.rejects(list(student), status(403));
    await assert.rejects(admin.chats(null), status(401));
    await assert.rejects(admin.chats(editor.token, owner.id), status(409));
    for (const entry of (await list(owner)).rooms) {
      assert.equal((await history(editor, { room: entry.id })).room.id, entry.id);
    }
  });
  await t.test('pagination and literal search cannot escape room isolation', async () => {
    const first = await history(editor);
    assert.equal(first.messages.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, first.messages.at(-1).id);
    const second = await history(editor, { before: first.nextBefore });
    assert.equal(second.messages.length, 5);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.messages, ...second.messages].map(m => m.id)).size, 55);
    assert.deepEqual((await history(editor, { query: '%_\\' })).messages.map(m => m.id), [original]);
    assert.equal((await history(editor, { query: "' OR 1=1 --" })).messages.length, 0);
    for (const invalid of ['pregnancy-students', 'lara', 'weekly-poll:missing', `${room}' OR true --`]) {
      await assert.rejects(history(editor, { room: invalid }), status(404));
    }
    for (const invalid of ['0', '-1', '9223372036854775808', 123, '1;DROP']) {
      await assert.rejects(history(editor, { before: invalid }), status(400));
    }
    await assert.rejects(history(editor, { query: 'a'.repeat(201) }), status(400));
    await assert.rejects(history(editor, { query: '\x00' }), status(400));
    await assert.rejects(admin.deleteChatMessage(editor.token, editor.id, { room, id: '9223372036854775808' }), status(400));
    await assert.rejects(admin.deleteChatMessage(editor.token, editor.id, { room, id: reply, author: owner.id }), status(400));
  });
  await t.test('photo checks session and grant without requiring account header', async () => {
    assert.deepEqual(Buffer.from((await admin.chatPhoto(editor.token, undefined, room, original)).bytes), photoBytes);
    await assert.rejects(admin.chatPhoto(student.token, undefined, room, original), status(403));
    await assert.rejects(admin.chatPhoto(owner.token, owner.id, pollRoom, original), status(404));
    await assert.rejects(admin.chatPhoto(owner.token, owner.id, room, '9223372036854775808'), status(400));
  });
  await t.test('delete increments room revision, removes photo/reactions, clears quotes, audits once', async () => {
    await pool.query(`INSERT INTO club_message_reactions(message_id,user_id,reaction) VALUES($1,$2,'heart')`, [original, student.id]);
    const { rows: [before] } = await pool.query('SELECT revision FROM club_state WHERE room=$1', [room]);
    await assert.rejects(admin.deleteChatMessage(student.token, student.id, { room, id: original }), status(403));
    await assert.rejects(admin.deleteChatMessage(editor.token, editor.id, { room: pollRoom, id: original }), status(404));
    assert.deepEqual(await admin.deleteChatMessage(editor.token, editor.id, { room, id: original }), { deletedId: original, duplicate: false });
    assert.equal((await admin.deleteChatMessage(owner.token, owner.id, { room, id: original })).duplicate, true);
    const { rows: [deleted] } = await pool.query('SELECT * FROM club_messages WHERE id=$1', [original]);
    assert.equal(deleted.body, ''); assert.equal(deleted.screenshot, null); assert.ok(deleted.deleted_at); assert.ok(deleted.request_digest);
    assert.equal(BigInt(deleted.revision), BigInt(before.revision) + 1n);
    assert.equal((await pool.query('SELECT 1 FROM club_message_reactions WHERE message_id=$1', [original])).rows.length, 0);
    const quoted = (await history(owner, { query: 'Ответ' })).messages.find(m => m.id === reply).reply;
    assert.equal(quoted.deleted, true); assert.equal(quoted.text, null);
    assert.equal((await pool.query("SELECT * FROM admin_audit WHERE action='chat_message_deleted'")).rows.length, 1);
    await assert.rejects(admin.chatPhoto(editor.token, undefined, room, original), status(404));
    assert.equal((await admin.deleteChatMessage(owner.token, owner.id, { room: pollRoom, id: archived })).duplicate, false);
  });
  await t.test('revocation immediately blocks reads, photos and writes', async () => {
    await pool.query('DELETE FROM admin_editors WHERE user_id=$1', [editor.id]);
    await assert.rejects(list(editor), status(403));
    await assert.rejects(history(editor), status(403));
    await assert.rejects(admin.chatPhoto(editor.token, undefined, room, original), status(403));
    await assert.rejects(admin.deleteChatMessage(editor.token, editor.id, { room, id: reply }), status(403));
    await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1', [editor.id]);
    await assert.rejects(list(editor), status(401));
    await assert.rejects(history(editor), status(401));
    await assert.rejects(admin.chatPhoto(editor.token, undefined, room, original), status(401));
    await assert.rejects(admin.deleteChatMessage(editor.token, editor.id, { room, id: reply }), status(401));
  });
  await t.test('HTTP uses path photo URLs, no-store, same-origin POST and no query strings', async () => {
    let adminHttp;
    const server = createServer(async (req, res) => {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      try { await adminHttp(req, res, new URL(req.url, 'http://127.0.0.1'), send, async request => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks));
      }); } catch (error) { send(error.status ?? 500, { error: error.code }); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    adminHttp = await createAdminHttp({ admin, origin: base, frontend: fileURLToPath(new URL('../../Фронт/admin/', import.meta.url)) });
    const headers = { Cookie: `${COOKIE_NAME}=${owner.token}` };
    const photo = await message(pollRoom, 'Фото архива', null, photoBytes);
    const url = `${base}/api/admin/chats/${encodeURIComponent(pollRoom)}/messages/${photo}/photo`;
    const result = await fetch(url, { headers });
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/jpeg');
    assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(Buffer.from(await result.arrayBuffer()), photoBytes);
    assert.equal((await fetch(url + '?room=lara', { headers })).status, 400);
    assert.equal((await fetch(url)).status, 401);
    const post = { ...headers, 'Content-Type': 'application/json', 'X-Webpril-Account': owner.id };
    assert.equal((await fetch(base + '/api/admin/chats/messages', { method: 'POST', headers: post, body: JSON.stringify({ room }) })).status, 403);
    const response = await fetch(base + '/api/admin/chats/messages', { method: 'POST', headers: { ...post, Origin: base }, body: JSON.stringify({ room: pollRoom }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).messages[0].id, photo);
    const removed = await fetch(base + '/api/admin/chats/delete', { method: 'POST', headers: { ...post, Origin: base }, body: JSON.stringify({ room: pollRoom, id: photo }) });
    assert.equal(removed.status, 200); assert.equal((await removed.json()).deletedId, photo);
    assert.equal((await fetch(url, { headers })).status, 404);
  });
});
