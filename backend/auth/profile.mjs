import { AuthError } from './security.mjs';

export const PREGNANCY_GOALS = Object.freeze([
  'Спокойно пройти беременность', 'Подготовиться к родам', 'Понимать развитие малыша',
  'Подготовить тело к родам', 'Разобраться с анализами', 'Справиться с тревогой',
  'Подготовиться к первым дням с малышом',
]);
export const MOTHER_GOALS = Object.freeze([
  'Восстановиться после родов', 'Наладить грудное вскармливание',
  'Разобраться с уходом за малышом', 'Наладить сон малыша и свой сон',
  'Вернуться к физической активности', 'Справиться со стрессом',
  'Общаться с мамами и делиться опытом',
]);

const DAY = 86_400_000;
const invalid = message => new AuthError(400, 'invalid_profile', message);
const iso = ms => new Date(ms).toISOString().slice(0, 10);

function calendarDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`Проверьте ${field}.`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || iso(ms) !== value) throw invalid(`Проверьте ${field}.`);
  return ms;
}

function moscowToday(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const part = type => Number(parts.find(item => item.type === type).value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}

function integer(value, min, max) {
  // HTML number inputs send strings; reject fractions, spaces and scientific notation.
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function textField(value, label, max, required = false) {
  if (typeof value !== 'string') throw invalid(`Проверьте поле «${label}».`);
  const result = value.trim();
  if ((required && !result) || [...result].length > max || /[\p{Cc}\p{Cf}]/u.test(result)) {
    throw invalid(`Проверьте поле «${label}».`);
  }
  return result;
}

// Edits are deliberately partial: an expired due date must not prevent a name edit.
export function normalizeProfileEdit(existing, changes, confirmMother = false, now = Date.now()) {
  if (!existing?.completedAt || !changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw invalid('Проверьте данные профиля.');
  }
  const allowed = new Set(['name', 'surname', 'birthday', 'city', 'phone', 'stage', 'dueDate', 'birthDate', 'goals']);
  if (!Object.keys(changes).length || Object.keys(changes).some(key => !allowed.has(key))) throw invalid('Проверьте данные профиля.');
  const result = { ...existing };
  if (Object.hasOwn(changes, 'name')) result.name = textField(changes.name, 'Имя', 80, true);
  if (Object.hasOwn(changes, 'surname')) result.surname = textField(changes.surname, 'Фамилия', 80);
  if (Object.hasOwn(changes, 'city')) result.city = textField(changes.city, 'Город', 100);
  if (Object.hasOwn(changes, 'birthday')) {
    if (changes.birthday === '') result.birthday = '';
    else {
      const date = calendarDate(changes.birthday, 'дату рождения');
      if (date < Date.UTC(1900, 0, 1) || date > moscowToday(now)) throw invalid('Проверьте дату рождения.');
      result.birthday = changes.birthday;
    }
  }
  if (Object.hasOwn(changes, 'phone')) {
    const phone = textField(changes.phone, 'Номер телефона', 20);
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) throw invalid('Укажите номер с кодом страны, например +79991234567.');
    result.phone = phone;
  }
  const oldStage = existing.stage;
  const stage = Object.hasOwn(changes, 'stage') ? changes.stage : oldStage;
  if (stage !== 'pregnancy' && stage !== 'mother') throw invalid('Выберите этап.');
  if (stage !== oldStage && !Object.hasOwn(changes, 'goals')) throw invalid('Выберите цели для нового этапа.');
  if (oldStage === 'pregnancy' && stage === 'mother' && confirmMother !== true) {
    throw invalid('Подтвердите рождение малыша и укажите дату рождения.');
  }
  if (Object.hasOwn(changes, 'goals')) {
    const goals = changes.goals;
    if (!Array.isArray(goals) || goals.length < 1 || goals.length > 7 ||
      goals.some(goal => !Number.isInteger(goal) || goal < 0 || goal > 6) || new Set(goals).size !== goals.length) {
      throw invalid('Выберите хотя бы одну цель.');
    }
    result.goals = [...goals];
  }
  if (stage === 'pregnancy') {
    if (Object.hasOwn(changes, 'birthDate')) throw invalid('Дата рождения малыша доступна на этапе материнства.');
    if (oldStage !== stage && !Object.hasOwn(changes, 'dueDate')) throw invalid('Укажите ПДР.');
    if (Object.hasOwn(changes, 'dueDate')) {
      const normalized = normalizeProfile({ name: result.name, stage, method: 'due', due: changes.dueDate, goals: result.goals }, now);
      result.dueDate = normalized.dueDate;
      result.method = 'due';
    }
    if (oldStage !== stage) result.birthDate = null;
  } else {
    if (Object.hasOwn(changes, 'dueDate')) throw invalid('ПДР доступна на этапе беременности.');
    if (oldStage !== stage && !Object.hasOwn(changes, 'birthDate')) throw invalid('Укажите дату рождения малыша.');
    if (Object.hasOwn(changes, 'birthDate')) {
      const normalized = normalizeProfile({ name: result.name, stage, birth: changes.birthDate, goals: result.goals }, now);
      result.birthDate = normalized.birthDate;
    }
    if (oldStage !== stage) { result.dueDate = null; result.method = null; }
  }
  result.stage = stage;
  return result;
}

export function normalizeProfile(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Проверьте данные профиля.');
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw invalid('Укажите имя до 80 символов.');
  if (data.stage !== 'pregnancy' && data.stage !== 'mother') throw invalid('Выберите этап: беременность или материнство.');
  if (!Array.isArray(data.goals) || data.goals.length < 1 || data.goals.length > 7 ||
      data.goals.some(goal => !Number.isInteger(goal) || goal < 0 || goal > 6) ||
      new Set(data.goals).size !== data.goals.length) throw invalid('Выберите хотя бы одну цель.');
  const today = moscowToday(now);
  let dueDate = null, birthDate = null, method = null;
  if (data.stage === 'pregnancy') {
    method = data.method;
    let gestationalDays;
    if (method === 'conception') {
      const conception = calendarDate(data.conception, 'дату зачатия');
      if (conception > today) throw invalid('Дата зачатия не может быть в будущем.');
      gestationalDays = (today - conception) / DAY + 14;
      dueDate = iso(conception + 266 * DAY);
    } else if (method === 'due') {
      const due = calendarDate(data.due, 'предполагаемую дату родов');
      gestationalDays = 280 - (due - today) / DAY;
      dueDate = iso(due);
    } else if (method === 'weeks') {
      const weeks = integer(data.weeks, 0, 42), days = integer(data.days, 0, 6);
      if (weeks === null || days === null) throw invalid('Укажите срок в неделях и днях.');
      gestationalDays = weeks * 7 + days;
      dueDate = iso(today + (280 - gestationalDays) * DAY);
    } else throw invalid('Выберите способ расчёта срока беременности.');
    if (!Number.isInteger(gestationalDays) || gestationalDays < 0 || gestationalDays > 300) {
      throw invalid('Проверьте срок беременности: допустимо от 0 до 42 недель и 6 дней.');
    }
  } else {
    const birth = calendarDate(data.birth, 'дату рождения малыша');
    if (birth < Date.UTC(1900, 0, 1) || birth > today) throw invalid('Укажите прошедшую дату рождения малыша.');
    birthDate = iso(birth);
  }
  return { name, stage: data.stage, method, dueDate, birthDate, goals: [...data.goals], completedAt: new Date(now).toISOString() };
}
