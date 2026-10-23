const MAX_CHECK_AGE_MS = 5 * 60_000;

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return null;
}

function epochFromParts(year, month, day, hour, minute, second, millisecond, offsetMinutes) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return null;
  const epoch = local.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(epoch) ? epoch : null;
}

// GetCourse's timezone-free timestamps use Moscow time (UTC+03:00).
export function parseGetCourseDate(value) {
  if (typeof value !== 'string') return null;
  const naive = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (naive) return epochFromParts(...naive.slice(1).map(Number), 0, 180);

  const explicit = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!explicit) return null;
  const fraction = Number((explicit[7] || '').padEnd(3, '0'));
  const zone = explicit[8];
  let offset = 0;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offset = (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes);
  }
  return epochFromParts(...explicit.slice(1, 7).map(Number), fraction, offset);
}

function activeEnd(purchase, now) {
  if (!purchase || typeof purchase !== 'object' || Array.isArray(purchase)
    || positiveId(purchase.id) === null || positiveId(purchase.product_id) === null
    || positiveId(purchase.user_id) === null
    || purchase.is_actual !== 1 || purchase.state !== null) return null;
  const optional = value => value === null || value === '';
  if (purchase.period_type === 'limited') {
    if (optional(purchase.start_at) || optional(purchase.finish_at)) return null;
    const start = parseGetCourseDate(purchase.start_at);
    const finish = parseGetCourseDate(purchase.finish_at);
    return start !== null && finish !== null && now >= start && now < finish ? finish : null;
  }
  if (purchase.period_type === 'unlimited') {
    const start = optional(purchase.start_at) ? null : parseGetCourseDate(purchase.start_at);
    const finish = optional(purchase.finish_at) ? Infinity : parseGetCourseDate(purchase.finish_at);
    if ((!optional(purchase.start_at) && start === null) || finish === null
      || (start !== null && now < start) || now >= finish) return null;
    return finish;
  }
  return null;
}

export function activeCourseProducts(products, check, now = Date.now()) {
  if (!Array.isArray(products) || !check || typeof check !== 'object'
    || !Number.isFinite(now) || !check.snapshot || typeof check.snapshot !== 'object') return [];
  const checkedAt = parseGetCourseDate(check.checkedAt);
  const expiresAt = parseGetCourseDate(check.expiresAt);
  if (checkedAt === null || expiresAt === null || checkedAt > now || expiresAt <= now
    || expiresAt <= checkedAt || expiresAt - checkedAt > MAX_CHECK_AGE_MS) return [];
  const { purchases, trainingIds } = check.snapshot;
  if (!Array.isArray(purchases) || !Array.isArray(trainingIds)) return [];
  const normalizedTrainingIds = trainingIds.map(positiveId);
  if (normalizedTrainingIds.includes(null)) return [];
  const grantedTrainings = new Set(normalizedTrainingIds);
  const validProducts = new Map(), conflicts = new Set();
  for (const product of products) {
    if (!product || product.type !== 'training') continue;
    const productId = positiveId(product.productId), trainingId = positiveId(product.trainingId);
    if (productId === null || trainingId === null) continue;
    if (validProducts.has(productId) && validProducts.get(productId) !== trainingId) conflicts.add(productId);
    else validProducts.set(productId, trainingId);
  }
  const ends = new Map();
  for (const purchase of purchases) {
    const productId = positiveId(purchase?.product_id);
    if (productId === null || !validProducts.has(productId) || conflicts.has(productId)) continue;
    const end = activeEnd(purchase, now);
    if (end !== null) ends.set(productId, Math.max(ends.get(productId) ?? -Infinity, end));
  }
  return [...validProducts].flatMap(([productId, trainingId]) => {
    const end = ends.get(productId);
    return conflicts.has(productId) || !grantedTrainings.has(trainingId) || end === undefined
      ? [] : [{ productId, validUntil: Math.min(expiresAt, end) }];
  });
}
