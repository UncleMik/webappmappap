import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createArticleServer } from '../server.mjs';

test('Only published public articles are readable; weeks, errors, caching and write protection work', async () => {
  const db = openDatabase(':memory:', false);
  const insert = db.prepare('INSERT INTO articles(id,number,week,title,minutes,blocks,status,access) VALUES(?,?,?,?,?,?,?,?)');
  insert.run('pregnancy-001', 1, 1, 'Первая статья', 1, '[{"type":"paragraph","text":"Текст"}]', 'published', 'public');
  insert.run('pregnancy-002', 2, 1, 'Черновик', 1, '[]', 'draft', 'public');
  insert.run('pregnancy-003', 3, 1, 'Закрытая статья', 1, '[]', 'published', 'restricted');
  const server = createArticleServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/articles?week=1`);
    const body = await response.json();
    assert.deepEqual(body.articles.map(article => article.id), ['pregnancy-001']);
    assert.equal(body.articles[0].blocks, undefined);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://unclemik.github.io');
    assert.equal((await fetch(`${base}/api/articles/pregnancy-001`)).status, 200);
    assert.equal((await fetch(`${base}/api/articles/pregnancy-002`)).status, 404);
    assert.equal((await fetch(`${base}/api/articles/pregnancy-003`)).status, 404);
    assert.equal((await fetch(`${base}/api/articles?week=43`)).status, 400);
    assert.equal((await fetch(`${base}/api/articles?week=`)).status, 400);
    assert.equal((await fetch(`${base}/api/articles`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/articles?week=1`, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(`${base}/api/articles/pregnancy-001`, { method: 'HEAD' })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
