import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';
import { validateAiAttachment, MAX_AI_BODY_BYTES } from './ai-attachment.mjs';
import { createAiVoice } from './ai-voice.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AuthError(503, 'ai_unavailable', 'Лара временно недоступна. Попробуйте позже.');
const changed = () => new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
const signedOut = () => new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
const noPurchase = () => new AuthError(403, 'ai_purchase_required', 'Лара доступна при действующей покупке курса.');
const MAX_QUESTION = 4000;
const DAILY_LIMIT = 30;
const RETENTION_MS = 90 * 86_400_000;
const IN_FLIGHT_MS = 70_000;
const MODEL_HISTORY_CHARS = 20_000;
const MAX_REPLY_BYTES = 128 * 1024;

function day(now) { return new Date(now + 3 * 3_600_000).toISOString().slice(0, 10); }
function reset(dayValue) { return new Date(Date.parse(`${dayValue}T00:00:00Z`) + 21 * 3_600_000).toISOString(); }
function sourceMap(path) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  if (map?.version !== 1 || !Array.isArray(map.sources) || !map.sources.every(s =>
    s && typeof s.course === 'string' && typeof s.source === 'string' && Array.isArray(s.lessonIds)
    && s.lessonIds.length > 0 && s.lessonIds.every(n => Number.isSafeInteger(n) && n > 0))
    || (map.lessonUrls !== undefined && (!Array.isArray(map.lessonUrls) || !map.lessonUrls.every(l =>
      l && Number.isSafeInteger(l.lessonId) && l.lessonId > 0 && Array.isArray(l.urls)
      && l.urls.every(u => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)))))) throw unavailable();
  return map;
}
const lessonUrl = l => `/article.html?courseLesson=${l.lessonId}&course=${l.productId}&section=${l.sectionId}`;
const words = value => [...new Set((value.toLocaleLowerCase('ru').match(/[\p{L}\p{N}]{3,}/gu) || []))];
function relevantSources(question, lessons) {
  const terms = words(question).filter(w => !new Set(['как', 'что', 'мне', 'для', 'при', 'это', 'или', 'можно', 'если', 'почему']).has(w));
  if (!terms.length) return [];
  const ranked = lessons.filter(l => l.text).map(l => {
    const title = l.title.toLocaleLowerCase('ru'), body = l.text.toLocaleLowerCase('ru');
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
    const at = Math.min(...terms.map(term => body.indexOf(term)).filter(n => n >= 0));
    return { l, score, at: Number.isFinite(at) ? at : 0 };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.l.lessonId - b.l.lessonId).slice(0, 4);
  return ranked.map(({ l, at }) => ({ id: String(l.lessonId), title: l.title,
    text: l.text.slice(Math.max(0, at - 500), Math.max(0, at - 500) + 4000), url: lessonUrl(l) }));
}
function profileFor(user, now) {
  const p = user.profile;
  if (p.stage === 'pregnancy') {
    const due = Date.parse(`${p.dueDate}T00:00:00Z`);
    if (!Number.isFinite(due)) throw unavailable();
    const days = Math.max(0, Math.min(300, Math.floor((now + 3 * 3_600_000 - due) / 86_400_000 + 280)));
    return { stage: 'pregnant', gestationalWeek: Math.floor(days / 7), gestationalDays: days };
  }
  if (p.stage === 'mother') {
    const born = Date.parse(`${p.birthDate}T00:00:00Z`);
    if (!Number.isFinite(born)) throw unavailable();
    const current = new Date(Date.parse(`${day(now)}T00:00:00Z`)), birth = new Date(born);
    if (born > +current) throw unavailable();
    let months = (current.getUTCFullYear() - birth.getUTCFullYear()) * 12 + current.getUTCMonth() - birth.getUTCMonth();
    if (current.getUTCDate() < birth.getUTCDate()) months--;
    return { stage: 'postpartum', childAgeMonths: Math.max(0, months) };
  }
  throw unavailable();
}
const format = row => ({ id: String(row.id), role: 'user', content: row.question, status: row.status,
  createdAt: new Date(row.accepted_at).toISOString(), requestId: row.request_id });
function messages(row) {
  const result = [format(row)];
  if (row.status === 'completed') result.push({ id: `${row.id}:answer`, role: 'assistant', content: row.answer,
    createdAt: new Date(row.accepted_at).toISOString(), requestId: row.request_id,
    sources: (Array.isArray(row.sources) ? row.sources : []).filter(source => source?.selection === 'answer')
      .slice(0, 3).map(({ id, title, url }) => ({ id, title, url })) });
  return result;
}
async function signedSession(pool, token, userId, clock) {
  return transaction(pool, async client => {
    const { rows: [row] } = await client.query(`SELECT s.user_id,s.expires_at,u.profile FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
      AND s.expires_at>$2 FOR SHARE OF s,u`, [hashToken(token), new Date(clock())]);
    if (!row) throw signedOut();
    if (row.user_id !== userId) throw changed();
    if (!row.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль.');
    return row;
  });
}

export function createAiChat({ pool, service, courseMaterials, sourceMapPath, url, secret, clock = Date.now, fetchImpl = fetch }) {
  let fileInFlight = false;
  if (!pool || !service || !courseMaterials || !sourceMapPath || !url || !secret) throw new Error('AI chat configuration incomplete');
  const endpoint = new URL(url);
  if (endpoint.origin !== 'https://admin.legkie-rody.ru' || endpoint.username || endpoint.password
    || endpoint.pathname !== '/internal/lara-web/reply' || endpoint.search || endpoint.hash
    || Buffer.byteLength(secret) < 32) throw new Error('Invalid AI chat endpoint or secret');
  async function access(token, expected) {
    const user = await service.session(token);
    if (!user) throw signedOut();
    if (!uuid(expected) || expected.toLowerCase() !== user.id.toLowerCase()) throw changed();
    if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль.');
    const ctx = await courseMaterials.aiContext(user.id);
    if (!ctx.courses.length) throw noPurchase();
    const map = sourceMap(sourceMapPath);
    const available = new Set(ctx.lessons.map(l => l.lessonId));
    const lessonById = new Map(ctx.lessons.map(l => [l.lessonId, l]));
    const sourceKeys = new Set();
    const allowedKnowledgeSources = [];
    for (const source of map.sources) {
      if (!source.lessonIds.every(id => available.has(id))) continue;
      const key = `${source.course}:${source.source}`;
      if (sourceKeys.has(key)) continue; // Alternative approved lesson sets are OR, not a combined AND.
      sourceKeys.add(key);
      const lesson = lessonById.get(source.lessonIds[0]);
      allowedKnowledgeSources.push({ course: source.course, source: source.source,
        // A folder-to-module match is not an exact transcript-to-lesson match.
        // Link to the owned course, rather than pretending its first lesson is
        // the source of this particular transcript.
        title: source.title || source.course, url: `/my-courses.html?course=${lesson.productId}` });
    }
    const gcUrls = new Map((map.lessonUrls || []).filter(row => available.has(row.lessonId))
      .map(row => [row.lessonId, row.urls]));
    const allowedLessons = [...lessonById.values()].map(l => ({ lessonId: l.lessonId, title: l.title,
      url: lessonUrl(l), gcUrls: gcUrls.get(l.lessonId) || [] }));
    const rightsHash = sha(JSON.stringify({ profile: [user.profile.stage, user.profile.dueDate, user.profile.birthDate],
      courses: ctx.courses.map(c => c.productId).sort(),
      lessons: ctx.lessons.map(l => [l.lessonId, l.sectionId, l.productId, l.contentHash]).sort((a, b) => a[0] - b[0]),
      sources: allowedKnowledgeSources.sort((a, b) => a.source.localeCompare(b.source)), mapHash: sha(JSON.stringify(map)) }));
    await signedSession(pool, token, user.id, clock);
    return { user, ctx, allowedKnowledgeSources, allowedLessons, rightsHash };
  }
  async function quota(userId) {
    const today = day(clock());
    const { rows: [row] } = await pool.query('SELECT used FROM ai_chat_daily_usage WHERE user_id=$1 AND day_moscow=$2', [userId, today]);
    const used = row?.used || 0;
    return { limit: DAILY_LIMIT, used, remaining: DAILY_LIMIT - used, resetsAt: reset(today) };
  }
  async function authorizeVoice(token, expected) {
    const a = await access(token, expected);
    if ((await quota(a.user.id)).remaining <= 0)
      throw new AuthError(429, 'ai_daily_limit', 'Сегодня доступные вопросы закончились. Возвращайтесь завтра.');
    return a;
  }
  const transcribe = createAiVoice({ authorize: authorizeVoice, secret, clock, fetchImpl,
    acquire() {
      if (fileInFlight) throw new AuthError(503, 'ai_voice_busy', 'Лара сейчас обрабатывает другой файл. Попробуйте позже.');
      fileInFlight = true;
      return () => { fileInFlight = false; };
    } });
  async function failStale(userId, client = pool) {
    await client.query(`UPDATE ai_chat_requests SET status='failed' WHERE user_id=$1
      AND status='pending' AND accepted_at<=$2`, [userId, new Date(clock() - IN_FLIGHT_MS)]);
  }
  async function history(token, expected, before) {
    const a = await access(token, expected);
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,18}$/.test(before)))
      throw new AuthError(400, 'invalid_cursor', 'Обновите историю.');
    await failStale(a.user.id);
    const cutoff = new Date(clock() - RETENTION_MS);
    const { rows } = await pool.query(`SELECT id,request_id,question,answer,sources,status,accepted_at FROM ai_chat_requests
      WHERE user_id=$1 AND accepted_at>=$2 AND ($3::bigint IS NULL OR id<$3::bigint)
      ORDER BY id DESC LIMIT 31`, [a.user.id, cutoff, before || null]);
    await access(token, expected);
    const page = rows.slice(0, 30);
    return { accountId: a.user.id, messages: page.reverse().flatMap(messages), hasMore: rows.length > 30,
      nextBefore: rows.length > 30 ? String(rows[29].id) : null, quota: await quota(a.user.id) };
  }
  async function status(token, expected, data) {
    if (!uuid(data?.requestId)) throw new AuthError(400, 'invalid_ai_message', 'Обновите страницу.');
    const a = await access(token, expected), requestId = data.requestId.toLowerCase();
    await failStale(a.user.id);
    const { rows: [row] } = await pool.query(`SELECT * FROM ai_chat_requests WHERE user_id=$1 AND request_id=$2
      AND accepted_at>=$3`, [a.user.id, requestId, new Date(clock() - RETENTION_MS)]);
    if (!row) throw new AuthError(404, 'ai_request_not_found', 'Вопрос не был принят. Можно отправить его снова.');
    const current = await access(token, expected);
    if (current.rightsHash !== row.rights_hash) throw new AuthError(409, 'ai_access_changed', 'Доступ к материалам изменился. Обновите страницу.');
    return { accountId: a.user.id, requestId, status: row.status, messages: messages(row), quota: await quota(a.user.id) };
  }
  async function send(token, expected, data) {
    const a = await access(token, expected);
    // Reserve before decoding, database acceptance and quota. Always release on failure.
    const hasFile = data?.attachment !== undefined;
    if (hasFile && fileInFlight) throw new AuthError(503, 'ai_upload_busy', 'Лара обрабатывает другой файл. Попробуйте немного позже.');
    if (hasFile) fileInFlight = true;
    try { return await sendAccepted(token, expected, data, a); }
    finally { if (hasFile) fileInFlight = false; }
  }
  async function sendAccepted(token, expected, data, a) {
    if (!uuid(data?.requestId) || typeof data.text !== 'string' || !data.text.trim()
      || [...data.text].length > MAX_QUESTION || /[\p{Cc}\p{Cf}]/u.test(data.text.replace(/[\n\r\t]/g, '')))
      throw new AuthError(400, 'invalid_ai_message', 'Введите вопрос до 4000 символов.');
    const file = validateAiAttachment(data.attachment);
    const text = data.text.trim(), requestId = data.requestId.toLowerCase();
    const question = file ? `${text}\n\nФайл анализа: ${file.attachment.name}` : text;
    const questionHash = file ? sha(JSON.stringify([question, file.attachment.mimeType, file.digest])) : sha(text);
    const today = day(clock());
    const existing = await transaction(pool, async client => {
      // Serialize request IDs and quota updates for this account, including concurrent retries.
      const { rows: [account] } = await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE', [a.user.id]);
      if (!account) throw signedOut();
      const { rows: [session] } = await client.query(`SELECT user_id FROM auth_sessions WHERE token_hash=$1
        AND revoked_at IS NULL AND expires_at>$2 FOR SHARE`, [hashToken(token), new Date(clock())]);
      if (!session || session.user_id !== a.user.id) throw signedOut();
      await failStale(a.user.id, client);
      const { rows: [old] } = await client.query('SELECT * FROM ai_chat_requests WHERE user_id=$1 AND request_id=$2', [a.user.id, requestId]);
      if (old) return old;
      const { rows: [busy] } = await client.query(`SELECT id FROM ai_chat_requests WHERE user_id=$1
        AND status='pending' AND accepted_at>$2 LIMIT 1`, [a.user.id, new Date(clock() - IN_FLIGHT_MS)]);
      if (busy) throw new AuthError(409, 'ai_busy', 'Лара отвечает на предыдущий вопрос. Подождите немного.');
      const { rows: [usage] } = await client.query(`INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used)
        VALUES($1,$2,1) ON CONFLICT(user_id,day_moscow) DO UPDATE SET used=ai_chat_daily_usage.used+1
        WHERE ai_chat_daily_usage.used<$3 RETURNING used`, [a.user.id, today, DAILY_LIMIT]);
      if (!usage) throw new AuthError(429, 'ai_daily_limit', 'Сегодня доступные вопросы закончились. Возвращайтесь завтра.');
      const { rows: [saved] } = await client.query(`INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status,accepted_at)
        VALUES($1,$2,$3,$4,$5,'pending',$6) RETURNING *`, [a.user.id, requestId, question, questionHash, a.rightsHash, new Date(clock())]);
      return { ...saved, newlyAccepted: true };
    });
    if (existing.question_hash !== questionHash) throw new AuthError(409, 'request_id_conflict', 'Обновите страницу и повторите вопрос.');
    if (existing.rights_hash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ к материалам изменился. Обновите страницу.');
    if (!existing.newlyAccepted) return { accountId: a.user.id, requestId, status: existing.status,
      messages: messages(existing), quota: await quota(a.user.id) };
    const { rows: prior } = await pool.query(`SELECT question,answer FROM ai_chat_requests WHERE user_id=$1 AND status='completed'
      AND rights_hash=$2 AND accepted_at>=$3 AND id<$4 ORDER BY id DESC LIMIT 10`,
    [a.user.id, a.rightsHash, new Date(clock() - RETENTION_MS), existing.id]);
    const latestPairs = [];
    let historyChars = 0;
    for (const row of prior) {
      const question = row.question.slice(0, 6000), answer = row.answer.slice(0, 6000);
      if (historyChars + question.length + answer.length > MODEL_HISTORY_CHARS) break;
      latestPairs.push([{ role: 'user', content: question }, { role: 'assistant', content: answer }]);
      historyChars += question.length + answer.length;
    }
    const historyForModel = latestPairs.reverse().flat();
    const sources = relevantSources(text, a.ctx.lessons);
    const body = Buffer.from(JSON.stringify({ requestId, question: text, ...(file ? { attachment: file.attachment } : {}), profile: profileFor(a.user, clock()),
      history: historyForModel, allowedKnowledgeSources: a.allowedKnowledgeSources,
      allowedLessons: a.allowedLessons, sources }));
    if (body.length > (file ? MAX_AI_BODY_BYTES : 500_000)) throw unavailable();
    const timestamp = String(Math.floor(clock() / 1000));
    const signature = createHmac('sha256', secret).update(timestamp).update('\n').update(body).digest('hex');
    let reply, failureMessage;
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(65_000),
        headers: { 'Content-Type': 'application/json', 'X-Lara-Timestamp': timestamp, 'X-Lara-Signature': signature } });
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_REPLY_BYTES) { await reader.cancel(); throw unavailable(); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } else reply = await response.json(); // Test adapters without a Response stream.
      if (!response.ok) {
        // Only fixed messages cross the public boundary; never return or persist provider details.
        if (response.status === 422 && reply?.error === 'invalid_attachment')
          failureMessage = 'Не удалось прочитать файл. Поддерживаются PDF до 10 страниц и фотографии JPG/PNG до 16 Мп, размером до 10 МБ.';
        else if (response.status === 422 && reply?.error === 'attachment_unreadable')
          failureMessage = 'Не удалось уверенно прочитать показатели. Прикрепите более чёткий файл или фото.';
        else if (response.status === 503 && reply?.error === 'busy')
          failureMessage = 'Лара сейчас обрабатывает другой файл. Попробуйте позже.';
        throw unavailable();
      }
      if (reply?.requestId !== requestId || typeof reply.answer !== 'string' || !reply.answer.trim()
        || reply.answer.length > 20_000 || !Array.isArray(reply.sources) || reply.sources.length > 20) throw unavailable();
    } catch {
      const { rows: [failed] } = await pool.query(`UPDATE ai_chat_requests SET status='failed'
        WHERE user_id=$1 AND request_id=$2 AND status='pending' RETURNING *`, [a.user.id, requestId]);
      const current = await access(token, expected);
      if (current.rightsHash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ к материалам изменился. Обновите страницу.');
      if (!failed) throw unavailable();
      return { accountId: a.user.id, requestId, status: 'failed', messages: messages(failed), quota: await quota(a.user.id),
        ...(failureMessage ? { failureMessage } : {}) };
    }
    const current = await access(token, expected);
    if (current.rightsHash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ к материалам изменился. Обновите страницу.');
    const knownSources = new Map([
      ...a.allowedLessons.map(l => [String(l.lessonId), { id: String(l.lessonId), title: l.title, url: l.url }]),
      ...a.allowedKnowledgeSources.map(s => [`${s.course}:${s.source}`,
        { id: `${s.course}:${s.source}`, title: s.title, url: s.url }]),
    ]);
    const safeSources = reply.sourcePolicy === 'used_v1' ? [...new Map(reply.sources
      .map(ref => knownSources.get(String(ref?.id))).filter(Boolean).map(s => [s.url, s])).values()]
      .slice(0, 3).map(source => ({ ...source, selection: 'answer' })) : [];
    const saved = await transaction(pool, async client => {
      const { rows: [session] } = await client.query(`SELECT s.user_id FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,
      [hashToken(token), new Date(clock())]);
      if (!session || session.user_id !== a.user.id) throw signedOut();
      const { rows: [row] } = await client.query(`UPDATE ai_chat_requests SET status='completed',answer=$3,sources=$4::jsonb
        WHERE user_id=$1 AND request_id=$2 AND status='pending' RETURNING *`,
      [a.user.id, requestId, reply.answer, JSON.stringify(safeSources)]);
      return row;
    });
    if (!saved) throw unavailable();
    return { accountId: a.user.id, requestId, status: 'completed', messages: messages(saved), quota: await quota(a.user.id) };
  }
  async function cleanup() {
    await pool.query('DELETE FROM ai_chat_requests WHERE accepted_at<$1', [new Date(clock() - RETENTION_MS)]);
    await pool.query('DELETE FROM ai_chat_daily_usage WHERE day_moscow<$1', [day(clock() - RETENTION_MS)]);
  }
  return Object.freeze({ history, send, status, authorize: access, authorizeVoice, transcribe, cleanup });
}
