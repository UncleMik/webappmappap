import { randomUUID } from 'node:crypto';
import { AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';
import { createVideoPoints } from './points-video.mjs';

const CLUB_MESSAGE_POINTS = 5;
const ARTICLE_POINTS = 20;
const DAILY_LIMIT = 60;
const WEEKLY_LIMIT = 180;
const POINTS_LOCK_NAMESPACE = 0x504f494e;
const ARTICLE_READING_MS = 30_000;
const MAX_READING_GAP_MS = 25_000;
const ATTEMPT_IDLE_MS = 30 * 60_000;
const PAGE_SIZE = 20;
const signedOut = () => new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
const attemptExpired = () => new AuthError(409, 'article_attempt_expired', 'Откройте статью ещё раз для зачёта чтения.');
export const isPointsCursor = value => typeof value === 'string' &&
  /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

async function lockAccount(client, userId) {
  // Separate two-key lock space from the Club's request ID locks.
  await client.query('SELECT pg_advisory_xact_lock($1::int,hashtext($2))', [POINTS_LOCK_NAMESPACE, userId]);
}

async function limits(client, userId, occurredAt) {
  const { rows: [row] } = await client.query(`WITH period AS (
      SELECT (CAST($2 AS timestamptz) AT TIME ZONE 'Europe/Moscow')::date AS day
    )
    SELECT period.day::text AS day,
      COALESCE(sum(amount) FILTER (WHERE moscow_day=period.day),0)::int AS daily,
      COALESCE(sum(amount),0)::int AS weekly,
      COALESCE(bool_or(source_message_id IS NOT NULL AND moscow_day=period.day),false) AS chat_credited
    FROM period LEFT JOIN auth_points_ledger ON user_id=$1
      AND poll_id IS NULL
      AND moscow_day >= date_trunc('week',period.day::timestamp)::date
      AND moscow_day < date_trunc('week',period.day::timestamp)::date + 7
    GROUP BY period.day`, [userId, occurredAt]);
  const daily = Math.max(0, DAILY_LIMIT - row.daily);
  const weekly = Math.max(0, WEEKLY_LIMIT - row.weekly);
  return { day: row.day, available: Math.min(daily, weekly), chatCredited: row.chat_credited,
    limitedBy: weekly === 0 ? 'week' : daily === 0 ? 'day' : null };
}

export function createPoints({ pool, userIds, forAll = false, lookupArticle = () => null, stars = null, clock = Date.now }) {
  const allowed = new Set(userIds);
  const legacyIncludes = userId => forAll || allowed.has(userId);
  // Club's synchronous eligibility hook includes stars candidates. Awarding still
  // checks the live feature flag, and legacy hooks keep their own allowlist.
  const includes = userId => Boolean(stars) || legacyIncludes(userId);
  const contexts = new WeakMap();
  const newContext = client => contexts.get(client);
  async function accountLock(client,userId) {
    if(stars && await stars.isEnabled(userId)) {
      // External callers use pooled clients too: never retain their account context.
      if(!newContext(client))await stars.contextFor(client,userId);
    } else await lockAccount(client,userId);
  }

  function eligibleArticle(id) {
    const article = lookupArticle(id);
    if (article?.id !== id || !Number.isInteger(article.minutes) || article.minutes < 1) {
      throw new AuthError(404, 'points_article_not_found', 'Статья недоступна для начисления баллов.');
    }
  }

  async function withAccount(token, expectedAccountId, run) {
    if (stars && await stars.isEnabled(expectedAccountId)) return stars.withAccount(token,expectedAccountId,async(client,c)=>{
      contexts.set(client,c); try{return await run(client,c.userId,c.sessionHash);}finally{contexts.delete(client);}
    });
    if (!token) throw signedOut();
    const sessionHash = hashToken(token);
    return transaction(pool, async client => {
      const { rows: [session] } = await client.query(`SELECT s.user_id,s.expires_at
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,
      [sessionHash, new Date(clock())]);
      if (!session || +new Date(session.expires_at) <= +new Date(clock())) throw signedOut();
      const userId = session.user_id;
      if (!isUuid(expectedAccountId) || expectedAccountId !== userId) {
        throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
      }
      const result = await run(client, userId, sessionHash);
      if (+new Date(session.expires_at) <= +new Date(clock())) throw signedOut();
      return result;
    });
  }

  async function startArticle(client, userId, sessionHash, articleId, now) {
    eligibleArticle(articleId);
    if(newContext(client)) await stars.materialAccess(client,newContext(client),'article',articleId);
    const { rows: [earned] } = await client.query(
      'SELECT 1 FROM auth_points_ledger WHERE user_id=$1 AND article_id=$2', [userId, articleId]);
    if (earned) return { status: 'already_earned' };
    if(newContext(client)){const {rows}=await client.query("SELECT 1 FROM auth_stars_material_progress WHERE user_id=$1 AND kind='article' AND material_id=$2",[userId,articleId]);if(rows.length)return {status:'already_earned'};}
    const quota = newContext(client) ? {available:(await stars.wallet(client,newContext(client))).dailyRemaining,limitedBy:'day'} : await limits(client, userId, now);
    if (!newContext(client) && !quota.available) return { status: 'limited', limitedBy: quota.limitedBy };

    const required = ARTICLE_READING_MS;
    const { rows: [previous] } = await client.query(`SELECT attempt_id,active_ms,last_seen_at
      FROM auth_points_article_reads
      WHERE user_id=$1 AND article_id=$2 AND session_hash=$3 AND awarded_amount IS NULL`,
    [userId, articleId, sessionHash]);
    const resumable = previous && +now - +previous.last_seen_at <= ATTEMPT_IDLE_MS;
    const attemptId = resumable ? previous.attempt_id : randomUUID();
    const active = resumable ? Math.min(previous.active_ms, required) : 0;
    await client.query(`INSERT INTO auth_points_article_reads
      (user_id,article_id,session_hash,attempt_id,last_seen_at,required_ms,active_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id,article_id) DO UPDATE SET
        session_hash=EXCLUDED.session_hash, attempt_id=EXCLUDED.attempt_id, active_ms=EXCLUDED.active_ms,
        last_seen_at=EXCLUDED.last_seen_at, required_ms=EXCLUDED.required_ms,
        awarded_amount=NULL, limited_by=NULL`, [userId, articleId, sessionHash, attemptId, now, required, active]);
    return { status: 'reading', attemptId, remainingMs: required - active,
      availableAmount: Math.min(newContext(client)?(newContext(client).settings.rewards?.article??10):ARTICLE_POINTS, quota.available) };
  }

  async function advanceArticle(client, userId, sessionHash, { articleId, attemptId, reachedEnd }, now) {
    const { rows: [attempt] } = await client.query(`SELECT last_seen_at,active_ms,awarded_amount,limited_by
      FROM auth_points_article_reads WHERE user_id=$1 AND article_id=$2 AND session_hash=$3 AND attempt_id=$4`,
    [userId, articleId, sessionHash, attemptId]);
    if (!attempt) throw attemptExpired();
    if (attempt.awarded_amount !== null) return attempt.awarded_amount > 0
      ? { status: 'earned', amount: attempt.awarded_amount }
      : { status: 'limited', limitedBy: attempt.limited_by };

    const gap = +now - +attempt.last_seen_at;
    if (gap > ATTEMPT_IDLE_MS) throw attemptExpired();
    const elapsed = gap > 0 && gap <= MAX_READING_GAP_MS ? gap : 0;
    const active = Math.min(ARTICLE_READING_MS, attempt.active_ms + elapsed);
    if (!reachedEnd || active < ARTICLE_READING_MS) {
      await client.query(`UPDATE auth_points_article_reads SET active_ms=$3,last_seen_at=$4
        WHERE user_id=$1 AND article_id=$2`, [userId, articleId, active, now]);
      return { status: 'reading', remainingMs: ARTICLE_READING_MS - active };
    }

    eligibleArticle(articleId);
    if(newContext(client)) await stars.materialAccess(client,newContext(client),'article',articleId);
    const quota = newContext(client) ? {available:(await stars.wallet(client,newContext(client))).dailyRemaining,limitedBy:'day'} : await limits(client, userId, now);
    const completion = newContext(client) ? await stars.completeMaterial(client,newContext(client),{kind:'article',id:articleId}) : null;
    const amount = completion ? completion.reward?.actualAmount||0 : Math.min(ARTICLE_POINTS,quota.available);
    if (amount > 0 && !completion) {
      await client.query(`INSERT INTO auth_points_ledger(user_id,article_id,occurred_at,moscow_day,amount)
        VALUES ($1,$2,$3,$4,$5)`, [userId, articleId, now, quota.day, amount]);
    }
    await client.query(`UPDATE auth_points_article_reads
      SET active_ms=$3,last_seen_at=$4,awarded_amount=$5,limited_by=$6
      WHERE user_id=$1 AND article_id=$2`, [userId, articleId, active, now, amount, quota.limitedBy]);
    return amount > 0 ? { status: 'earned', amount, ...(completion?{completion}: {}) } : { status: 'limited', limitedBy: quota.limitedBy, ...(completion?{amount:0,completion}: {}) };
  }

  return {
    videoWatching: createVideoPoints({ withAccount, includes: userId => legacyIncludes(userId), lockAccount:accountLock, limits, clock, stars, context: newContext }),
    includes,
    lockAccount: accountLock,
    async awardClubMessage(client, userId, messageId, occurredAt) {
      if(stars && await stars.isEnabled(userId)){const c=newContext(client)||await stars.contextFor(client,userId);
        const {rows:old}=await client.query('SELECT 1 FROM auth_points_ledger WHERE user_id=$1 AND source_message_id IS NOT NULL AND moscow_day=$2',[userId,c.moscowDay]);
        if(old.length)return;
        const {rows:[message]}=await client.query('SELECT id FROM club_messages WHERE id=$1 AND author_id=$2',[messageId,userId]);
        if(message) await stars.credit(client,c,{code:'club_message',ref:c.moscowDay,amount:c.settings.rewards?.clubMessage??5,capped:true,metadata:{messageId:String(messageId)}});return;}
      if(!legacyIncludes(userId))return;
      const quota = await limits(client, userId, occurredAt);
      if (quota.chatCredited || !quota.available) return;
      await client.query(`INSERT INTO auth_points_ledger(user_id,source_message_id,occurred_at,moscow_day,amount)
        SELECT author_id,id,created_at,$3,$4 FROM club_messages WHERE id=$1 AND author_id=$2
        ON CONFLICT DO NOTHING`, [messageId, userId, quota.day, Math.min(CLUB_MESSAGE_POINTS, quota.available)]);
    },
    async articleReading(token, expectedAccountId, data) {
      const { articleId, attemptId, reachedEnd } = data;
      const start = attemptId === undefined;
      if (typeof articleId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(articleId) ||
          Object.keys(data).some(key => !['articleId', 'attemptId', 'reachedEnd'].includes(key)) ||
          (start ? reachedEnd !== undefined : !isUuid(attemptId) || typeof reachedEnd !== 'boolean')) {
        throw new AuthError(400, 'invalid_article_reading', 'Неверный запрос зачёта чтения.');
      }
      return withAccount(token, expectedAccountId, async (client, userId, sessionHash) => {
        if (!newContext(client) && !legacyIncludes(userId)) throw new AuthError(403, 'points_unavailable', 'Баллы недоступны.');
        await accountLock(client, userId);
        const now = new Date(clock());
        return start ? startArticle(client, userId, sessionHash, articleId, now)
          : advanceArticle(client, userId, sessionHash, data, now);
      });
    },
    async read(token, expectedAccountId, before) {
      return withAccount(token, expectedAccountId, async (client, userId) => {
        if(newContext(client))return {accountId:userId,enabled:true,...await stars.wallet(client,newContext(client),{before:before??null})};
        if (!legacyIncludes(userId)) return { accountId: userId, enabled: false };
        const { rows } = await client.query(`SELECT totals.balance,page.id,page.amount,page.occurred_at,page.article_id,page.video_id,page.poll_id
          FROM (SELECT COALESCE(sum(amount),0) AS balance FROM auth_points_ledger WHERE user_id=$1) totals
          LEFT JOIN LATERAL (
            SELECT id,amount,occurred_at,article_id,video_id,poll_id FROM auth_points_ledger
            WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint)
            ORDER BY id DESC LIMIT $3
          ) page ON true
          ORDER BY page.id DESC`, [userId, before ?? null, PAGE_SIZE + 1]);
        const history = rows.filter(row => row.id !== null).slice(0, PAGE_SIZE).map(row => ({
          id: String(row.id), kind: row.poll_id ? 'weekly_poll' : row.video_id ? 'video_watch' : row.article_id ? 'article_read' : 'club_message',
          amount: row.amount, occurredAt: row.occurred_at.toISOString(),
        }));
        return { accountId: userId, enabled: true, balance: Number(rows[0].balance), history,
          nextCursor: rows.length > PAGE_SIZE ? history.at(-1).id : null };
      });
    },
  };
}
