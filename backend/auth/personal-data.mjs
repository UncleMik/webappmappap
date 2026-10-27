import { createHash } from 'node:crypto';
import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';

const bad = () => new AuthError(400, 'invalid_personal_data', 'Проверьте введённые данные.');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const decimal = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function only(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) throw bad();
}
const requireId = value => { if (!id(value)) throw bad(); return value; };
const requireUuid = value => { if (!uuid(value)) throw bad(); return value.toLowerCase(); };
function eventTime(value, undated = false) {
  if (undated && value == null) return null;
  if (!iso(value)) throw bad();
  return new Date(value).toISOString();
}
function weight(value, undated = false) {
  only(value, ['id', 'value', 'recordedAt']);
  if (!decimal(value.value, 0.1, 500)) throw bad();
  return { value: value.value, recordedAt: eventTime(value.recordedAt, undated) };
}
function pressure(value, undated = false) {
  only(value, ['id', 'systolic', 'diastolic', 'recordedAt']);
  if (!integer(value.systolic, 1, 300) || !integer(value.diastolic, 1, 250)) throw bad();
  return { systolic: value.systolic, diastolic: value.diastolic, recordedAt: eventTime(value.recordedAt, undated) };
}
function wellbeing(value, undated = false) {
  only(value, ['id', 'state', 'comment', 'recordedAt']);
  if (!(undated ? ['good', 'normal', 'bad', ''] : ['good', 'normal', 'bad']).includes(value.state)
      || typeof value.comment !== 'string' || value.comment.length > 120) throw bad();
  return { state: value.state, comment: value.comment, recordedAt: eventTime(value.recordedAt, undated) };
}
function baby(value) {
  only(value, ['heartRate', 'ultrasoundDate', 'ultrasoundWeek', 'position']);
  const normalized = { heartRate: String(value.heartRate ?? ''), ultrasoundDate: value.ultrasoundDate ?? '',
    ultrasoundWeek: String(value.ultrasoundWeek ?? ''), position: value.position ?? '' };
  if (normalized.heartRate && (!/^\d{1,3}$/.test(normalized.heartRate) || !integer(+normalized.heartRate, 1, 300))) throw bad();
  if (normalized.ultrasoundDate && !date(normalized.ultrasoundDate)) throw bad();
  if (normalized.ultrasoundWeek && (!/^\d{1,2}$/.test(normalized.ultrasoundWeek) || !integer(+normalized.ultrasoundWeek, 1, 42))) throw bad();
  if (!['', 'head', 'breech', 'transverse'].includes(normalized.position)) throw bad();
  return normalized;
}
function movement(value) {
  only(value, ['id', 'recordedAt']);
  return { recordedAt: eventTime(value.recordedAt) };
}
const legacyId = (kind, value, index) => createHash('sha256').update(`${kind}\0${index}\0${JSON.stringify(value)}`).digest('hex');
function buildOperations(data) {
  only(data, ['operation','id','value','recordedAt','systolic','diastolic','state','comment','week','heartRate','ultrasoundDate','ultrasoundWeek','position','read','favorite','confirmed','data']);
  const op = data.operation;
  if (op === 'import') {
    only(data, ['operation', 'confirmed', 'data']);
    if (data.confirmed !== true) throw bad();
    const source = data.data;
    only(source, ['weights','pressure','wellbeing','baby','movements','readArticles','favorites']);
    const operations = [];
    const bounded = (list, max) => { if (!Array.isArray(list) || list.length > max) throw bad(); return list; };
    bounded(source.weights ?? [], 5000).forEach((item, index) => {
      const value = weight(item);
      operations.push(['weight', legacyId('weight', value, index), value, false]);
    });
    if (source.pressure != null) {
      const value = pressure(source.pressure, true);
      operations.push(['pressure', legacyId('pressure', value, 0), value, false]);
    }
    if (source.wellbeing != null) {
      const value = wellbeing(source.wellbeing, true);
      operations.push(['wellbeing', legacyId('wellbeing', value, 0), value, false]);
    }
    const babies = source.baby ?? {};
    only(babies, Object.keys(babies));
    if (Object.keys(babies).length > 42) throw bad();
    for (const [week, item] of Object.entries(babies)) {
      if (!integer(+week, 1, 42) || String(+week) !== week) throw bad();
      operations.push(['baby', week, baby(item), false]);
    }
    bounded(source.movements ?? [], 10000).forEach((item, index) => {
      const time = typeof item === 'number' && Number.isSafeInteger(item) && item > 0 && Number.isFinite(new Date(item).getTime())
        ? new Date(item).toISOString() : item;
      if (typeof item === 'number' && item <= 0) throw bad();
      const value = movement({ recordedAt: time });
      operations.push(['movement', legacyId('movement', value, index), value, false]);
    });
    bounded(source.readArticles ?? [], 5000).forEach(item => operations.push(['article', requireId(item), { selected: true }, false]));
    bounded(source.favorites ?? [], 5000).forEach(item => operations.push(['favorite', requireId(item), { selected: true }, false]));
    return operations;
  }
  if (op === 'addWeight') { only(data, ['operation','id','value','recordedAt']); return [['weight', requireUuid(data.id), weight({value:data.value,recordedAt:data.recordedAt}), false]]; }
  if (op === 'addPressure') { only(data, ['operation','id','systolic','diastolic','recordedAt']); return [['pressure', requireUuid(data.id), pressure({systolic:data.systolic,diastolic:data.diastolic,recordedAt:data.recordedAt}), false]]; }
  if (op === 'addWellbeing') { only(data, ['operation','id','state','comment','recordedAt']); return [['wellbeing', requireUuid(data.id), wellbeing({state:data.state,comment:data.comment,recordedAt:data.recordedAt}), false]]; }
  if (op === 'addMovement') { only(data, ['operation','id','recordedAt']); return [['movement', requireUuid(data.id), movement({recordedAt:data.recordedAt}), false]]; }
  if (op === 'setBaby') {
    only(data, ['operation','week','heartRate','ultrasoundDate','ultrasoundWeek','position']);
    if (!integer(data.week, 1, 42)) throw bad();
    return [['baby', String(data.week), baby({ heartRate: data.heartRate, ultrasoundDate: data.ultrasoundDate,
      ultrasoundWeek: data.ultrasoundWeek, position: data.position }), true]];
  }
  if (op === 'setArticleRead' || op === 'setFavorite') {
    only(data, ['operation','id', op === 'setFavorite' ? 'favorite' : 'read']);
    const selected = op === 'setFavorite' ? data.favorite : data.read;
    if (typeof selected !== 'boolean') throw bad();
    return [[op === 'setFavorite' ? 'favorite' : 'article', requireId(data.id), selected ? { selected: true } : null, true]];
  }
  throw bad();
}
function snapshot(rows) {
  const result = { weights: [], pressure: [], wellbeing: [], baby: {}, movements: [], readArticles: [], favorites: [] };
  for (const row of rows) {
    const value = row.value;
    if (row.kind === 'weight') result.weights.push({ id: row.record_id, ...value, _createdAt: row.created_at });
    if (row.kind === 'pressure') result.pressure.push({ id: row.record_id, ...value, _createdAt: row.created_at });
    if (row.kind === 'wellbeing') result.wellbeing.push({ id: row.record_id, ...value, _createdAt: row.created_at });
    if (row.kind === 'movement') result.movements.push({ id: row.record_id, ...value, _createdAt: row.created_at });
    if (row.kind === 'baby') result.baby[row.record_id] = value;
    if (row.kind === 'article') result.readArticles.push(row.record_id);
    if (row.kind === 'favorite') result.favorites.push(row.record_id);
  }
  for (const key of ['weights','pressure','wellbeing','movements']) result[key].sort((a,b) =>
    (a.recordedAt === null && b.recordedAt === null ? 0
      : a.recordedAt === null ? -1 : b.recordedAt === null ? 1 : Date.parse(a.recordedAt) - Date.parse(b.recordedAt))
      || new Date(a._createdAt) - new Date(b._createdAt) || a.id.localeCompare(b.id));
  for (const key of ['weights','pressure','wellbeing','movements']) result[key].forEach(entry => { delete entry._createdAt; });
  return result;
}
export function createPersonalData(pool) {
  async function owner(client, token) {
    const { rows: [session] } = await client.query(`SELECT user_id FROM auth_sessions WHERE token_hash=$1
      AND revoked_at IS NULL AND expires_at>now() FOR SHARE`, [hashToken(token || '')]);
    if (!session) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
    return session.user_id;
  }
  const readRows = async (client, userId) => ({ accountId: userId,
    ...snapshot((await client.query(`SELECT kind,record_id,value,created_at FROM auth_personal_records
      WHERE user_id=$1 ORDER BY kind,record_id`, [userId])).rows) });
  return {
    read: token => transaction(pool, async client => readRows(client, await owner(client, token))),
    async write(token, data, expectedAccountId) {
      return transaction(pool, async client => {
        const userId = await owner(client, token);
        if (expectedAccountId !== undefined && expectedAccountId !== userId) {
          throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        }
        const operations = buildOperations(data);
        for (const [kind, recordId, value, replace] of operations) {
          if (value === null) await client.query('DELETE FROM auth_personal_records WHERE user_id=$1 AND kind=$2 AND record_id=$3', [userId,kind,recordId]);
          else {
            const encoded = JSON.stringify(value);
            const inserted = await client.query(`INSERT INTO auth_personal_records(user_id,kind,record_id,value) VALUES($1,$2,$3,$4)
              ON CONFLICT(user_id,kind,record_id) ${replace ? 'DO UPDATE SET value=excluded.value' : 'DO NOTHING'} RETURNING value`,
            [userId,kind,recordId,encoded]);
            if (!replace && data.operation !== 'import' && !inserted.rows.length) {
              const existing = await client.query(`SELECT value=$4::jsonb AS same FROM auth_personal_records
                WHERE user_id=$1 AND kind=$2 AND record_id=$3`, [userId,kind,recordId,encoded]);
              if (existing.rows[0]?.same !== true) throw new AuthError(409, 'record_conflict', 'Запись с этим номером уже существует.');
            }
          }
        }
        return readRows(client, userId);
      });
    },
  };
}
