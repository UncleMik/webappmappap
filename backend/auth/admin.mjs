import { AuthError, hashToken, isUuid, normalizeEmail } from './security.mjs';
import { transaction } from './store.mjs';
import { createAdminChats } from './admin-chats.mjs';

const unauthorized = () => new AuthError(401, 'sign_in_required', 'Войдите по email.');
const forbidden = () => new AuthError(403, 'admin_forbidden', 'У этого аккаунта нет доступа к админке.');
const accountChanged = () => new AuthError(409, 'account_changed', 'Аккаунт изменился. Войдите заново.');
const announcementColumns = 'id,title,body,link,published_at AS "publishedAt",hidden_at AS "hiddenAt"';
const pollColumns = `id,question,options,opens_at AS "opensAt",closes_at AS "closesAt",editor_revision AS revision,
  CASE WHEN opens_at>now() THEN 'scheduled' WHEN closes_at>now() THEN 'open' ELSE 'closed' END AS status`;

function boundedText(value, max, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || /\x00/.test(text)) throw new AuthError(400, 'invalid_text', message);
  return text;
}

function readAnnouncement(data, appOrigin) {
  if (!isUuid(data.id)) throw new AuthError(400, 'invalid_request', 'Обновите страницу и повторите действие.');
  const title = boundedText(data.title, 140, 'Введите заголовок до 140 знаков.');
  const body = boundedText(data.body, 3000, 'Введите текст до 3000 знаков.');
  const raw = typeof data.link === 'string' ? data.link.trim() : '';
  let link = null;
  if (raw) {
    try {
      if (raw.length > 700 || /[\\\s\x00-\x1f\x7f]/.test(raw) || !/^(\/[^/]|\/$|https:\/\/)/i.test(raw)) throw new Error();
      const url = new URL(raw, appOrigin);
      if (url.protocol !== 'https:' || url.username || url.password ||
          (raw.startsWith('/') && url.origin !== appOrigin)) throw new Error();
      link = raw.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.href;
      // A normalized path beginning with two slashes would become an external link in the browser.
      if (link.startsWith('//')) throw new Error();
    } catch { throw new AuthError(400, 'invalid_link', 'Укажите ссылку https:// или путь внутри приложения.'); }
  }
  return { id: data.id.toLowerCase(), title, body, link };
}

function readPoll(data) {
  const id = data.week;
  const monday = typeof id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(id) ? new Date(`${id}T00:00:00Z`) : new Date(NaN);
  if (monday.getUTCDay() !== 1 || monday.toISOString().slice(0, 10) !== id) {
    throw new AuthError(400, 'invalid_week', 'Выберите дату понедельника.');
  }
  const question = boundedText(data.question, 250, 'Введите вопрос до 250 знаков.');
  if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8) {
    throw new AuthError(400, 'invalid_options', 'Добавьте от двух до восьми вариантов.');
  }
  const options = data.options.map(option => boundedText(option, 150, 'Заполните варианты ответа до 150 знаков.'));
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
    throw new AuthError(400, 'duplicate_options', 'Варианты ответа должны отличаться.');
  }
  const sunday = new Date(+monday + 6 * 86_400_000).toISOString().slice(0, 10);
  return { id, question, options, opens: `${id}T00:00:00+03:00`, closes: `${sunday}T18:00:00+03:00` };
}

