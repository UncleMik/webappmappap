const DAY = 86400000;
export const isoDate = value => new Date(value).toISOString().slice(0, 10);
export function todayDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => Number(parts.find(item => item.type === type).value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}
export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && isoDate(parsed) === value ? parsed : NaN;
}
export const formatDate = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(typeof value === 'string' ? parseDate(value) : value);
export function pregnancyDate(state, now = Date.now()) {
  const today = todayDate(now);
  let days, due;
  if (state.method === 'weeks') {
    if (!/^\d{1,2}$/.test(String(state.weeks)) || !/^\d$/.test(String(state.days))) return null;
    const w = Number(state.weeks), d = Number(state.days);
    if (w < 0 || w > 42 || d < 0 || d > 6) return null;
    days = w * 7 + d; due = today + (280 - days) * DAY;
  } else if (state.method === 'due') {
    due = parseDate(state.due); days = 280 - (due - today) / DAY;
  } else if (state.method === 'conception') {
    const conception = parseDate(state.conception);
    if (conception > today) return null;
    due = conception + 266 * DAY; days = (today - conception) / DAY + 14;
  } else return null;
  return Number.isInteger(days) && Number.isFinite(due) && days >= 0 && days <= 300 ? { days, due } : null;
}
export function profileTiming(profile, now = Date.now()) {
  if (!profile?.completedAt) return null;
  if (profile.stage === 'pregnancy') {
    const due = parseDate(profile.dueDate);
    if (!Number.isFinite(due)) return null;
    const days = 280 - (due - todayDate(now)) / DAY;
    // Due date alone never switches the account to motherhood.
    const week = Math.max(1, Math.min(42, Math.floor(days / 7)));
    return { week, label: `${Math.max(0, Math.floor(days / 7))} нед. и ${Math.max(0, days % 7)} дн.`, dueDate: profile.dueDate };
  }
  const birth = parseDate(profile.birthDate), current = new Date(todayDate(now));
  if (!Number.isFinite(birth) || birth > +current) return null;
  const date = new Date(birth);
  let months = (current.getUTCFullYear() - date.getUTCFullYear()) * 12 + current.getUTCMonth() - date.getUTCMonth();
  if (current.getUTCDate() < date.getUTCDate()) months--;
  return { week: null, label: months < 1 ? 'Малышу меньше месяца' : `Малышу ${months} мес.`, birthDate: profile.birthDate };
}
export { returnPage } from './auth-return.js';
