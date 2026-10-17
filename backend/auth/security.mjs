import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';

export const CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const COOKIE_NAME = '__Host-school_session';
export class AuthError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message); Object.assign(this, { status, code, retryAfter });
  }
}
export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s\x00-\x1f\x7f]/u.test(value.trim())) {
    throw new AuthError(400, 'invalid_email', 'Проверьте адрес электронной почты.');
  }
  const parts = value.trim().split('@');
  const domain = parts.length === 2 ? domainToASCII(parts[1].toLowerCase()) : '';
  if (!parts[0] || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(parts[0]) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain) ||
      parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) {
    throw new AuthError(400, 'invalid_email', 'Проверьте адрес электронной почты.');
  }
  // GetCourse email identity: case insensitive; do not remove +tags or Gmail dots.
  return `${parts[0].toLowerCase()}@${domain}`;
}
export const randomToken = () => randomBytes(32).toString('base64url');
export const generateCode = () => String(randomInt(1_000_000)).padStart(6, '0');
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export const mac = (secret, purpose, value) => createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('hex');
export const codeMac = (secret, token, email, code) => mac(secret, 'code', `${token}\0${email}\0${code}`);
export function equalMac(a, b) {
  const left = Buffer.from(a, 'hex'), right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function sessionCookie(token, clear = false) {
  return `${COOKIE_NAME}=${clear ? '' : token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}`;
}
export function readSessionCookie(request) {
  const match = (request.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE_NAME}=`));
  const token = match?.slice(COOKIE_NAME.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
