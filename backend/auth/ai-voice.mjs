import { createHash, createHmac } from 'node:crypto';
import { AuthError } from './security.mjs';

export const MAX_AI_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_AI_VOICE_BODY_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 120_000;
const MAX_CACHE = 512;
const unavailable = () => new AuthError(503, 'ai_voice_unavailable', 'Не удалось распознать запись. Попробуйте позже.');
const invalid = () => new AuthError(400, 'invalid_ai_audio', 'Запишите голосовое сообщение до двух минут и 5 МБ.');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validateAiAudio(audio) {
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)
    || Object.keys(audio).some(k => !['mimeType', 'data'].includes(k))
    || !['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav'].includes(audio.mimeType)
    || typeof audio.data !== 'string' || !audio.data.length || audio.data.length % 4
    || audio.data.length > 4 * Math.ceil(MAX_AI_AUDIO_BYTES / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw invalid();
  const bytes = Buffer.from(audio.data, 'base64');
  if (!bytes.length || bytes.length > MAX_AI_AUDIO_BYTES || bytes.toString('base64') !== audio.data) throw invalid();
  const magic = audio.mimeType === 'audio/webm' ? bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
    : audio.mimeType === 'audio/ogg' ? bytes.subarray(0, 4).toString('ascii') === 'OggS'
      : audio.mimeType === 'audio/mp4' ? bytes.subarray(4, 8).toString('ascii') === 'ftyp'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (!magic) throw invalid();
  return createHash('sha256').update(audio.mimeType).update('\n').update(bytes).digest('hex');
}

export function createAiVoice({ authorize, acquire, secret, clock, fetchImpl }) {
  const cache = new Map();
  const endpoint = 'https://admin.legkie-rody.ru/internal/lara-web/transcribe';
  function remember(key, entry) {
    cache.set(key, entry);
    const timer = setTimeout(() => { if (cache.get(key) === entry) cache.delete(key); }, CACHE_MS);
    timer.unref();
  }
  return async function transcribe(token, expected, data, rateLimit) {
    const a = await authorize(token, expected);
    if (!uuid(data?.requestId)) throw invalid();
    const requestId = data.requestId.toLowerCase(), key = `${a.user.id}:${requestId}`;
    const hash = validateAiAudio(data.audio);
    for (const [k, entry] of cache) if (entry.expiresAt <= clock()) cache.delete(k);
    const previous = cache.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new AuthError(409, 'request_id_conflict', 'Запись изменилась. Запишите её заново.');
      if (previous.rightsHash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ изменился. Обновите страницу.');
      const text = previous.text ?? await previous.promise;
      const current = await authorize(token, expected);
      if (current.rightsHash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ изменился. Обновите страницу.');
      return { accountId: a.user.id, requestId, text };
    }
    if (cache.size >= MAX_CACHE) throw unavailable();
    if (typeof rateLimit !== 'function') throw unavailable();
    const release = acquire();
    const entry = { hash, rightsHash: a.rightsHash, expiresAt: clock() + CACHE_MS };
    // Cache only a hash, a transient promise, then text. The audio stays within this job.
    entry.promise = (async () => {
      try {
        await rateLimit(a.user.id);
        const body = Buffer.from(JSON.stringify({ requestId, audio: data.audio }));
        const timestamp = String(Math.floor(clock() / 1000));
        const signature = createHmac('sha256', secret).update(timestamp).update('\n').update(body).digest('hex');
        let response, reply;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(55_000),
            headers: { 'Content-Type': 'application/json', 'X-Lara-Timestamp': timestamp, 'X-Lara-Signature': signature } });
          if (response.body?.getReader) {
            const reader = response.body.getReader(), chunks = [];
            let bytes = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > 32 * 1024) { await reader.cancel(); throw unavailable(); }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
            reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } else reply = await response.json();
        } catch { throw unavailable(); }
        if (!response.ok) {
          if (response.status === 422 && reply?.error === 'audio_too_long')
            throw new AuthError(422, 'ai_audio_too_long', 'Запишите сообщение короче двух минут.');
          if (response.status === 422 && ['audio_unrecognized', 'invalid_audio'].includes(reply?.error))
            throw new AuthError(422, 'ai_audio_unrecognized', 'Не удалось разобрать речь. Запишите сообщение ещё раз.');
          if (response.status === 503 && reply?.error === 'busy')
            throw new AuthError(503, 'ai_voice_busy', 'Лара сейчас обрабатывает другую запись. Попробуйте позже.');
          throw unavailable();
        }
        const text = typeof reply?.text === 'string' ? reply.text.trim() : '';
        if (reply?.requestId !== requestId || !text || [...text].length > 4000
          || /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\r\t]/g, ''))) throw unavailable();
        entry.text = text;
        return text;
      } finally { data = null; release(); }
    })();
    remember(key, entry);
    const text = await entry.promise;
    entry.promise = null;
    const current = await authorize(token, expected);
    if (current.rightsHash !== a.rightsHash) throw new AuthError(409, 'ai_access_changed', 'Доступ изменился. Обновите страницу.');
    return { accountId: a.user.id, requestId, text };
  };
}