export function createAdmin({ pool, articles, ownerEmail, appOrigin }) {
  async function role(client, user, lock = false) {
    if (!user) return null;
    if (user.email === ownerEmail) return 'owner';
    const match = await client.query(`SELECT 1 FROM admin_editors WHERE user_id=$1${lock ? ' FOR SHARE' : ''}`, [user.id]);
    return match.rows.length ? 'editor' : null;
  }

  async function access(client, token, expected, lock = false, ownerOnly = false) {
    if (!token) throw unauthorized();
    const { rows: [user] } = await client.query(`SELECT u.id,u.email FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()${lock ? ' FOR SHARE OF s' : ''}`, [hashToken(token)]);
    if (!user) throw unauthorized();
    if ((lock || expected !== undefined) && user.id !== expected) throw accountChanged();
    const permission = await role(client, user, lock);
    if (!permission || ownerOnly && permission !== 'owner') throw forbidden();
    return { ...user, role: permission };
  }

  async function audit(client, actor, action, target) {
    await client.query('INSERT INTO admin_audit(actor_id,action,target) VALUES($1,$2,$3)', [actor, action, target]);
  }

  const read = (token, expected, run, ownerOnly = false) => transaction(pool, async client =>
    run(client, await access(client, token, expected, false, ownerOnly)));
  const write = (token, expected, run, ownerOnly = false) => transaction(pool, async client =>
    run(client, await access(client, token, expected, true, ownerOnly)));
  // Images have no account header. Resolve the account and then lock its live
  // session and editor grant, exactly as for writes, before reading chat data.
  const chatRead = (token, expected, run) => transaction(pool, async client => {
    const user = await access(client, token, expected);
    return run(client, await access(client, token, user.id, true));
  });
  const editorList = async client => (await client.query(`SELECT u.email,e.granted_at AS "grantedAt"
    FROM admin_editors e JOIN auth_users u ON u.id=e.user_id ORDER BY e.granted_at DESC`)).rows;

  return {
    ...createAdminChats({ read: chatRead, write, audit }),
    session: (token, expected) => access(pool, token, expected),
    async allowedEmail(email) {
      if (email === ownerEmail) return true;
      const { rows } = await pool.query('SELECT 1 FROM admin_editors e JOIN auth_users u ON u.id=e.user_id WHERE u.email=$1', [email]);
      return rows.length > 0;
    },
    async allowedChallenge(token) {
      const { rows: [challenge] } = await pool.query('SELECT email FROM auth_challenges WHERE token_hash=$1', [hashToken(token)]);
      return Boolean(challenge && await this.allowedEmail(challenge.email));
    },
    articles: (token, expected) => read(token, expected, () => articles.list()),
    article: (token, expected, id) => read(token, expected, () => articles.get(id)),
    publishArticle: (token, expected, id, data) => write(token, expected, (_, user) => articles.publish(user.id, id, data)),
    articleVisibility: (token, expected, id, data) => write(token, expected, (_, user) => articles.visibility(user.id, id, data)),
    staff: (token, expected) => read(token, expected, editorList, true),
    setStaff: (token, expected, data) => write(token, expected, async (client, user) => {
      const email = normalizeEmail(data.email);
      if (email === ownerEmail || typeof data.grant !== 'boolean') {
        throw new AuthError(400, 'invalid_grant', 'Выберите действие для аккаунта сотрудника.');
      }
      const { rows: [target] } = await client.query('SELECT id FROM auth_users WHERE email=$1', [email]);
      if (!target) throw new AuthError(404, 'staff_not_found', 'Аккаунт с этим email не найден. Сотруднику нужно сначала войти в приложение.');
      const result = data.grant
        ? await client.query('INSERT INTO admin_editors(user_id) VALUES($1) ON CONFLICT DO NOTHING', [target.id])
        : await client.query('DELETE FROM admin_editors WHERE user_id=$1', [target.id]);
      if (result.rowCount) await audit(client, user.id, data.grant ? 'staff_granted' : 'staff_revoked', target.id);
      return editorList(client);
    }, true),
    announcements: (token, expected) => read(token, expected, async client => (await client.query(`SELECT ${announcementColumns}
      FROM admin_announcements ORDER BY published_at DESC,id LIMIT 50`)).rows),
    publishAnnouncement: (token, expected, data) => write(token, expected, async (client, user) => {
      const { id, title, body, link } = readAnnouncement(data, appOrigin);
      const { rows: [created] } = await client.query(`INSERT INTO admin_announcements(id,author_id,title,body,link)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${announcementColumns}`, [id, user.id, title, body, link]);
      if (created) {
        await audit(client, user.id, 'announcement_published', id);
        return created;
      }
      const { rows: [prior] } = await client.query(`SELECT ${announcementColumns} FROM admin_announcements
        WHERE id=$1 AND author_id=$2 AND title=$3 AND body=$4 AND link IS NOT DISTINCT FROM $5::text`, [id, user.id, title, body, link]);
      if (!prior) throw new AuthError(409, 'announcement_conflict', 'Объявление уже изменилось. Обновите список.');
      return prior;
    }),
    hideAnnouncement: (token, expected, id) => write(token, expected, async (client, user) => {
      const { rowCount } = await client.query('UPDATE admin_announcements SET hidden_at=now() WHERE id=$1 AND hidden_at IS NULL', [id]);
      if (rowCount) await audit(client, user.id, 'announcement_hidden', id);
    }),
    async publicAnnouncements(user, expected) {
      if (!user) throw unauthorized();
      if (expected !== undefined && user.id !== expected) throw accountChanged();
      const { rows } = await pool.query(`SELECT id,title,body,link,published_at AS "publishedAt"
        FROM admin_announcements WHERE hidden_at IS NULL ORDER BY published_at DESC,id LIMIT 30`);
      return { accountId: user.id, announcements: rows };
    },
    polls: (token, expected) => read(token, expected, async client => (await client.query(`SELECT ${pollColumns},
      ARRAY(SELECT count(v.choice)::integer FROM generate_subscripts(p.options,1) AS n
        LEFT JOIN weekly_poll_votes v ON v.poll_id=p.id AND v.choice=n-1 GROUP BY n ORDER BY n) AS counts
      FROM weekly_polls p ORDER BY opens_at DESC LIMIT 50`)).rows),
    schedulePoll: (token, expected, data) => write(token, expected, async (client, user) => {
      const { id, question, options, opens, closes } = readPoll(data);
      const args = [id, question, options, opens, closes];
      let result;
      if (data.revision === undefined) {
        result = await client.query(`INSERT INTO weekly_polls(id,question,options,opens_at,closes_at,editor_revision)
          SELECT $1,$2,$3,$4::timestamptz,$5::timestamptz,1 WHERE $4::timestamptz>clock_timestamp()
          ON CONFLICT DO NOTHING RETURNING ${pollColumns}`, args);
      } else {
        if (!Number.isInteger(data.revision) || data.revision < 0) {
          throw new AuthError(400, 'invalid_revision', 'Обновите список голосований.');
        }
        result = await client.query(`UPDATE weekly_polls SET question=$2,options=$3,editor_revision=editor_revision+1
          WHERE id=$1 AND opens_at=$4::timestamptz AND closes_at=$5::timestamptz
            AND opens_at>clock_timestamp() AND editor_revision=$6 RETURNING ${pollColumns}`, [...args, data.revision]);
      }
      if (!result.rows.length) throw new AuthError(409, 'poll_conflict', 'Неделя уже занята, голосование началось или его изменили. Обновите список.');
      await audit(client, user.id, 'poll_scheduled', id);
      return result.rows[0];
    }),
    history: (token, expected) => read(token, expected, async client => {
      const { rows } = await client.query(`SELECT actor_id AS actor,action,target,occurred_at AS "occurredAt"
        FROM admin_audit ORDER BY id DESC LIMIT 50`);
      const entries = [...rows, ...articles.audit()]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 50);
      const ids = [...new Set(entries.flatMap(row => [row.actor, row.action.startsWith('staff_') ? row.target : null]).filter(Boolean))];
      const { rows: users } = await client.query('SELECT id,email FROM auth_users WHERE id=ANY($1::uuid[])', [ids]);
      const emails = new Map(users.map(user => [user.id, user.email]));
      return entries.map(row => ({ ...row, actor: emails.get(row.actor) ?? null,
        target: row.action.startsWith('staff_') ? emails.get(row.target) ?? 'Аккаунт удалён' : row.target }));
    }),
  };
}
