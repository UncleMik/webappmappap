const SCHOOL_ORIGIN = 'https://legkierody.ru';
const API_PREFIX = '/pl/api/v1';

export class GetCourseTechError extends Error {
  constructor(code) {
    super(`GetCourse Tech API: ${code}`);
    this.name = 'GetCourseTechError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordArray(value, validate) {
  return Array.isArray(value) && value.every(row => isRecord(row) && validate(row));
}

function positiveId(value) {
  return validUserId(value) || (typeof value === 'string' && /^[1-9]\d*$/.test(value)
    && validUserId(Number(value)));
}

function trainingData(value) {
  return recordArray(value, row => positiveId(row.id) && typeof row.title === 'string');
}

// These are transport checks only. Flags, dates, and available trainings do not
// independently establish a student's entitlement to a paid lesson.
function purchaseData(value, userId) {
  return recordArray(value, row => positiveId(row.id) && positiveId(row.product_id)
    && positiveId(row.user_id) && Number(row.user_id) === userId
    && Number.isInteger(row.is_actual) && Number.isInteger(row.is_payed)
    && typeof row.period_type === 'string' && row.period_type.length > 0
    && (typeof row.start_at === 'string' || row.start_at === null)
    && (typeof row.finish_at === 'string' || row.finish_at === null)
    && (typeof row.state === 'string' || row.state === null));
}

function userData(value, selector) {
  const valid = row => isRecord(row) && positiveId(row.id)
    && (selector.userId ? Number(row.id) === selector.userId :
      typeof row.email === 'string' && row.email.toLowerCase() === selector.email.toLowerCase());
  return Array.isArray(value) ? value.length > 0 && value.every(valid) : valid(value);
}

function validUserId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function userQuery(userId) {
  if (!validUserId(userId)) throw new TypeError('userId must be a positive integer');
  return { userId: String(userId) };
}

function fieldsQuery(selector) {
  if (!isRecord(selector) || Object.keys(selector).length !== 1) {
    throw new TypeError('Provide exactly one userId or email');
  }
  if (Object.hasOwn(selector, 'userId')) return userQuery(selector.userId);
  if (Object.hasOwn(selector, 'email') && typeof selector.email === 'string'
    && selector.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selector.email)) {
    return { email: selector.email };
  }
  throw new TypeError('Provide exactly one valid userId or email');
}

function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid school origin'); }
  if (url.origin !== SCHOOL_ORIGIN || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password) {
    throw new TypeError('Invalid school origin');
  }
  return url.origin;
}

function validateKey(value) {
  if (typeof value !== 'string' || !value || /\s/.test(value)) {
    throw new TypeError('Invalid Tech API key');
  }
  return value;
}

export function createGetCourseTech({
  schoolOrigin = SCHOOL_ORIGIN,
  developerKey,
  schoolKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const origin = validateOrigin(schoolOrigin);
  const authorization = `Bearer ${validateKey(developerKey)}_${validateKey(schoolKey)}`;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new TypeError('timeoutMs must be 1..15000');
  }

  async function request(path, query, validData) {
    const url = new URL(`${API_PREFIX}${path}`, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new GetCourseTechError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    const call = (async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: authorization },
        });
      } catch {
        throw new GetCourseTechError('request_failed');
      }
      if (!response || !Number.isInteger(response.status)) throw new GetCourseTechError('invalid_response');
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new GetCourseTechError('redirect');
      }
      if (response.status < 200 || response.status >= 300) throw new GetCourseTechError('http_error');
      let body;
      try { body = await response.json(); } catch { throw new GetCourseTechError('invalid_response'); }
      if (!isRecord(body)) throw new GetCourseTechError('invalid_response');
      if (body.status !== true) throw new GetCourseTechError('api_rejected');
      if (!validData(body.data)) throw new GetCourseTechError('invalid_response');
      return body.data;
    })();
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      if (error instanceof GetCourseTechError) throw error;
      // Fetch errors can contain the request URL, query email, or headers.
      throw new GetCourseTechError('request_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    getTrainings: () => request('/common/get-trainings', {}, trainingData),
    getUserFields: selector => request('/user/get-fields', fieldsQuery(selector),
      data => userData(data, selector)),
    getPurchases: userId => request('/user/get-purchases', userQuery(userId),
      data => purchaseData(data, userId)),
    getUserTrainings: userId => request('/user/get-trainings', userQuery(userId), trainingData),
  });
}
