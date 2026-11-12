import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AuthError, normalizeEmail, readSessionCookie, sessionCookie } from './security.mjs';
import { createWeeklyMedia, weeklyVideoPosition } from './weekly-videos.mjs';
import { MAX_AI_BODY_BYTES } from './ai-attachment.mjs';
import { MAX_AI_VOICE_BODY_BYTES } from './ai-voice.mjs';
import { isPointsCursor } from './points.mjs';

const introPortraits = [
  ['yulia.png', 'Юлия Сулейманова'],
  ['svetlana.png', 'Светлана Курканина'],
  ['anastasia.png', 'Анастасия Сафина'],
  ['lyubov.png', 'Любовь Климова'],
  ['ekaterina.png', 'Екатерина Новикова'],
];

async function lessonImages(lessonId, blocks) {
  if (lessonId === 347472347) {
    return introPortraits.map(([file, alt]) => ({
      file, alt,
      block: blocks.find(block => block.type === 'text' && block.text.trim().split('\n', 1)[0].trim() === alt),
    }));
  }
  const directory = new URL(`../../data/course-materials/${lessonId}/`, import.meta.url);
  const manifest = await readFile(new URL('images.json', directory), 'utf8')
    .catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (manifest === null) return [];
  let files;
  try { files = JSON.parse(manifest); }
  catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  const imageBlocks = blocks.filter(block => block.type === 'image');
  if (!Array.isArray(files) || files.length !== imageBlocks.length
    || !files.every((file, index) => typeof file === 'string'
      && new RegExp(`^${index + 1}[.](png|jpe?g|webp)$`).test(file))) return [];
  return files.map((file, index) => ({ file, block: imageBlocks[index] }));
}

