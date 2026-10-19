// Isolated synthetic QA. Never used by production main.mjs or deployed as a service.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { testPool } from '../auth-pool.mjs';
import { createStore } from '../../auth/store.mjs';
import { createAuthService } from '../../auth/service.mjs';
import { createAuthServer } from '../../auth/http.mjs';

if (process.env.AUTH_BROWSER_QA !== '1') throw new Error('Explicit AUTH_BROWSER_QA=1 required');
const port = Number(process.env.AUTH_BROWSER_QA_PORT || 5198), origin = `http://localhost:${port}`;
const database = await testPool();
const store = createStore(database.pool, { secret: 'synthetic-qa-secret-not-for-production' });
const failures = new Set(), users = new Map();
const service = createAuthService({ store, makeCode: () => '123456', sendMail: async () => {},
  ensureGetCourse: async email => {
    if (email.startsWith('offline') && !failures.has(email)) { failures.add(email); throw new Error('synthetic outage'); }
    if (!users.has(email)) users.set(email, String(2001 + users.size));
    return users.get(email);
  } });
const api = createAuthServer({ service, store, origin, enabled: true });
const front = path.resolve(fileURLToPath(new URL('../../../Фронт/', import.meta.url)));
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/api/auth/')) { api.emit('request', request, response); return; }
  try {
    const name = decodeURIComponent(new URL(request.url, origin).pathname);
    const file = path.resolve(front, '.' + (name === '/' ? '/login.html' : name));
    if (!file.startsWith(front + path.sep) || !contentTypes[path.extname(file)]) throw new Error();
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)], 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic auth QA: ${origin}/login.html`));
async function stop() { await new Promise(resolve => server.close(resolve)); await database.close(); }
process.on('SIGINT', () => stop().then(() => process.exit(0)));
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
