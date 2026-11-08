import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuthError } from './security.mjs';

const legacyPositions = {
  'contractions-lesson': '001',
  'back-relief-video': '002',
  'birth-breathing-video': '003',
};
const s3Host = 's3.twcstorage.ru';
const emptyHash = createHash('sha256').update('').digest('hex');
const unavailable = () => new AuthError(502, 'video_unavailable', 'Не удалось загрузить видео. Попробуйте ещё раз.');

export function weeklyVideoPosition(id) {
  if (Object.hasOwn(legacyPositions, id)) return legacyPositions[id];
  const position = /^week-video-(\d{3})$/.exec(id)?.[1];
  const number = Number(position);
  return number >= 4 && number <= 126 && number !== 75 ? position : null;
}

function readMediaConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof config.bucket === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
      && typeof config.region === 'string' && /^[a-z0-9-]{2,24}$/.test(config.region)
      && typeof config.accessKey === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(config.accessKey)
      && typeof config.secretKey === 'string' && /^[A-Za-z0-9_+/=-]{20,100}$/.test(config.secretKey)) return config;
  } catch {}
  throw unavailable();
}

const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

function authorization(method, path, config) {
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const scope = [day, config.region, 's3', 'aws4_request'].join('/');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = 'host:' + s3Host + '\nx-amz-content-sha256:' + emptyHash + '\nx-amz-date:' + stamp + '\n';
  const canonical = [method, path, '', canonicalHeaders, signedHeaders, emptyHash].join('\n');
  const hash = createHash('sha256').update(canonical).digest('hex');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.secretKey, day), config.region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', stamp, scope, hash].join('\n')).toString('hex');
  return {
    'x-amz-date': stamp,
    'x-amz-content-sha256': emptyHash,
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + config.accessKey + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
}

export function createWeeklyMedia(configPath = '/etc/wep-pril-media/free-weekly-media.json', fetchObject = fetch) {
  let config;
  return async function streamWeeklyMedia(request, response, position, asset) {
    config ??= readMediaConfig(configPath);
    const cover = asset === 'cover';
    const key = cover ? 'covers/' + position + '.png' : 'videos/' + position + '.mp4';
    const path = '/' + config.bucket + '/free-weekly/v1/' + key;
    const range = request.headers.range;
    if (range && !/^bytes=(?:\d{1,18}-\d{0,18}|-\d{1,18})$/.test(range)) {
      throw new AuthError(416, 'invalid_range', 'Не удалось перейти к этой части видео.');
    }
    const headers = {
      ...authorization(request.method, path, config),
      'Accept-Encoding': 'identity',
      ...(range ? { Range: range } : {}),
    };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    const timer = setTimeout(cancel, 15_000);
    timer.unref();
    try {
      let object;
      try {
        object = await fetchObject('https://' + s3Host + path, {
          method: request.method, headers, signal: controller.signal, redirect: 'error',
        });
      } catch {
        throw unavailable();
      } finally {
        clearTimeout(timer);
      }
      const contentRange = object.headers.get('content-range');
      const outputHeaders = {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Accel-Buffering': 'no',
        'Accept-Ranges': 'bytes',
      };
      if (object.status === 416 && /^bytes \*\/\d+$/.test(contentRange ?? '')) {
        await object.body?.cancel();
        response.writeHead(416, { ...outputHeaders, 'Content-Range': contentRange });
        response.end();
        return;
      }
      const mime = cover ? 'image/png' : 'video/mp4';
      const length = object.headers.get('content-length');
      if (object.status !== (range ? 206 : 200) || object.headers.get('content-type') !== mime
        || !/^\d+$/.test(length ?? '') || object.headers.has('content-encoding')
        || (object.status === 206 && !/^bytes \d+-\d+\/\d+$/.test(contentRange ?? ''))) {
        await object.body?.cancel();
        if (object.status === 404) throw new AuthError(404, 'video_not_found', 'Видео не найдено.');
        throw unavailable();
      }
      if (response.destroyed) {
        await object.body?.cancel();
        return;
      }
      response.writeHead(object.status, {
        ...outputHeaders, 'Content-Type': mime, 'Content-Length': length,
        ...(contentRange ? { 'Content-Range': contentRange } : {}),
      });
      if (request.method === 'HEAD' || !object.body) response.end();
      else {
        try { await pipeline(Readable.fromWeb(object.body), response); }
        catch { response.destroy(); }
      }
    } finally {
      response.off('close', cancel);
    }
  };
}
