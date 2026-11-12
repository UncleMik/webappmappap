import { authRequest } from './auth-client.js?v=20261109-pilot';

// No personal state is persisted in browser storage. Each response belongs to one session.
let generation = 0, account = null, ended = false, state = null, flight = null;
const listeners = new Set(), retries = new Map();
const changed = () => Object.assign(new Error('Аккаунт изменился. Обновите страницу.'), { code: 'account_changed' });
function sessionAccount() {
  return window.webprilSessionAccountId || window.webprilAccount?.user?.id || null;
}
function clear() {
  generation++; state = null; flight = null; account = null; retries.clear();
  for (const listener of listeners) listener(null);
}
async function identity() {
  if (ended) throw changed();
  const id = sessionAccount() || (await authRequest('session')).user?.id;
  if (!id) throw changed();
  if (account && id !== account) clear();
  account = id;
  return id;
}
async function request(path, body) {
  const id = await identity(), revision = generation;
  const result = await authRequest(path, body, { headers: { 'X-Webpril-Account': id } });
  if (ended || generation !== revision || account !== id || sessionAccount() && sessionAccount() !== id) throw changed();
  if (result.accountId && result.accountId !== id || result.state?.accountId && result.state.accountId !== id) { clear(); throw changed(); }
  return result;
}
function accept(value) {
  if (!value || value.accountId !== account) throw changed();
  state = state?.accountId === value.accountId ? {...state,...value} : value;
  for (const listener of listeners) listener(state);
  window.dispatchEvent(new CustomEvent('stars:state', { detail: state }));
  return state;
}
export function subscribe(listener) { listeners.add(listener); if (state) listener(state); return () => listeners.delete(listener); }
export function snapshot() { return state; }
export async function loadGamification() {
  if (flight) return flight;
  const task = Promise.all([request('gamification'),request('stars')]).then(([daily,stars]) => {
    if (daily.accountId !== stars.accountId) throw changed();
    return accept({...stars,...daily,enabled:daily.enabled || stars.enabled,dailyEnabled:daily.enabled,
      ...(!daily.enabled ? {today:null} : {})});
  });
  flight = task;
  try { return await task; } finally { if (flight === task) flight = null; }
}
function operationKey(path, body) { return path + ':' + JSON.stringify(body); }
export async function mutate(path, body) {
  await identity();
  const key = operationKey(path, body);
  let entry = retries.get(key);
  if (!entry) { entry = { requestId: crypto.randomUUID(), account, pending: null }; retries.set(key, entry); }
  if (entry.pending) return entry.pending;
  const task = (async () => {
    const result = await request(path, path === 'gamification/preferences' ? body : { ...body, requestId: entry.requestId });
    if (entry.account !== account) throw changed();
    if (result.state) accept(result.state);
    else if (result.accountId && result.enabled !== undefined) accept(result);
    else await loadGamification();
    retries.delete(key);
    return result;
  })();
  entry.pending = task;
  try { return await task; } catch (error) {
    // Retain the same requestId after uncertain transport errors; explicit rejection can be corrected.
    if (error.status && error.status < 500) retries.delete(key);
    throw error;
  } finally { entry.pending = null; }
}
export const action = body => mutate('gamification/actions', body);
export const preferences = body => mutate('gamification/preferences', body);
export const purchase = body => mutate('stars/purchase', body);
export const wallet = () => request('stars');
export const letters = () => request('gamification/letters');
window.addEventListener('account:change', () => {
  if (account && sessionAccount() !== account) clear();
});
window.addEventListener('webpril:session-ended', () => { ended = true; clear(); });
window.addEventListener('pagehide', clear);

export const aiQuota = () => request('ai/quota');

export const presentation = body => request('notifications/presentation',body);
export const visit = () => request('notifications/visit',{});

export const history = before => request('points' + (before ? '?' + new URLSearchParams({before}) : ''));

export const notificationState = () => request('notifications');
export const notificationAction = (path, body) => request('notifications/' + path,body);
