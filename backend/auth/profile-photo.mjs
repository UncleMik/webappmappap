import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';

const invalid = () => new AuthError(400, 'invalid_photo', 'Выберите фотографию JPEG размером до 350 КБ.');
const missing = () => new AuthError(404, 'photo_not_found', 'Фото не найдено.');
const filename = (id, version) => `${id}-${version}.jpg`;

function decodePhoto(value) {
  if (typeof value !== 'string' || !value.length || value.length > 480_000 || value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) || (value.includes('=') && !/={1,2}$/.test(value))) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw invalid();
  if (bytes.length < 100 || bytes.length > 350 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw invalid();
  let i = 2, dimensions = null, foundScan = false;
  while (i < bytes.length - 2) {
    if (bytes[i++] !== 0xff) throw invalid();
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xda) { foundScan = true; break; }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) throw invalid();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) throw invalid();
      dimensions = { height: bytes.readUInt16BE(i + 3), width: bytes.readUInt16BE(i + 5) };
    }
    i += length;
  }
  if (!foundScan || !dimensions || !dimensions.width || !dimensions.height || dimensions.width > 512 || dimensions.height > 512) throw invalid();
  return bytes;
}

export function createProfilePhoto(pool, { directory = '/var/lib/wep-pril-auth/profile-photos', clock = Date.now } = {}) {
  const dir = resolve(directory);
  async function findUser(token, client = pool) {
    if (!token) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть фото.');
    const { rows: [user] } = await client.query(`SELECT u.id,u.email,u.profile FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.revoked_at IS NULL
      ${client === pool ? '' : 'FOR UPDATE OF s,u'}`, [hashToken(token), new Date(clock())]);
    if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы посмотреть фото.');
    return user;
  }
  return {
    async read(token, requestedVersion = null) {
      const user = await findUser(token);
      const version = user.profile?.photoVersion;
      if (!version || !/^[0-9a-f-]{36}$/i.test(version) || (requestedVersion && requestedVersion !== version)) throw missing();
      try { return await readFile(resolve(dir, filename(user.id, version))); }
      catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; }
    },
    async write(token, data) {
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => !['accountId', 'photo'].includes(key))) throw invalid();
      const bytes = data.photo === null ? null : decodePhoto(data.photo);
      let saved = null, old = null;
      try {
        const updated = await transaction(pool, async client => {
          const user = await findUser(token, client);
          if (data.accountId !== user.id) throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
          if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль.');
          const version = bytes ? randomUUID() : null;
          if (bytes) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            saved = resolve(dir, filename(user.id, version));
            await writeFile(saved, bytes, { flag: 'wx', mode: 0o600 });
          }
          old = user.profile.photoVersion ? resolve(dir, filename(user.id, user.profile.photoVersion)) : null;
          const profile = { ...user.profile };
          if (version) profile.photoVersion = version;
          else delete profile.photoVersion;
          const { rows: [result] } = await client.query('UPDATE auth_users SET profile=$2::jsonb WHERE id=$1 RETURNING id,email,profile',
            [user.id, JSON.stringify(profile)]);
          return result;
        });
        if (old) await unlink(old).catch(error => { if (error.code !== 'ENOENT') console.error('old_profile_photo_cleanup_failed'); });
        return updated;
      } catch (error) {
        if (saved) await unlink(saved).catch(() => {});
        throw error;
      }
    },
  };
}
