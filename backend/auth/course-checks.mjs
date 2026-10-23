import { randomUUID } from 'node:crypto';
import { AuthError } from './security.mjs';

export const COURSE_CHECK_TTL_MS = 5 * 60_000;
const LEASE_MS = 30_000;
const unavailable = () => new AuthError(503, 'course_check_unavailable',
  'Не удалось проверить доступ к курсам. Попробуйте ещё раз.', 5);
const validId = value => (typeof value === 'number' || typeof value === 'string')
  && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const dateValue = value => value === null || typeof value === 'string';
const MISSION_STATUSES = new Set(['new', 'declined', 'accepted', 'viewed']);

// Keep only evidence needed by the later product/lesson permission check.
// Payment flags and a training list are not a permission decision on their own.
function normalizeSnapshot(purchases, trainings, lessonStatuses, getcourseId) {
  if (!Array.isArray(purchases) || !Array.isArray(trainings) || !Array.isArray(lessonStatuses)
    || !purchases.every(p => p && validId(p.id) && validId(p.product_id)
      && validId(p.user_id) && Number(p.user_id) === getcourseId
      && typeof p.period_type === 'string' && p.period_type.length > 0
      && dateValue(p.start_at) && dateValue(p.finish_at) && dateValue(p.state)
      && Number.isInteger(p.is_actual) && Number.isInteger(p.is_payed))
    || !trainings.every(t => t && validId(t.id))
    || !lessonStatuses.every(s => s && validId(s.lessonId) && MISSION_STATUSES.has(s.status)
      && dateValue(s.updatedAt))) throw unavailable();
  return {
    version: 2,
    purchases: purchases.map(p => ({ id: Number(p.id), product_id: Number(p.product_id), user_id: getcourseId,
      start_at: p.start_at, finish_at: p.finish_at, period_type: p.period_type,
      is_actual: p.is_actual, is_payed: p.is_payed, state: p.state })),
    trainingIds: [...new Set(trainings.map(t => Number(t.id)))].sort((a, b) => a - b),
    lessonStates: lessonStatuses.map(s => ({ lessonId: Number(s.lessonId), status: s.status,
      updatedAt: s.updatedAt })),
  };
}

function current(row, getcourseId, now) {
  const checkedAt = +new Date(row?.checked_at), expiresAt = +new Date(row?.expires_at);
  if (!row?.snapshot || Number(row.getcourse_id) !== getcourseId || !Number.isFinite(checkedAt)
    || !Number.isFinite(expiresAt) || checkedAt > now || expiresAt <= now
    || expiresAt <= checkedAt || expiresAt - checkedAt > COURSE_CHECK_TTL_MS) return null;
  try {
    if (row.snapshot.version !== 2 || !Array.isArray(row.snapshot.trainingIds)
      || !Array.isArray(row.snapshot.lessonStates)) return null;
    const snapshot = normalizeSnapshot(row.snapshot.purchases, row.snapshot.trainingIds.map(id => ({ id })),
      row.snapshot.lessonStates, getcourseId);
    return { checkedAt: new Date(checkedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), snapshot };
  } catch { return null; }
}

export function createCourseChecks({ pool, tech, clock = Date.now }) {
  const pending = new Map();
  async function subject(userId) {
    const { rows: [user] } = await pool.query('SELECT getcourse_id FROM auth_users WHERE id=$1', [userId]);
    if (!validId(user?.getcourse_id)) throw unavailable();
    return Number(user.getcourse_id);
  }
  async function cached(userId, gcId) {
    const { rows: [row] } = await pool.query(`SELECT c.* FROM course_access_checks c
      JOIN auth_users u ON u.id=c.user_id AND u.getcourse_id=c.getcourse_id
      WHERE c.user_id=$1 AND u.getcourse_id=$2`, [userId, gcId]);
    return current(row, gcId, clock());
  }
  async function check(userId) {
    try {
      const gcId = await subject(userId);
      const ready = await cached(userId, gcId);
      if (ready) return ready;
      const startedAt = clock(), lease = randomUUID();
      const { rows } = await pool.query(`INSERT INTO course_access_checks(user_id,getcourse_id,lease_token,lease_until)
        SELECT id,$2,$3,$4 FROM auth_users WHERE id=$1 AND getcourse_id=$2
        ON CONFLICT(user_id) DO UPDATE SET lease_token=$3,lease_until=$4
        WHERE (course_access_checks.lease_until IS NULL OR course_access_checks.lease_until<=$5)
        RETURNING lease_token`, [userId, gcId, lease, new Date(startedAt + LEASE_MS), new Date(startedAt)]);
      if (!rows.length) {
        const completed = await cached(userId, gcId);
        if (completed) return completed;
        throw unavailable();
      }
      try {
        // Recheck after acquiring the lease; another instance may have just finished.
        const completed = await cached(userId, gcId);
        if (completed) return completed;
        const [purchases, trainings, lessonStatuses] = await Promise.all([
          tech.getPurchases(gcId), tech.getUserTrainings(gcId), tech.getLessonStatuses(gcId),
        ]);
        const snapshot = normalizeSnapshot(purchases, trainings, lessonStatuses, gcId);
        if (clock() < startedAt || clock() >= startedAt + COURSE_CHECK_TTL_MS) throw unavailable();
        const { rows: saved } = await pool.query(`UPDATE course_access_checks SET getcourse_id=$2,snapshot=$3::jsonb,
          checked_at=$4,expires_at=$5,lease_token=NULL,lease_until=NULL
          WHERE user_id=$1 AND lease_token=$6 AND EXISTS(SELECT 1 FROM auth_users WHERE id=$1 AND getcourse_id=$2)
          RETURNING *`, [userId, gcId, JSON.stringify(snapshot), new Date(startedAt),
          new Date(startedAt + COURSE_CHECK_TTL_MS), lease]);
        const result = current(saved[0], gcId, clock());
        if (!result) throw unavailable();
        return result;
      } finally {
        // Leave a short retry bound after an error; never extend checked_at/expires_at.
        await pool.query(`UPDATE course_access_checks SET lease_token=NULL,lease_until=$3
          WHERE user_id=$1 AND lease_token=$2`, [userId, lease, new Date(clock() + 5000)]);
      }
    } catch { throw unavailable(); }
  }
  return Object.freeze({
    // Call this gate before any paid response; stale evidence is never returned.
    requireCurrent(userId) {
      if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        return Promise.reject(unavailable());
      }
      if (!pending.has(userId)) {
        const job = check(userId).finally(() => pending.delete(userId));
        pending.set(userId, job);
      }
      return pending.get(userId);
    },
  });
}
