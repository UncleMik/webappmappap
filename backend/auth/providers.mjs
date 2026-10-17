// No provider response body is logged: it may contain credentials or personal data.
export class ProviderError extends Error {
  constructor(code) { super(code); this.code = code; }
}
async function jsonResponse(response, provider) {
  if (!response.ok) throw new ProviderError(`${provider}_http_${response.status}`);
  try { return await response.json(); } catch { throw new ProviderError(`${provider}_invalid_json`); }
}
export function createMailer(config, fetcher = fetch) {
  return async ({ email, code, idempotencyKey }) => {
    const response = await fetcher('https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': config.key },
      body: JSON.stringify({ message: {
        recipients: [{ email, substitutions: { code } }],
        template_id: config.templateId, template_engine: 'simple',
        from_email: config.sender, from_name: 'Лёгкие роды',
        subject: 'Код входа в «Лёгкие роды»',
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        track_read: 0, track_links: 0, skip_unsubscribe: config.skipUnsubscribe ? 1 : 0,
        bypass_global: 0, bypass_unavailable: 0, bypass_unsubscribed: 0, bypass_complained: 0,
        idempotence_key: idempotencyKey,
      } }),
    });
    const result = await jsonResponse(response, 'mail');
    if (result.status !== 'success' || !result.job_id) throw new ProviderError('mail_rejected');
    return { jobId: result.job_id };
  };
}
export function createGetCourse(config, fetcher = fetch) {
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('GETCOURSE_ORIGIN must be a plain HTTPS origin');
  }
  return async email => {
    // add + refresh_if_exists=0 creates a missing card or returns the existing ID.
    // No groups, orders, purchases, name, pregnancy data or marketing opt-in sent.
    const params = Buffer.from(JSON.stringify({ user: { email }, system: { refresh_if_exists: 0 } })).toString('base64');
    const response = await fetcher(new URL('/pl/api/users', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'add', key: config.key, params }),
    });
    const result = await jsonResponse(response, 'getcourse');
    const ok = value => value === true || value === 'true';
    const id = String(result.result?.user_id ?? '');
    if (!ok(result.success) || !ok(result.result?.success) || !/^[1-9]\d{0,17}$/.test(id) ||
        result.result?.error === true || result.result?.error === 'true') {
      throw new ProviderError('getcourse_rejected');
    }
    return id;
  };
}
