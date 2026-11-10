import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthError, isUuid, normalizeEmail, readSessionCookie, sessionCookie } from './security.mjs';

const assets = new Map([
  ['/admin/ui.css', ['ui.css', 'text/css; charset=utf-8']],
  ['/admin/panel.js', ['panel.js', 'application/javascript; charset=utf-8']],
  ['/admin/login.js', ['login.js', 'application/javascript; charset=utf-8']],
]);
const panelType = 'text/html; charset=utf-8';
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const denied = () => new AuthError(403, 'admin_forbidden', 'У этого аккаунта нет доступа к админке.');

export async function createAdminHttp({ admin, service, store, origin, frontend, uploads, mailPerMinute }) {
  const host = new URL(origin).host;
  const files = new Map();
  for (const [key, [file, type]] of [...assets, ['/admin/login', ['login.html', panelType]], ['/admin', ['index.html', panelType]]]) {
    files.set(key, { bytes: await readFile(join(frontend, file)), type });
  }

  return async function adminHttp(request, response, url, send, readJson) {
    const path = url.pathname, method = request.method;
    if (request.headers.host !== host) { send(404, { error: 'not_found' }); return; }
    if (url.search) throw new AuthError(400, 'invalid_url', 'Неверный запрос.');
    const token = readSessionCookie(request);
    const expected = request.headers['x-webpril-account'];
    const fileResponse = ({ bytes, type }) => {
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer' });
      response.end(method === 'HEAD' ? undefined : bytes);
    };
    const redirect = location => {
      response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      response.end();
    };
    if (method === 'GET' || method === 'HEAD') {
      if (path === '/admin/' || path === '/admin') {
        try { await admin.session(token); }
        catch (error) {
          if (error instanceof AuthError && [401, 403].includes(error.status)) {
            redirect(error.status === 401 ? '/admin/login' : '/admin/login#access'); return;
          }
          throw error;
        }
        fileResponse(files.get('/admin')); return;
      }
      if (path === '/admin/login' || assets.has(path)) { fileResponse(files.get(path)); return; }
      const cover = path.match(/^\/admin\/cover\/([a-z0-9-]+\.webp)$/);
      if (cover) {
        await admin.session(token);
        const bytes = await readFile(join(uploads, cover[1])).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!bytes) { send(404, { error: 'not_found' }); return; }
        fileResponse({ bytes, type: 'image/webp' }); return;
      }
    }
    const article = path.match(/^\/api\/admin\/articles\/(pregnancy-\d{3})(\/visibility)?$/);
    if (method === 'GET') {
      if (path === '/api/admin/session') { send(200, await admin.session(token, expected)); return; }
      if (path === '/api/admin/articles') { send(200, await admin.articles(token, expected)); return; }
      if (article && !article[2]) { send(200, await admin.article(token, expected, article[1])); return; }
      if (path === '/api/admin/announcements') { send(200, await admin.announcements(token, expected)); return; }
      if (path === '/api/admin/polls') { send(200, await admin.polls(token, expected)); return; }
      if (path === '/api/admin/staff') { send(200, await admin.staff(token, expected)); return; }
      if (path === '/api/admin/history') { send(200, await admin.history(token, expected)); return; }
    }
    if (method !== 'POST' || !path.startsWith('/api/admin/')) { send(404, { error: 'not_found' }); return; }
    if (request.headers.origin !== origin) throw new AuthError(403, 'origin_denied', 'Обновите страницу и повторите действие.');
    const ip = request.headers['x-real-ip'] || request.socket.remoteAddress;
    if (path === '/api/admin/request') {
      const data = await readJson(request);
      const email = normalizeEmail(data.email);
      await store.rateLimit('admin_request_ip', ip, 60);
      if (!await admin.allowedEmail(email)) throw denied();
      await store.rateLimit('mail_ip', ip, 120);
      await store.rateLimit('mail_global', 'all', mailPerMinute);
      send(200, await service.request(email)); return;
    }
    if (path === '/api/admin/verify') {
      const data = await readJson(request);
      await store.rateLimit('admin_request_ip', ip, 60);
      if (typeof data.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.challenge) ||
          typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) {
        throw new AuthError(400, 'invalid_code', 'Введите шесть цифр из письма.');
      }
      if (!await admin.allowedChallenge(data.challenge)) {
        throw new AuthError(400, 'invalid_code', 'Запросите новый код.');
      }
      const result = await service.verify(data.challenge, data.code);
      try { await admin.session(result.sessionToken); }
      catch (error) { await service.logout(result.sessionToken); throw error; }
      send(200, { authenticated: true }, { 'Set-Cookie': sessionCookie(result.sessionToken) }); return;
    }
    if (path === '/api/admin/logout') {
      await readJson(request);
      await service.logout(token);
      send(200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', true) }); return;
    }
    await admin.session(token, expected);
    const data = await readJson(request, path === '/api/admin/articles' || article && !article[2] ? 900_000 : 20_000);
    if (path === '/api/admin/articles' || article && !article[2]) {
      send(200, await admin.publishArticle(token, expected, article?.[1] ?? null, data)); return;
    }
    if (article?.[2]) { send(200, await admin.articleVisibility(token, expected, article[1], data)); return; }
    if (path === '/api/admin/announcements') { send(200, await admin.publishAnnouncement(token, expected, data)); return; }
    const announcement = path.match(/^\/api\/admin\/announcements\/([^/]+)\/hide$/);
    if (announcement && isUuid(announcement[1])) {
      await admin.hideAnnouncement(token, expected, announcement[1]); send(200, { hidden: true }); return;
    }
    if (path === '/api/admin/polls') { send(200, await admin.schedulePoll(token, expected, data)); return; }
    if (path === '/api/admin/staff') { send(200, await admin.setStaff(token, expected, data)); return; }
    send(404, { error: 'not_found' });
  };
}
