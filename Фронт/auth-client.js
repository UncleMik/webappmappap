export async function authRequest(path, body) {
  let response;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw Object.assign(new Error('Не удалось связаться с сервером. Проверьте интернет и попробуйте снова.'), { code: 'network_error' }); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || 'Вход временно недоступен. Попробуйте позже.'), {
    code: data.error || 'unavailable', retryAfter: data.retryAfter || 0,
  });
  return data;
}
