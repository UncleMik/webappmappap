import { randomUUID } from 'node:crypto';
import { AuthError, CODE_TTL_MS, SESSION_TTL_MS, hashToken, mac, codeMac, equalMac } from './security.mjs';
import { normalizeProfile, normalizeProfileEdit } from './profile.mjs';

const invalidCode = () => new AuthError(401, 'invalid_code', 'Код неверный, использован или срок его действия истёк.');
const limited = seconds => new AuthError(429, 'rate_limited', 'Слишком много попыток. Попробуйте позже.', Math.max(1, Math.ceil(seconds)));

export async function transaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

export function createStore(pool, { secret, clock = Date.now }) {
  const emailKey = email => mac(secret, 'email', email);
  const date = () => new Date(clock());
  const unwrap = result => { if (result.error) throw result.error; return result; };
  async function lockEmail(client, email) {
    const key = emailKey(email);
    await client.query('INSERT INTO auth_email_state(email_key) VALUES($1) ON CONFLICT DO NOTHING', [key]);
    const { rows } = await client.query('SELECT * FROM auth_email_state WHERE email_key=$1 FOR UPDATE', [key]);
    return { key, ...rows[0] };
  }
  function failureDelay(state) {
    return state.failures >= 5 && state.failure_window && clock() < +new Date(state.failure_window) + CODE_TTL_MS
      ? (+new Date(state.failure_window) + CODE_TTL_MS - clock()) / 1000 : 0;
  }
  return {
    async rateLimit(kind, value, maximum) {
      const window = Math.floor(clock() / 60_000);
      const bucket = mac(secret, 'rate', `${kind}\0${value}\0${window}`);
      const result = await pool.query(`INSERT INTO auth_rate_limits(bucket,hits,expires_at) VALUES($1,1,$2)
        ON CONFLICT(bucket) DO UPDATE SET hits=auth_rate_limits.hits+1 RETURNING hits`,
      [bucket, new Date((window + 2) * 60_000)]);
      if (result.rows[0].hits > maximum) throw limited(60 - (clock() % 60_000) / 1000);
    },
    async reserveCode(email, token, code) {
      return unwrap(await transaction(pool, async client => {
        const state = await lockEmail(client, email);
        const delay = failureDelay(state);
        if (delay) throw limited(delay);
        if (state.last_sent_at && clock() - +new Date(state.last_sent_at) < 60_000) {
          throw limited((60_000 - (clock() - +new Date(state.last_sent_at))) / 1000);
        }
        const { rows } = await client.query(`SELECT count(*)::integer AS count, min(created_at) AS first
          FROM auth_mail_events WHERE email_key=$1 AND created_at>$2`, [state.key, new Date(clock() - 3_600_000)]);
        if (rows[0].count >= 10) throw limited((+new Date(rows[0].first) + 3_600_000 - clock()) / 1000);
        await client.query('UPDATE auth_email_state SET last_sent_at=$2 WHERE email_key=$1', [state.key, date()]);
        await client.query('INSERT INTO auth_mail_events(email_key,created_at) VALUES($1,$2)', [state.key, date()]);
        await client.query('UPDATE auth_challenges SET consumed_at=$2 WHERE email=$1 AND consumed_at IS NULL', [email, date()]);
        await client.query(`INSERT INTO auth_challenges(token_hash,email,code_mac,expires_at) VALUES($1,$2,$3,$4)`,
          [hashToken(token), email, codeMac(secret, token, email, code), new Date(clock() + CODE_TTL_MS)]);
        return {};
      }));
    },
    async cancelCode(token) {
      await pool.query('UPDATE auth_challenges SET consumed_at=$2 WHERE token_hash=$1', [hashToken(token), date()]);
    },
    async verifyCode(token, code) {
      return unwrap(await transaction(pool, async client => {
        // Same lock order for resend, verify and complete: email first, challenge second.
        const lookup = await client.query('SELECT email FROM auth_challenges WHERE token_hash=$1', [hashToken(token)]);
        if (!lookup.rows[0]) return { error: invalidCode() };
        const state = await lockEmail(client, lookup.rows[0].email);
        const { rows: [challenge] } = await client.query('SELECT * FROM auth_challenges WHERE token_hash=$1 FOR UPDATE', [hashToken(token)]);
        if (!challenge || challenge.consumed_at || +new Date(challenge.expires_at) <= clock()) return { error: invalidCode() };
        if (challenge.verified_at) return { email: challenge.email };
        const delay = failureDelay(state);
        if (delay) return { error: limited(delay) };
        if (!equalMac(challenge.code_mac, codeMac(secret, token, challenge.email, code))) {
          const active = state.failure_window && clock() - +new Date(state.failure_window) < CODE_TTL_MS;
          const failures = (active ? state.failures : 0) + 1;
          await client.query('UPDATE auth_email_state SET failures=$2,failure_window=$3 WHERE email_key=$1',
            [state.key, failures, active ? state.failure_window : date()]);
          if (failures >= 5) await client.query('UPDATE auth_challenges SET consumed_at=$2 WHERE email=$1 AND consumed_at IS NULL', [challenge.email, date()]);
          return { error: invalidCode() };
        }
        await client.query('UPDATE auth_challenges SET verified_at=$2 WHERE token_hash=$1', [hashToken(token), date()]);
        await client.query('UPDATE auth_email_state SET failures=0,failure_window=NULL WHERE email_key=$1', [state.key]);
        const { rows: [user] } = await client.query('SELECT id FROM auth_users WHERE email=$1', [challenge.email]);
        if (!user) {
          await client.query(`DELETE FROM auth_gc_jobs WHERE email=$1 AND created_at<$2
            AND completed_at IS NULL AND (lease_until IS NULL OR lease_until<$3)`,
          [challenge.email, new Date(clock() - 24 * 60 * 60_000), date()]);
          await client.query('INSERT INTO auth_gc_jobs(email,created_at,next_attempt_at) VALUES($1,$2,$2) ON CONFLICT DO NOTHING', [challenge.email, date()]);
        }
        return { email: challenge.email };
      }));
    },
    async registration(token) {
      const { rows: [row] } = await pool.query(`SELECT c.email, u.id AS user_id, j.completed_at FROM auth_challenges c
        LEFT JOIN auth_users u ON u.email=c.email LEFT JOIN auth_gc_jobs j ON j.email=c.email
        WHERE c.token_hash=$1 AND c.verified_at IS NOT NULL AND c.consumed_at IS NULL AND c.expires_at>$2`, [hashToken(token), date()]);
      if (!row) throw invalidCode();
      return row;
    },
    async finish(token, sessionToken) {
      return unwrap(await transaction(pool, async client => {
        const lookup = await client.query('SELECT email FROM auth_challenges WHERE token_hash=$1', [hashToken(token)]);
        if (!lookup.rows[0]) return { error: invalidCode() };
        await lockEmail(client, lookup.rows[0].email);
        const { rows: [challenge] } = await client.query('SELECT * FROM auth_challenges WHERE token_hash=$1 FOR UPDATE', [hashToken(token)]);
        if (!challenge?.verified_at || challenge.consumed_at || +new Date(challenge.expires_at) <= clock()) return { error: invalidCode() };
        let { rows: [user] } = await client.query('SELECT id,email,profile,getcourse_id FROM auth_users WHERE email=$1', [challenge.email]);
        if (!user) {
          const { rows: [job] } = await client.query('SELECT getcourse_id FROM auth_gc_jobs WHERE email=$1 AND completed_at IS NOT NULL', [challenge.email]);
          if (!job?.getcourse_id) return { pending: true };
          ({ rows: [user] } = await client.query('INSERT INTO auth_users(id,email,getcourse_id,created_at) VALUES($1,$2,$3,$4) RETURNING id,email,profile',
            [randomUUID(), challenge.email, job.getcourse_id, date()]));
        }
        await client.query('UPDATE auth_challenges SET consumed_at=$2 WHERE token_hash=$1', [hashToken(token), date()]);
        // lockEmail serializes completion for this account. Revoke and insert commit together;
        // the partial unique index also enforces one current session at the database level.
        await client.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [user.id, date()]);
        await client.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)',
          [hashToken(sessionToken), user.id, new Date(clock() + SESSION_TTL_MS), date()]);
        return { user: { id: user.id, email: user.email, profile: user.profile ?? null } };
      }));
    },
    async session(token) {
      if (!token) return null;
      const { rows: [user] } = await pool.query(`SELECT u.id,u.email,u.profile FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.revoked_at IS NULL`, [hashToken(token), date()]);
      return user || null;
    },
    async sessionState(token) {
      const anonymous = { authenticated: false, user: null };
      if (!token) return anonymous;
      const { rows: [row] } = await pool.query(`SELECT u.id,u.email,u.profile,s.revoked_at
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>$2`, [hashToken(token), date()]);
      if (!row) return anonymous;
      if (row.revoked_at) return { ...anonymous, reason: 'session_replaced' };
      return { authenticated: true, user: { id: row.id, email: row.email, profile: row.profile } };
    },
    async saveProfile(token, data) {
      if (!token) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы сохранить профиль.');
      const profile = normalizeProfile(data, clock());
      return transaction(pool, async client => {
        const { rows: [user] } = await client.query(`SELECT u.id,u.email,u.profile FROM auth_sessions s
          JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.revoked_at IS NULL
          FOR UPDATE OF s,u`, [hashToken(token), date()]);
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы сохранить профиль.');
        if (user.profile?.completedAt) throw new AuthError(409, 'profile_completed', 'Профиль уже заполнен. Обновите страницу.');
        const { rows: [updated] } = await client.query('UPDATE auth_users SET profile=$2::jsonb WHERE id=$1 RETURNING id,email,profile',
          [user.id, JSON.stringify(profile)]);
        return updated;
      });
    },
    async editProfile(token, data) {
      if (!token) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы изменить профиль.');
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => !['accountId', 'changes', 'confirmMother'].includes(key))) {
        throw new AuthError(400, 'invalid_profile', 'Проверьте данные профиля.');
      }
      return transaction(pool, async client => {
        const { rows: [user] } = await client.query(`SELECT u.id,u.email,u.profile FROM auth_sessions s
          JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.revoked_at IS NULL
          FOR UPDATE OF s,u`, [hashToken(token), date()]);
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите, чтобы изменить профиль.');
        if (data.accountId !== user.id) throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        const profile = normalizeProfileEdit(user.profile, data.changes, data.confirmMother, clock());
        const { rows: [updated] } = await client.query('UPDATE auth_users SET profile=$2::jsonb WHERE id=$1 RETURNING id,email,profile',
          [user.id, JSON.stringify(profile)]);
        return updated;
      });
    },
    async logout(token) {
      if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hashToken(token)]);
    },
    async claimJob(email = null) {
      const lease = randomUUID();
      const { rows: [job] } = await pool.query(`WITH candidate AS (
        SELECT email FROM auth_gc_jobs WHERE completed_at IS NULL AND next_attempt_at<=$1
        AND (lease_until IS NULL OR lease_until<$1) AND ($2::text IS NULL OR email=$2) AND created_at>$5
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE auth_gc_jobs j SET lease_until=$3,lease_token=$4,attempts=j.attempts+1
        FROM candidate c WHERE j.email=c.email RETURNING j.email,j.attempts,j.lease_token`,
      [date(), email, new Date(clock() + 30_000), lease, new Date(clock() - 24 * 60 * 60_000)]);
      return job;
    },
    async completeJob(job, getcourseId) {
      await pool.query(`UPDATE auth_gc_jobs SET getcourse_id=$3,completed_at=$4,lease_until=NULL,lease_token=NULL,last_error=NULL
        WHERE email=$1 AND lease_token=$2`, [job.email, job.lease_token, getcourseId, date()]);
    },
    async failJob(job, errorCode) {
      const wait = Math.min(300_000, 5_000 * 2 ** Math.min(6, job.attempts - 1));
      await pool.query(`UPDATE auth_gc_jobs SET next_attempt_at=$3,lease_until=NULL,lease_token=NULL,last_error=$4
        WHERE email=$1 AND lease_token=$2`, [job.email, job.lease_token, new Date(clock() + wait), errorCode]);
    },
    async cleanup() {
      const yesterday = new Date(clock() - 24 * 60 * 60_000);
      await pool.query('DELETE FROM auth_challenges WHERE expires_at<$1', [yesterday]);
      await pool.query('DELETE FROM auth_mail_events WHERE created_at<$1', [yesterday]);
      await pool.query('DELETE FROM auth_rate_limits WHERE expires_at<$1', [date()]);
      await pool.query('DELETE FROM auth_sessions WHERE expires_at<$1', [date()]);
      await pool.query('DELETE FROM auth_gc_jobs WHERE created_at<$1 AND completed_at IS NULL AND (lease_until IS NULL OR lease_until<$2)', [yesterday, date()]);
      await pool.query('DELETE FROM auth_gc_jobs WHERE completed_at<$1', [yesterday]);
      await pool.query(`DELETE FROM auth_email_state WHERE (last_sent_at IS NULL OR last_sent_at<$1)
        AND (failure_window IS NULL OR failure_window<$1)`, [yesterday]);
    },
  };
}