async function readJson(request, maxSize = 4096, aiAttachment = false) {
  if ((request.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    throw new AuthError(415, 'json_required', 'Нужен запрос JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new AuthError(413, 'body_too_large', 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    if (aiAttachment && value.attachment === undefined && size > 16_000)
      throw new AuthError(413, 'body_too_large', 'Слишком большой запрос.');
    return value;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(400, 'invalid_json', 'Проверьте введённые данные.');
  }
}
function challenge(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AuthError(400, 'invalid_challenge', 'Запросите новый код.');
  }
  return value;
}
const positiveId = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
function limitQuota(error) {
  const q = error.code === 'ai_daily_limit' && error.quota;
  if (!q || !Number.isInteger(q.limit) || q.limit < 0 || q.limit > 30 || !Number.isInteger(q.used) || q.used < 0 || q.used > 30
    || q.remaining !== Math.max(0, q.limit - q.used)
    || typeof q.resetsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(q.resetsAt)) return {};
  const serverTime = typeof q.serverTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(q.serverTime)
    && Number.isFinite(Date.parse(q.serverTime)) ? { serverTime: q.serverTime } : {};
  const extra = {};
  for (const key of ['freeRemaining', 'paidRemaining', 'paidDailyRemaining', 'paidUsed', 'totalRemaining', 'maximum'])
    if (Number.isSafeInteger(q[key]) && q[key] >= 0) extra[key] = q[key];
  return { quota: { limit: q.limit, used: q.used, remaining: q.remaining, resetsAt: q.resetsAt, ...serverTime, ...extra } };
}
const materialsUnavailable = () => new AuthError(503, 'course_materials_unavailable',
  'Материалы курсов временно недоступны. Попробуйте ещё раз.');

export function createAuthServer({ service, store, courseChecks, courseMaterials, personalData, profilePhoto, clubChat, aiChat, points, weeklyPoll, stars, starsAccess, gamification, gamificationNotifications, adminHttp, admin, origin, enabled = false, trustProxy = false, mailPerMinute = 120, weeklyMedia = createWeeklyMedia() }) {
  let largeAiInFlight = false;
  async function requireAccount(token, expected) {
    const user = await service.session(token);
    if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
    if (typeof expected !== 'string' || expected.toLowerCase() !== user.id.toLowerCase())
      throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
    return user;
  }

  return createServer({ requestTimeout: 90_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    let ownsLargeSlot = false;
    const isAiSend = request.method === 'POST' && request.url === '/api/auth/ai/messages';
    const isAiVoice = request.method === 'POST' && request.url === '/api/auth/ai/voice';
    // Bound receive time separately from the subsequent 65-second model call.
    const receiveTimer = setTimeout(() => request.destroy(), isAiSend || isAiVoice ? 90_000 : 15_000);
    receiveTimer.unref();
    const clearReceiveTimer = () => clearTimeout(receiveTimer);
    request.once('end', clearReceiveTimer);
    request.once('close', clearReceiveTimer);
    let isPoints = false;
    const send = (status, body, headers = {}) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': isPoints ? 'private, no-store' : 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
          ...(!request.complete ? { Connection: 'close' } : {}), ...headers,
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (!enabled) throw new AuthError(503, 'auth_unavailable', 'Вход ещё не подключён. Попробуйте позже.');
      const url = new URL(request.url, origin);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
        if (adminHttp) await adminHttp(request, response, url, send, readJson);
        else send(404, { error: 'not_found' });
        return;
      }
      const pointsRead = request.method === 'GET' && url.pathname === '/api/auth/points';
      const articleReading = request.method === 'POST' && url.pathname === '/api/auth/points/articles';
      const videoWatching = request.method === 'POST' && url.pathname === '/api/auth/points/videos';
      isPoints = pointsRead || articleReading || videoWatching;
      const photoVersion = url.pathname === '/api/auth/profile-photo' && request.method === 'GET' &&
        url.searchParams.size === 1 && /^[0-9a-f-]{36}$/i.test(url.searchParams.get('v') || '')
        ? url.searchParams.get('v') : null;
      const clubRoomQuery = (url.pathname === '/api/auth/club' || url.pathname.startsWith('/api/auth/club/')) && url.searchParams.size === 1 && url.searchParams.has('room');
      const clubRoom = clubRoomQuery ? url.searchParams.get('room') : undefined;
      const mediaAccount = ['GET', 'HEAD'].includes(request.method) && /^\/api\/auth\/videos\/[a-z0-9-]+\/(?:file|cover)$/.test(url.pathname)
        && url.searchParams.size === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.searchParams.get('account') || '')
        ? url.searchParams.get('account') : null;
      const pointsBefore = pointsRead && url.searchParams.size === 1 && url.searchParams.get('before');
      if (url.search && !mediaAccount && !photoVersion && !clubRoomQuery && !isPointsCursor(pointsBefore)) throw new AuthError(400, 'invalid_url', 'Неверный запрос.');
      if (request.method === 'GET' && url.pathname === '/api/auth/check') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        send(204); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/internal/weekly-access') {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress))
          throw new AuthError(403, 'access_denied', 'Доступ закрыт.');
        const token = readSessionCookie(request), expected = request.headers['x-webpril-account'];
        const user = await requireAccount(token, expected);
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль.');
        const policy = starsAccess ? await starsAccess.context(token, expected)
          : { accountId: user.id, currentWeek: 0, legacy: true, enforced: false, purchasedWeeks: [], preservedWeeks: [] };
        const { accountId, currentWeek, legacy, enforced, purchasedWeeks, preservedWeeks } = policy;
        send(200, { accountId, currentWeek, legacy, enforced, purchasedWeeks, preservedWeeks }); return;
      }
      const newReads = {
        '/api/auth/stars': [stars, 'state'],
        '/api/auth/gamification': [gamification, 'state'],
        '/api/auth/gamification/letters': [gamification, 'letters'],
        '/api/auth/notifications': [gamificationNotifications, 'list'],
        '/api/auth/notifications/preferences': [gamificationNotifications, 'preferences'],
      };
      if (request.method === 'GET' && Object.hasOwn(newReads, url.pathname)) {
        const [module, method] = newReads[url.pathname];
        const token = readSessionCookie(request), expected = request.headers['x-webpril-account'];
        await requireAccount(token, expected);
        if (!module?.[method]) throw new AuthError(503, 'gamification_unavailable', 'Возможность временно недоступна.');
        send(200, await module[method](token, expected)); return;
      }
      if (pointsRead) {
        if (!points) throw new AuthError(503, 'points_unavailable', 'Баллы временно недоступны.');
        send(200, await points.read(readSessionCookie(request), request.headers['x-webpril-account'], pointsBefore || undefined)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        send(200, await service.sessionState(readSessionCookie(request))); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/announcements') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        if (!admin) throw new AuthError(503, 'announcements_unavailable', 'Объявления временно недоступны.');
        send(200, await admin.publicAnnouncements(user, request.headers['x-webpril-account'])); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/ai/conversations') {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        send(200, await aiChat.conversations(readSessionCookie(request), request.headers['x-webpril-account'])); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/ai/history') {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        send(200, await aiChat.history(readSessionCookie(request), request.headers['x-webpril-account'])); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/ai/quota') {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        send(200, await aiChat.readQuota(readSessionCookie(request), request.headers['x-webpril-account'])); return;
      }
      if (request.method === 'GET' && (url.pathname === '/api/auth/club' || url.pathname.startsWith('/api/auth/club/messages') || url.pathname.startsWith('/api/auth/club/changes'))) {
        if (!clubChat) throw new AuthError(503, 'club_unavailable', 'Чат временно недоступен.');
        const expected = request.headers['x-webpril-account'];
        if (url.pathname === '/api/auth/club') {
          send(200, await clubChat.info(readSessionCookie(request), expected, clubRoom)); return;
        }
        const screenshot = url.pathname.match(/^\/api\/auth\/club\/messages\/([1-9]\d{0,18})\/screenshot$/);
        if (screenshot) {
          const bytes = await clubChat.screenshot(readSessionCookie(request), screenshot[1], clubRoom);
          response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length,
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          response.end(bytes); return;
        }
        if (request.headers['x-webpril-chat-version'] !== '2') {
          if (!await service.session(readSessionCookie(request))) throw new AuthError(401,'sign_in_required','Войдите в аккаунт.');
          throw new AuthError(409, 'chat_update_required', 'Чат обновлён. Обновите страницу.');
        }
        const changes = url.pathname.match(/^\/api\/auth\/club\/changes\/after\/(0|[1-9]\d{0,18})$/);
        if (changes) { send(200, await clubChat.changes(readSessionCookie(request), expected, changes[1], clubRoom)); return; }
        const around = url.pathname.match(/^\/api\/auth\/club\/messages\/around\/([1-9]\d{0,18})$/);
        if (around) { send(200, await clubChat.around(readSessionCookie(request), expected, around[1], clubRoom)); return; }
        const cursor = url.pathname.match(/^\/api\/auth\/club\/messages\/(before|after)\/(0|[1-9]\d{0,18})$/);
        if (url.pathname !== '/api/auth/club/messages' && !cursor) { send(404, { error: 'not_found' }); return; }
        send(200, await clubChat.messages(readSessionCookie(request), expected, cursor?.[1], cursor?.[2], clubRoom)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/profile-photo') {
        if (!profilePhoto) throw new AuthError(503, 'photo_unavailable', 'Фото временно недоступно.');
        const bytes = await profilePhoto.read(readSessionCookie(request), photoVersion);
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length,
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end(bytes); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/weekly-poll' && weeklyPoll) {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        send(200, await weeklyPoll.read(user.id)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/personal') {
        if (!personalData) throw new AuthError(503, 'personal_data_unavailable', 'Личные данные временно недоступны.');
        send(200, await personalData.read(readSessionCookie(request))); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/course-check') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы проверить доступ к курсам.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        if (!courseChecks) throw new AuthError(503, 'course_check_unavailable', 'Не удалось проверить доступ к курсам. Попробуйте ещё раз.', 5);
        const { checkedAt, expiresAt } = await courseChecks.requireCurrent(user.id);
        send(200, { verification: 'current', checkedAt, expiresAt }); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/auth/course-programs/')) {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть программу.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        const productId = url.pathname.slice('/api/auth/course-programs/'.length);
        if (!positiveId(productId)) { send(404, { error: 'not_found' }); return; }
        if (!courseChecks || !courseMaterials?.program) throw materialsUnavailable();
        try { send(200, await courseMaterials.program(user.id, Number(productId))); return; }
        catch (error) {
          if (error instanceof AuthError) throw error;
          throw materialsUnavailable();
        }
      }
      if (request.method === 'GET' && (url.pathname === '/api/auth/courses' || url.pathname.startsWith('/api/auth/courses/'))) {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть курсы.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        const path = url.pathname.slice('/api/auth/courses'.length);
        const course = path.match(/^\/([1-9]\d*)$/);
        const lesson = path.match(/^\/([1-9]\d*)\/lessons\/([1-9]\d*)(?:\/images\/([1-9]\d*))?$/);
        const match = course || lesson;
        if (path && (!match || !positiveId(match[1]) || (lesson && !positiveId(lesson[2])))) {
          send(404, { error: 'not_found' }); return;
        }
        if (!courseChecks || !courseMaterials) throw materialsUnavailable();
        try {
          const result = lesson ? await courseMaterials.lesson(user.id, Number(lesson[1]), Number(lesson[2]))
            : course ? await courseMaterials.course(user.id, Number(course[1])) : await courseMaterials.list(user.id);
          if (lesson) {
            const blocks = result.lesson.blocks;
            const images = await lessonImages(Number(lesson[2]), blocks);
            if (lesson[3]) {
              const image = images[Number(lesson[3]) - 1];
              if (!image?.block) { send(404, { error: 'not_found' }); return; }
              const { file } = image;
              const bytes = await readFile(new URL(`../../data/course-materials/${lesson[2]}/${file}`, import.meta.url))
                .catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
              if (!bytes) { send(404, { error: 'not_found' }); return; }
              response.writeHead(200, {
                'Content-Type': file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
                'Content-Length': bytes.length, 'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
              });
              response.end(bytes); return;
            }
            const byBlock = new Map();
            images.forEach(({ block, alt }, index) => {
              if (block) byBlock.set(block, {
                imageUrl: `/api/auth/courses${path}/images/${index + 1}`,
                ...(alt ? { imageAlt: alt } : {}),
              });
            });
            if (byBlock.size) {
              send(200, { ...result, lesson: { ...result.lesson, blocks: blocks.map(block => byBlock.has(block)
                ? { ...block, ...byBlock.get(block) } : block) } });
              return;
            }
          }
          send(200, result); return;
        } catch (error) {
          if (error instanceof AuthError) throw error;
          throw materialsUnavailable();
        }
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/api/auth/videos/')) {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть бесплатное видео.');
        if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        const match = /^\/api\/auth\/videos\/([a-z0-9-]+)(?:\/(file|cover))?$/.exec(url.pathname);
        const position = match && weeklyVideoPosition(match[1]);
        if (!position) { send(404, { error: 'video_not_found', message: 'Видео не найдено.' }); return; }
        if (starsAccess) {
          // Native src/poster cannot send headers. The UUID only binds the
          // expected account; it never substitutes for the live session.
          const expected = request.headers['x-webpril-account'] || mediaAccount;
          const access = await starsAccess.context(readSessionCookie(request), expected);
          starsAccess.assertWeek(access, starsAccess.videoWeek(position));
        }
        if (mediaAccount && mediaAccount.toLowerCase() !== user.id.toLowerCase())
          throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        if (match[2]) await weeklyMedia(request, response, position, match[2]);
        else send(200, { source: '/api/auth/videos/' + match[1] + '/file?account=' + user.id,
          cover: '/api/auth/videos/' + match[1] + '/cover?account=' + user.id });
        return;
      }
      if (request.method !== 'POST') { send(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' }); return; }
      // Same-origin only. In particular, GitHub Pages cannot create school sessions.
      if (request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
        throw new AuthError(403, 'origin_rejected', 'Откройте вход на сайте приложения.');
      }
      if (isAiSend || isAiVoice) {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        const length = request.headers['content-length'];
        if (isAiVoice) await aiChat.authorizeVoice(readSessionCookie(request), request.headers['x-webpril-account']);
        if (length === undefined || Number(length) > 16_000) {
          if (largeAiInFlight) throw new AuthError(503, 'ai_upload_busy', 'Лара обрабатывает другой файл. Попробуйте немного позже.');
          largeAiInFlight = true; ownsLargeSlot = true;
          if (!isAiVoice) await aiChat.authorize(readSessionCookie(request), request.headers['x-webpril-account']);
          if (Number(length) > (isAiVoice ? MAX_AI_VOICE_BODY_BYTES : MAX_AI_BODY_BYTES)) throw new AuthError(413, 'body_too_large', 'Слишком большой запрос.');
        }
      }
      const data = await readJson(request, isAiVoice ? MAX_AI_VOICE_BODY_BYTES : isAiSend ? MAX_AI_BODY_BYTES : url.pathname === '/api/auth/personal' ? 1_000_000
        : url.pathname === '/api/auth/gamification/actions' ? 16000
        : url.pathname === '/api/auth/profile-photo' ? 512_000
          : url.pathname === '/api/auth/club/messages' ? 512_000 : 4096, isAiSend);
      const peer = request.socket.remoteAddress;
      const proxy = trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const ip = proxy ? String(request.headers['x-real-ip'] || peer) : peer;
      await store.rateLimit('request_ip', ip, 600);
      const newWrites = {
        '/api/auth/stars/purchase': [stars, 'purchase'],
        '/api/auth/stars/course-video': [stars, 'courseVideoWatching'],
        '/api/auth/gamification/actions': [gamification, 'action'],
        '/api/auth/gamification/preferences': [gamification, 'preferences'],
        '/api/auth/notifications/read': [gamificationNotifications, 'read'],
        '/api/auth/notifications/preferences': [gamificationNotifications, 'preferences'],
        '/api/auth/notifications/subscribe': [gamificationNotifications, 'subscribe'],
        '/api/auth/notifications/unsubscribe': [gamificationNotifications, 'unsubscribe'],
        '/api/auth/notifications/visit': [gamificationNotifications, 'visit'],
        '/api/auth/notifications/presentation': [gamificationNotifications, 'claimPresentation'],
      };
      if (Object.hasOwn(newWrites, url.pathname)) {
        const [module, method] = newWrites[url.pathname];
        const token = readSessionCookie(request), expected = request.headers['x-webpril-account'];
        await requireAccount(token, expected);
        if (!module?.[method]) throw new AuthError(503, 'gamification_unavailable', 'Возможность временно недоступна.');
        send(200, await module[method](token, expected, data)); return;
      }
      if (articleReading || videoWatching) {
        if (!points) throw new AuthError(503, 'points_unavailable', 'Баллы временно недоступны.');
        send(200, await points[videoWatching ? 'videoWatching' : 'articleReading'](readSessionCookie(request), request.headers['x-webpril-account'], data)); return;
      }
      if (isAiVoice) {
        send(200, await aiChat.transcribe(readSessionCookie(request), request.headers['x-webpril-account'], data,
          userId => store.rateLimit('ai_voice_user', userId, 6))); return;
      }
      if (url.pathname === '/api/auth/ai/conversations' || url.pathname === '/api/auth/ai/conversations/read') {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        const token = readSessionCookie(request), expected = request.headers['x-webpril-account'];
        send(200, url.pathname.endsWith('/read') ? await aiChat.conversations(token, expected, data.before)
          : await aiChat.createConversation(token, expected, data)); return;
      }
      if (url.pathname === '/api/auth/ai/history/read' || url.pathname === '/api/auth/ai/messages' || url.pathname === '/api/auth/ai/messages/status') {
        if (!aiChat) throw new AuthError(503, 'ai_unavailable', 'Лара временно недоступна.');
        const token = readSessionCookie(request), expected = request.headers['x-webpril-account'];
        send(200, url.pathname.endsWith('/read') ? await aiChat.history(token, expected, data.before, data.conversationId)
          : url.pathname.endsWith('/status') ? await aiChat.status(token, expected, data)
            : await aiChat.send(token, expected, data)); return;
      }
      if (url.pathname === '/api/auth/club/read' || url.pathname === '/api/auth/club/search') {
        if (!clubChat) throw new AuthError(503, 'club_unavailable', 'Чат временно недоступен.');
        if (request.headers['x-webpril-chat-version'] !== '2') {
          if (!await service.session(readSessionCookie(request))) throw new AuthError(401,'sign_in_required','Войдите в аккаунт.');
          throw new AuthError(409, 'chat_update_required', 'Чат обновлён. Обновите страницу.');
        }
        const action = url.pathname.endsWith('/read') ? 'markRead' : 'search';
        send(200, await clubChat[action](readSessionCookie(request), request.headers['x-webpril-account'], data, clubRoom)); return;
      }
      if (url.pathname === '/api/auth/club/reactions' || url.pathname === '/api/auth/club/reactions/read') {
        if (!clubChat) throw new AuthError(503, 'club_unavailable', 'Чат временно недоступен.');
        const action = url.pathname.endsWith('/read') ? 'reactions' : 'react';
        send(200, await clubChat[action](readSessionCookie(request), request.headers['x-webpril-account'], data, clubRoom)); return;
      }
      const deleteMessage = url.pathname.match(/^\/api\/auth\/club\/messages\/([1-9]\d{0,18})\/delete$/);
      if (url.pathname === '/api/auth/club/messages' || deleteMessage) {
        if (!clubChat) throw new AuthError(503, 'club_unavailable', 'Чат временно недоступен.');
        if (request.headers['x-webpril-chat-version'] !== '2') {
          if (!await service.session(readSessionCookie(request))) throw new AuthError(401,'sign_in_required','Войдите в аккаунт.');
          throw new AuthError(409, 'chat_update_required', 'Чат обновлён. Обновите страницу.');
        }
        if (deleteMessage) {
          send(200, await clubChat.deleteMessage(readSessionCookie(request), request.headers['x-webpril-account'], deleteMessage[1], data, clubRoom)); return;
        }
        send(200, await clubChat.send(readSessionCookie(request), request.headers['x-webpril-account'], data, clubRoom)); return;
      }
      if (url.pathname === '/api/auth/weekly-poll' && weeklyPoll) {
        send(200, await weeklyPoll.vote(readSessionCookie(request), request.headers['x-webpril-account'], data)); return;
      }
      if (url.pathname === '/api/auth/personal') {
        if (!personalData) throw new AuthError(503, 'personal_data_unavailable', 'Личные данные временно недоступны.');
        const expectedAccountId = request.headers['x-webpril-account'];
        if (typeof expectedAccountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedAccountId)) {
          throw new AuthError(400, 'account_required', 'Обновите страницу и повторите действие.');
        }
        send(200, await personalData.write(readSessionCookie(request), data, expectedAccountId)); return;
      }
      if (url.pathname === '/api/auth/profile') {
        const user = await service.saveProfile(readSessionCookie(request), data);
        send(200, { authenticated: true, user }); return;
      }
      if (url.pathname === '/api/auth/profile-edit') {
        const user = await service.editProfile(readSessionCookie(request), data);
        send(200, { authenticated: true, user }); return;
      }
      if (url.pathname === '/api/auth/profile-photo') {
        if (!profilePhoto) throw new AuthError(503, 'photo_unavailable', 'Фото временно недоступно.');
        const user = await profilePhoto.write(readSessionCookie(request), data);
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
        send(error.status, { error: error.code, message: error.message, ...limitQuota(error), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) },
          error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      } else {
        // Do not log raw SQL/provider errors, submitted codes, cookies or email.
        console.error('auth_request_failed');
        send(503, { error: 'auth_unavailable', message: 'Вход временно недоступен. Попробуйте позже.' });
      }
    } finally {
      if (ownsLargeSlot) largeAiInFlight = false;
      clearReceiveTimer();
    }
  });
}
