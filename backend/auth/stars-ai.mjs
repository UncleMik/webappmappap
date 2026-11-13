import { DEFAULT_GAMIFICATION_SETTINGS, forGamificationUser } from './gamification-settings.mjs';
import { AuthError } from './security.mjs';

const day = now => new Date(Number(new Date(now)) + 3 * 3600000).toISOString().slice(0, 10);
async function limits(settings, client, tier, userId) {
  const config = forGamificationUser(settings ? await settings.get(client) : DEFAULT_GAMIFICATION_SETTINGS, userId);
  const ai = config.enabled ? (config.ai || DEFAULT_GAMIFICATION_SETTINGS.ai) : DEFAULT_GAMIFICATION_SETTINGS.ai;
  const course = tier === 'course';
  return { enabled: config.enabled === true, free: course ? ai.courseDaily : ai.freeDaily,
    paid: config.enabled && config.features?.aiPacks && config.aiBudgetApproved === true
      ? (course ? ai.coursePaidDaily : ai.freePaidDaily) : 0 };
}
export function createStarsAi({ pool, settings, clock = Date.now }) {
  async function quota(client = pool, { userId, tier, now = clock() }, capturedLimits) {
    const today = day(now), cap = capturedLimits || await limits(settings, client, tier, userId);
    const { rows: [free] } = await client.query('SELECT used FROM ai_chat_daily_usage WHERE user_id=$1 AND day_moscow=$2', [userId, today]);
    const { rows: [paid] } = await client.query('SELECT used FROM auth_stars_ai_daily_usage WHERE user_id=$1 AND day_moscow=$2', [userId, today]);
    const { rows: [stock] } = await client.query('SELECT balance FROM auth_stars_ai_credits WHERE user_id=$1', [userId]);
    const used = free?.used || 0, paidUsed = paid?.used || 0, paidRemaining = stock?.balance || 0;
    const freeRemaining = Math.max(0, cap.free - used), paidDailyRemaining = Math.max(0, cap.paid - paidUsed);
    // The original fields retain their free-quota meaning for older clients.
    return { limit: cap.free, used, remaining: freeRemaining, freeRemaining, paidRemaining, paidUsed, paidDailyRemaining,
      totalRemaining: freeRemaining + Math.min(paidRemaining, paidDailyRemaining), maximum: cap.free + cap.paid,
      resetsAt: new Date(Date.parse(`${today}T00:00:00Z`) + 21 * 3600000).toISOString(), serverTime: new Date(now).toISOString() };
  }
  async function reserve(client, { userId, tier, now = clock() }, { requestId }) {
    // Same first lock as wallet.withAccount. No stock/daily row may be locked first.
    await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE', [userId]);
    const { rows: [old] } = await client.query('SELECT * FROM auth_stars_ai_reservations WHERE user_id=$1 AND request_id=$2', [userId, requestId]);
    if (old) return { ...old, duplicate: true };
    const cap = await limits(settings, client, tier, userId);
    const q = await quota(client, { userId, tier, now }, cap);
    if (q.totalRemaining < 1) throw Object.assign(new AuthError(429, 'ai_daily_limit', 'Сегодня доступные вопросы закончились. Возвращайтесь завтра.'), { quota: q });
    const free = q.freeRemaining > 0 ? 1 : 0, paid = 1 - free, today = day(now);
    if (free) await client.query(`INSERT INTO ai_chat_daily_usage(user_id,day_moscow,used) VALUES($1,$2,$3)
      ON CONFLICT(user_id,day_moscow) DO UPDATE SET used=ai_chat_daily_usage.used+EXCLUDED.used`, [userId, today, free]);
    if (paid) {
      await client.query('UPDATE auth_stars_ai_credits SET balance=balance-$2 WHERE user_id=$1', [userId, paid]);
      await client.query(`INSERT INTO auth_stars_ai_daily_usage(user_id,day_moscow,used) VALUES($1,$2,$3)
        ON CONFLICT(user_id,day_moscow) DO UPDATE SET used=auth_stars_ai_daily_usage.used+EXCLUDED.used`, [userId, today, paid]);
    }
    if (!cap.enabled) return { economyEnabled: false };
    return { ...(await client.query(`INSERT INTO auth_stars_ai_reservations(user_id,request_id,day_moscow,free_units,paid_units)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [userId, requestId, today, free, paid])).rows[0], economyEnabled: true };
  }
  async function refund(client, { userId, requestId }) {
    await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE', [userId]);
    const { rows: [row] } = await client.query(`UPDATE auth_stars_ai_reservations SET refunded=true
      WHERE user_id=$1 AND request_id=$2 AND NOT refunded RETURNING *`, [userId, requestId]);
    if (!row) return false;
    if (row.free_units) await client.query('UPDATE ai_chat_daily_usage SET used=GREATEST(0,used-$3) WHERE user_id=$1 AND day_moscow=$2', [userId, row.day_moscow, row.free_units]);
    if (row.paid_units) {
      await client.query('UPDATE auth_stars_ai_credits SET balance=balance+$2 WHERE user_id=$1', [userId, row.paid_units]);
      await client.query('UPDATE auth_stars_ai_daily_usage SET used=GREATEST(0,used-$3) WHERE user_id=$1 AND day_moscow=$2', [userId, row.day_moscow, row.paid_units]);
    }
    return true;
  }
  return Object.freeze({ quota, reserve, refund, async isEnabled(client = pool, { userId }) { return (await limits(settings, client, 'free', userId)).enabled; } });
}
