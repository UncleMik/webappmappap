export async function clubRequest(path, { accountId, body, signal } = {}) {
  const started = performance.now();
  let response;
  try {
    response = await fetch('/api/auth/' + path, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Webpril-Chat-Version': '2', ...(accountId ? { 'X-Webpril-Account': accountId } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Object.assign(new Error('Нет связи с чатом. Проверьте интернет и повторите попытку.'), { code: 'network_error' });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.message || 'Чат временно недоступен.'),
    { code: data?.error, status: response.status });
  return data && typeof data === 'object' ? { ...data, responseAgeMs: performance.now() - started } : data;
}
export function chatLease(data, expectedAccountId) {
  const server = Date.parse(data?.serverTime), end = Date.parse(data?.validUntil);
  if (typeof data?.accountId !== 'string' || !Number.isFinite(server) || !Number.isFinite(end)
    || end <= server || end - server > 300_000 || (expectedAccountId && data.accountId !== expectedAccountId)) {
    throw Object.assign(new Error('Не удалось подтвердить доступ к чату. Повторите попытку.'), { code: 'invalid_chat_response' });
  }
  const remaining = end - server - Math.max(0, data.responseAgeMs || 0);
  if (remaining <= 0) throw Object.assign(new Error('Проверка доступа истекла. Повторите подключение.'), { code: 'expired_chat_response' });
  return remaining;
}
