import { COOKIE_NAME, AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';
import { starsWeek } from './stars-core.mjs';
import { forGamificationUser } from './gamification-settings.mjs';

// The same predicate is used by JSON, list, direct article and video delivery.
export function canAccessWeek(context, week) {
  if (!Number.isInteger(Number(week)) || Number(week) < 1 || Number(week) > 42) return false;
  if (!context.enforced || context.legacy) return true;
  return Number(week) <= context.currentWeek || (context.purchasedWeeks || []).includes(Number(week)) || (context.preservedWeeks || []).includes(Number(week));
}
export function createStarsAccess({ stars, pool, settings, contextProvider, clock = Date.now }) {
  if (!contextProvider && !pool && !stars?.withAccount) throw new Error('Stars access requires a policy reader');
  if (pool && typeof settings?.get !== 'function') throw new Error('Stars access requires fresh settings');
  async function readContext(token, account) {
    if (typeof token !== 'string' || !token) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
    return transaction(pool, async client => {
      const now = new Date(clock());
      // Keep the session and profile stable only during this short local read.
      // No GetCourse, wallet initialization, lifecycle or reward hooks here.
      const { rows: [user] } = await client.query(`SELECT u.id,u.profile,u.created_at,s.expires_at FROM auth_sessions s
        JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
        AND s.expires_at>$2 FOR SHARE OF s,u`, [hashToken(token), now]);
      if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
      if (!isUuid(account) || account.toLowerCase() !== user.id.toLowerCase())
        throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
      if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль.');
      const config = forGamificationUser(await settings.get(client), user.id);
      const { rows: [rights] } = await client.query(`SELECT w.legacy,w.preserved_weeks,l.launched_at
        FROM (SELECT 1) seed LEFT JOIN auth_stars_wallet w ON w.user_id=$1
        LEFT JOIN auth_stars_launch l ON l.id=1`, [user.id]);
      // A reviewed wallet is authoritative. Without one, pre-launch or unknown
      // histories remain open until review; a post-launch account gets week gates.
      const legacy = typeof rights?.legacy === 'boolean' ? rights.legacy
        : !rights?.launched_at || Number(new Date(user.created_at)) <= Number(new Date(rights.launched_at));
      const { rows: purchases } = await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1 ORDER BY week', [user.id]);
      const policyNow = new Date(clock());
      if (Number(new Date(user.expires_at)) <= Number(policyNow)) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
      return { accountId: user.id, currentWeek: starsWeek(user.profile, policyNow) || 0, legacy,
        enforced: config.enabled === true && config.features?.weekLocks === true,
        purchasedWeeks: purchases.map(row => Number(row.week)), preservedWeeks: rights?.preserved_weeks || [] };
    });
  }
  async function context(token, account) {
    if (contextProvider) return contextProvider(token, account);
    if (pool) return readContext(token, account);
    return stars.withAccount(token, account, async (client, ctx) => {
      const { rows } = await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1', [ctx.userId]);
      // Legacy simple-open history is incomplete. Only wallet's explicitly audited false enables locks.
      return { accountId: ctx.userId, currentWeek: ctx.currentWeek || 0, legacy: ctx.legacy !== false,
        enforced: !!(ctx.settings?.enabled && ctx.settings?.features?.weekLocks),
        purchasedWeeks: rows.map(row => Number(row.week)), preservedWeeks: ctx.preservedWeeks || [] };
    });
  }
  function assertWeek(ctx, week) {
    if (!canAccessWeek(ctx, week)) throw new AuthError(403, 'week_locked', 'Эта неделя пока закрыта.');
  }
  function filter(ctx, items) { return items.filter(item => canAccessWeek(ctx, item.week)); }
  function weekly(ctx, data) {
    const result = { ...data };
    for (const kind of ['mom', 'baby']) result[kind] = Object.fromEntries(Object.entries(data[kind] || {}).filter(([week]) => canAccessWeek(ctx, Number(week))));
    // Calendar and calendarNotes are intentionally complete even without a due date.
    return { ...result, access: { currentWeek: ctx.currentWeek, availableWeeks: Array.from({ length: 42 }, (_, i) => i + 1).filter(week => canAccessWeek(ctx, week)) } };
  }
  function videoWeek(position) {
    const value = Number(position);
    return Number.isInteger(value) && value >= 1 && value <= 126 ? Math.ceil(value / 3) : null;
  }
  return Object.freeze({ context, canWeek: canAccessWeek, assertWeek, filter, weekly, videoWeek });
}

// Article runtime uses only this local policy client, never the full auth runtime.
export function createLocalStarsAccess({ url = 'http://127.0.0.1:3001/api/auth/internal/weekly-access', fetchImpl = fetch } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
    || endpoint.pathname !== '/api/auth/internal/weekly-access' || endpoint.search || endpoint.hash)
    throw new Error('Weekly policy endpoint must be local');
  return createStarsAccess({ async contextProvider(token, account) {
    if (!token || typeof account !== 'string') throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
    let result;
    try {
      const response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { Cookie: `${COOKIE_NAME}=${token}`, 'X-Webpril-Account': account } });
      if ([401, 403, 409].includes(response.status)) throw new AuthError(response.status, 'access_denied', 'Обновите страницу и войдите в аккаунт.');
      if (!response.ok) throw new Error('Policy unavailable');
      result = await response.json();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'weekly_access_unavailable', 'Материалы временно недоступны.');
    }
    const weeks = value => Array.isArray(value) && value.length <= 42 && value.every(w => Number.isInteger(w) && w >= 1 && w <= 42);
    if (typeof result?.accountId !== 'string' || result.accountId.toLowerCase() !== account.toLowerCase() || typeof result.enforced !== 'boolean' || typeof result.legacy !== 'boolean'
      || !Number.isInteger(result.currentWeek) || result.currentWeek < 0 || result.currentWeek > 42
      || !weeks(result.purchasedWeeks) || !weeks(result.preservedWeeks))
      throw new AuthError(503, 'weekly_access_unavailable', 'Материалы временно недоступны.');
    return { accountId: result.accountId, currentWeek: result.currentWeek, enforced: result.enforced,
      legacy: result.legacy, purchasedWeeks: result.purchasedWeeks, preservedWeeks: result.preservedWeeks };
  } });
}
