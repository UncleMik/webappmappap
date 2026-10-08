import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, readArticles, readArticle, readWeeklyContent } from './database.mjs';

export function createArticleServer(db, origin = 'https://unclemik.github.io') {
  return createServer((request, response) => {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=60',
    };
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      if (status === 200 && request.headers['if-none-match'] === etag) { response.writeHead(304, { ...headers, ETag: etag }); response.end(); return; }
      response.writeHead(status, { ...headers, ETag: etag, ...(status !== 200 ? { 'Cache-Control': 'no-store' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD, OPTIONS'); send(405, { error: 'Method not allowed' }); return; }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') { send(200, { status: 'ok', project: 'wep_pril', articles: readArticles(db).length }); return; }
      if (url.pathname === '/api/weekly-content') { send(200, readWeeklyContent(db)); return; }
      if (url.pathname === '/api/articles') {
        const value = url.searchParams.get('week');
        if (value !== null && (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 42)) { send(400, { error: 'Invalid week' }); return; }
        send(200, { articles: readArticles(db, value === null ? null : Number(value)) }); return;
      }
      const match = url.pathname.match(/^\/api\/articles\/(pregnancy-\d{3})$/);
      if (match) {
        const article = readArticle(db, match[1]);
        send(article ? 200 : 404, article || { error: 'Article not found' }); return;
      }
      send(404, { error: 'Not found' });
    } catch (error) { console.error('Article request failed', error.message); send(500, { error: 'Service unavailable' }); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase(process.env.DATABASE_PATH || '/opt/wep_pril/data/articles.sqlite');
  const server = createArticleServer(db);
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('wep_pril listening on localhost'));
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
