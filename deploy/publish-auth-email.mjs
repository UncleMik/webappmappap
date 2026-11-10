#!/usr/bin/env node
// Run on Timeweb with node --env-file=/etc/wep-pril/auth.env.
// Only updates the configured login template; never sends a message.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const mode = process.argv[2];
const source = resolve(process.argv[3] || '/opt/wep_pril/backend/auth/email');
const fields = ['id', 'name', 'editor_type', 'template_engine', 'global_substitutions',
  'global_metadata', 'body', 'subject', 'from_email', 'from_name', 'reply_to',
  'reply_to_name', 'track_links', 'track_read', 'headers', 'attachments', 'inline_attachments'];
const hash = value => createHash('sha256').update(value).digest('hex');
const editable = template => Object.fromEntries(fields.filter(key => key in template).map(key => [key, template[key]]));

async function comparable(template) {
  const result = structuredClone(editable(template));
  // Unisender trims body text, adds empty AMP/editor fields, and returns its
  // stored image URL in place of both the CID and the uploaded base64 bytes.
  for (const attachment of result.inline_attachments || []) {
    if (!attachment.filePath) continue;
    const url = new URL(attachment.filePath);
    if (url.protocol !== 'https:' || url.hostname !== 'go2.s3.unisender.ru') {
      throw new Error('UNEXPECTED_PROVIDER_ATTACHMENT_HOST');
    }
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('PROVIDER_BANNER_FETCH_FAILED');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 500000) throw new Error('PROVIDER_BANNER_TOO_LARGE');
    result.body.html = result.body.html.replaceAll(attachment.filePath, `cid:${attachment.name}`);
    attachment.content = bytes.toString('base64');
    delete attachment.filePath;
  }
  for (const key of Object.keys(result.body || {})) {
    if (!result.body[key] && !['html', 'plaintext'].includes(key)) delete result.body[key];
    else if (typeof result.body[key] === 'string') result.body[key] = result.body[key].replace(/\r\n/g, '\n').trim();
  }
  return result;
}

async function api(method, body) {
  const response = await fetch(`https://goapi.unisender.ru/ru/transactional/api/v1/template/${method}.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.UNISENDER_API_KEY },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'success' || !result.template) {
    // Never print provider bodies, credentials, or personal data.
    throw new Error(`PROVIDER_${method.toUpperCase()}_FAILED_HTTP_${response.status}`);
  }
  return result.template;
}

async function main() {
  if (!['--apply', '--verify'].includes(mode) || !process.env.UNISENDER_API_KEY ||
      !/^[a-f0-9-]{36}$/i.test(process.env.UNISENDER_TEMPLATE_ID || '')) {
    throw new Error('MODE_AND_SERVER_CONFIGURATION_REQUIRED');
  }
  const html = await readFile(resolve(source, 'login-code.html'), 'utf8');
  const plaintext = await readFile(resolve(source, 'login-code.txt'), 'utf8');
  const banner = await readFile(resolve(source, 'school-banner.png'));
  for (const body of [html, plaintext]) {
    if ((body.match(/\{\{code\}\}/g) || []).length !== 1 ||
        /123456|910096|<script\b|data:image|file:\/\//i.test(body) ||
        !body.includes('https://app.legkie-rody.ru/') || !body.includes('5 минут')) {
      throw new Error('INVALID_EMAIL_SOURCE');
    }
  }
  if (!html.includes('cid:school-banner.png') || banner.length > 500000 ||
      banner.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      banner.readUInt32BE(16) !== 600 || banner.readUInt32BE(20) !== 186) {
    throw new Error('INVALID_BANNER');
  }
  const id = process.env.UNISENDER_TEMPLATE_ID;
  const original = editable(await api('get', { id }));
  if (original.id !== id || original.from_email !== 'auth@legkierody.ru' ||
      original.template_engine !== 'simple' || original.editor_type !== 'html' ||
      !JSON.stringify(original.body).includes('{{code}}')) {
    throw new Error('UNEXPECTED_LIVE_TEMPLATE');
  }
  const desired = { ...original, body: { html, plaintext },
    inline_attachments: [{ type: 'image/png', name: 'school-banner.png', content: banner.toString('base64') }] };
  const expected = await comparable(desired);
  const matches = async value => isDeepStrictEqual(await comparable(value), expected);
  let backup;
  if (!await matches(original)) {
    if (mode === '--verify') throw new Error('LIVE_TEMPLATE_DIFFERS');
    // A first install only replaces the known text-only template. Subsequent
    // edits need review instead of silently replacing a different live design.
    if (original.body.html || original.inline_attachments?.length || original.attachments?.length) {
      throw new Error('EXISTING_DESIGN_REQUIRES_REVIEW');
    }
    const directory = `/root/wep-pril-auth-email-backup-${Date.now()}`;
    await mkdir(directory, { mode: 0o700 });
    backup = `${directory}/template.json`;
    await writeFile(backup, JSON.stringify({ template: original }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ backup }));
    const latest = editable(await api('get', { id }));
    if (!isDeepStrictEqual(latest, original)) throw new Error('TEMPLATE_CHANGED_DURING_DEPLOY');
    let updateError;
    try { await api('set', { template: desired }); } catch (error) { updateError = error; }
    // Reconcile an uncertain response; never blindly retry a mutation.
    const after = await api('get', { id });
    if (!await matches(after)) {
      if (isDeepStrictEqual(editable(after), original)) throw updateError || new Error('TEMPLATE_NOT_UPDATED');
      throw new Error('READBACK_MISMATCH_REVIEW_PRIVATE_BACKUP');
    }
  }
  const verified = await api('get', { id });
  if (!await matches(verified)) throw new Error('FINAL_READBACK_MISMATCH');
  console.log(JSON.stringify({ status: 'verified', mode, htmlSha256: hash(html),
    plaintextSha256: hash(plaintext), bannerSha256: hash(banner),
    codePlaceholderPreserved: true, otherTemplateSettingsPreserved: true, emailSent: false }));
}

main().catch(error => {
  console.error(error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
    ? error.message : 'EMAIL_TEMPLATE_OPERATION_FAILED');
  process.exitCode = 1;
});
