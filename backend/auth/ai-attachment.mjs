import { createHash } from 'node:crypto';
import { AuthError } from './security.mjs';

export const MAX_AI_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_AI_BODY_BYTES = 15 * 1024 * 1024;
const invalid = () => new AuthError(400, 'invalid_ai_attachment', 'Прикрепите один файл PDF, JPG или PNG до 10 МБ.');

// Only a transient base64 string crosses to Germany. No original is persisted.
export function validateAiAttachment(value) {
  if (value === undefined) return null;
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !['name', 'mimeType', 'data'].includes(key))
    || typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 150
    || /[\p{Cc}\p{Cf}\\/:]/u.test(value.name) || ['.', '..'].includes(value.name)
    || !['application/pdf', 'image/jpeg', 'image/png'].includes(value.mimeType)
    || typeof value.data !== 'string' || !value.data.length
    || value.data.length > 4 * Math.ceil(MAX_AI_FILE_BYTES / 3)
    || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw invalid();
  const bytes = Buffer.from(value.data, 'base64');
  if (!bytes.length || bytes.length > MAX_AI_FILE_BYTES || bytes.toString('base64') !== value.data) throw invalid();
  const matches = value.mimeType === 'application/pdf' ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    : value.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!matches) throw invalid();
  return { attachment: { name: value.name, mimeType: value.mimeType, data: value.data },
    digest: createHash('sha256').update(bytes).digest('hex') };
}
