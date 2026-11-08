import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAuthServer } from '../auth/http.mjs';
import { COOKIE_NAME } from '../auth/security.mjs';

test('weekly video source and each media request require a current, completed session', async () => {
  let loggedIn = true, completed = true;
  const token = 'a'.repeat(43);
  const cookie = { cookie: COOKIE_NAME + '=' + token };
  const calls = [];
  const service = {
    session: async value => loggedIn && value === token
      ? { id: 'free-user', profile: completed ? { completedAt: '2026-10-19T00:00:00Z' } : null }
      : null,
  };
  const weeklyMedia = async (request, response, position, asset) => {
    calls.push([request.method, position, asset, request.headers.range]);
    response.writeHead(request.headers.range ? 206 : 200, {
      'Content-Type': asset === 'cover' ? 'image/png' : 'video/mp4',
      'Cache-Control': 'private, no-store',
      ...(request.headers.range ? { 'Content-Range': 'bytes 0-3/100' } : {}),
    });
    response.end('data');
  };
  const server = createAuthServer({ service, weeklyMedia, origin: 'https://app.legkie-rody.ru', enabled: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/auth/videos/';
  try {
    assert.equal((await fetch(url + 'contractions-lesson')).status, 401);
    assert.equal((await fetch(url + 'week-video-004/file', { headers: { Range: 'bytes=0-3' } })).status, 401);
    assert.equal((await fetch(url + 'week-video-004/cover', { method: 'HEAD' })).status, 401);
    assert.deepEqual(calls, []);
    for (const id of ['contractions-lesson', 'back-relief-video', 'birth-breathing-video', 'week-video-004', 'week-video-126']) {
      const result = await fetch(url + id, { headers: cookie });
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { source: '/api/auth/videos/' + id + '/file' });
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    const range = await fetch(url + 'week-video-004/file', { headers: { ...cookie, Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-3/100');
    assert.equal(await range.text(), 'data');
    assert.equal((await fetch(url + 'contractions-lesson/cover', { method: 'HEAD', headers: cookie })).status, 200);
    assert.deepEqual(calls, [['GET', '004', 'file', 'bytes=0-3'], ['HEAD', '001', 'cover', undefined]]);
    for (const path of ['week-video-075', 'week-video-075/file', 'week-video-075/cover', 'unknown/file']) {
      assert.equal((await fetch(url + path, { headers: cookie })).status, 404);
    }
    completed = false;
    const incomplete = await fetch(url + 'week-video-004/file', { headers: cookie });
    assert.equal(incomplete.status, 403);
    assert.equal((await incomplete.json()).error, 'onboarding_required');
    completed = true;
    loggedIn = false;
    assert.equal((await fetch(url + 'week-video-004/file', { headers: cookie })).status, 401);
    assert.equal(calls.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
