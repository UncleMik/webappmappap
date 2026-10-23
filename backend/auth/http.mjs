import { createServer } from 'node:http';
import { AuthError, normalizeEmail, readSessionCookie, sessionCookie } from './security.mjs';
import { weeklyVideoSource } from './weekly-videos.mjs';

async function readJson(request) {
  if ((request.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    throw new AuthError(415, 'json_required', 'Нужен запрос JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new AuthError(413, 'body_too_large', 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new AuthError(400, 'invalid_json', 'Проверьте введённые данные.'); }
}
function challenge(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AuthError(400, 'invalid_challenge', 'Запросите новый код.');
  }
  return value;
}

export function createAuthServer({ service, store, courseChecks, origin, enabled = false, trustProxy = false, mailPerMinute = 120 }) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status, body, headers = {}) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...headers,
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (!enabled) throw new AuthError(503, 'auth_unavailable', 'Вход ещё не подключён. Попробуйте позже.');
      const url = new URL(request.url, origin);
      if (url.search) throw new AuthError(400, 'invalid_url', 'Неверный запрос.');
      if (request.method === 'GET' && url.pathname === '/api/auth/check') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        send(204); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        const user = await service.session(readSessionCookie(request));
        send(200, { authenticated: Boolean(user), user }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/course-check') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы проверить доступ к курсам.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        if (!courseChecks) throw new AuthError(503, 'course_check_unavailable', 'Не удалось проверить доступ к курсам. Попробуйте ещё раз.', 5);
        const { checkedAt, expiresAt } = await courseChecks.requireCurrent(user.id);
        send(200, { verification: 'current', checkedAt, expiresAt }); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/auth/videos/')) {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть бесплатное видео.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        const source = weeklyVideoSource(url.pathname.slice('/api/auth/videos/'.length));
        if (!source) { send(404, { error: 'video_not_found', message: 'Видео не найдено.' }); return; }
        send(200, { source }); return;
      }
      if (request.method !== 'POST') { send(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' }); return; }
      // Same-origin only. In particular, GitHub Pages cannot create school sessions.
      if (request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
        throw new AuthError(403, 'origin_rejected', 'Откройте вход на сайте приложения.');
      }
      const data = await readJson(request);
      const peer = request.socket.remoteAddress;
      const proxy = trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const ip = proxy ? String(request.headers['x-real-ip'] || peer) : peer;
      await store.rateLimit('request_ip', ip, 600);
      if (url.pathname === '/api/auth/profile') {
        const user = await service.saveProfile(readSessionCookie(request), data);
        send(200, { authenticated: true, user }); return;
      }
      if (url.pathname === '/api/auth/request') {
        const email = normalizeEmail(data.email);
        await store.rateLimit('mail_ip', ip, 120);
        await store.rateLimit('mail_global', 'all', mailPerMinute);
        send(200, await service.request(email)); return;
      }
      if (url.pathname === '/api/auth/verify' || url.pathname === '/api/auth/complete') {
        const token = challenge(data.challenge);
        if (url.pathname.endsWith('/verify') && (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code))) {
          throw new AuthError(400, 'invalid_code_format', 'Введите шесть цифр из письма.');
        }
        const result = url.pathname.endsWith('/verify') ? await service.verify(token, data.code) : await service.complete(token);
        send(200, { authenticated: true, user: result.user }, { 'Set-Cookie': sessionCookie(result.sessionToken) }); return;
      }
      if (url.pathname === '/api/auth/logout') {
        await service.logout(readSessionCookie(request));
        send(200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', true) }); return;
      }
      send(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof AuthError) {
        send(error.status, { error: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) },
          error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      } else {
        // Do not log raw SQL/provider errors, submitted codes, cookies or email.
        console.error('auth_request_failed');
        send(503, { error: 'auth_unavailable', message: 'Вход временно недоступен. Попробуйте позже.' });
      }
    }
  });
}
