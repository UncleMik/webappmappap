import { snapshot as starsSnapshot, subscribe as subscribeStars } from './gamification-api.js?v=20261112-stars';
import { authRequest } from './auth-client.js?v=20261109-pilot';

const today = document.querySelector('#today');
const frame = window.frameElement;
const trigger = document.querySelector('#points-trigger');
const triggerBalance = document.querySelector('#points-trigger-balance');
const dialog = document.querySelector('#points-dialog');
const balance = document.querySelector('#points-balance');
const history = document.querySelector('#points-history');
const status = dialog.querySelector('.points-status');
const details = dialog.querySelector('.points-details');
const more = dialog.querySelector('.points-next');
const formatNumber = new Intl.NumberFormat('ru-RU');
const formatDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow',
});

let accountId;
let pilotOwned = starsSnapshot()?.enabled === true;
let enabled = false;
let ended = false;
let active = false;
let generation = 0;
let pending = false;
let nextCursor = null;
const seen = new Set();

function clearBalance() {
  if (!pilotOwned) triggerBalance.textContent = '';
  balance.querySelector('strong').textContent = '';
  balance.hidden = true;
}

function setExpanded(expanded) {
  history.classList.toggle('is-expanded', expanded);
  details.setAttribute('aria-expanded', String(expanded));
  details.textContent = expanded ? 'Свернуть' : 'Подробнее';
  more.hidden = !expanded || nextCursor === null;
}

function clearHistory() {
  history.replaceChildren();
  seen.clear();
  nextCursor = null;
  details.hidden = true;
  setExpanded(false);
}

function reset() {
  generation++;
  pending = false;
  enabled = false;
  accountId = undefined;
  if (!pilotOwned) {
    if (dialog.open) dialog.close();
    trigger.hidden = true;
  }
  clearBalance();
  clearHistory();
  status.textContent = '';
}

function renderPage(data) {
  const value = formatNumber.format(data.balance);
  triggerBalance.textContent = value;
  balance.querySelector('strong').textContent = value;
  balance.hidden = false;
  for (const row of data.history) {
    if (seen.has(row.id)) continue;
    const item = document.createElement('li');
    const label = document.createElement('span');
    const time = document.createElement('time');
    const amount = document.createElement('strong');
    label.textContent = row.kind === 'weekly_poll' ? 'Голосование недели' : row.kind === 'video_watch' ? 'Просмотр бесплатного видео' : row.kind === 'article_read' ? 'Прочтение статьи' : 'Первое сообщение в Клубе за день';
    time.dateTime = row.occurredAt;
    time.textContent = formatDate.format(new Date(row.occurredAt)) + ' МСК';
    amount.textContent = '+' + formatNumber.format(row.amount);
    item.append(label, time, amount);
    history.append(item);
    seen.add(row.id);
  }
  nextCursor = data.nextCursor;
  details.hidden = history.children.length <= 3 && nextCursor === null;
  more.hidden = !history.classList.contains('is-expanded') || nextCursor === null;
  more.textContent = 'Показать ещё';
  status.textContent = history.children.length ? '' : 'Начислений пока нет.';
}

function matchesSession(expected) {
  const local = window.webprilSessionAccountId;
  const parent = frame ? window.parent.webprilSessionAccountId : undefined;
  return !!expected && (!local || local === expected) && (!parent || parent === expected);
}

async function load(before = null) {
  if (!active || ended || pending || pilotOwned) return;
  const request = ++generation;
  const current = () => request === generation && active && !ended && !pilotOwned;
  pending = true;
  if (before === null) {
    clearHistory();
    clearBalance();
  }
  more.disabled = true;
  status.textContent = before === null ? 'Загружаем баланс и историю…' : 'Загружаем ещё начисления…';
  try {
    const sessionAccount = window.webprilSessionAccountId;
    const expected = accountId || sessionAccount || (await authRequest('session')).user?.id;
    if (!current()) return;
    if (!matchesSession(expected)) { reset(); return; }
    accountId = expected;
    const query = before === null ? '' : '?' + new URLSearchParams({ before });
    const data = await authRequest('points' + query, undefined, { headers: { 'X-Webpril-Account': expected } });
    if (!current()) return;
    if (data.accountId !== expected || !matchesSession(expected)) { reset(); return; }
    if (data.enabled !== true) { reset(); return; }
    renderPage(data);
    enabled = true;
    trigger.hidden = false;
  } catch (error) {
    if (!current()) return;
    if (error.status === 401 || error.status === 403 || error.code === 'account_changed') { reset(); return; }
    status.textContent = before === null
      ? 'Не удалось загрузить баланс и историю.'
      : 'Не удалось загрузить следующие начисления.';
    more.hidden = !enabled;
    more.textContent = 'Повторить';
  } finally {
    if (current()) {
      pending = false;
      more.disabled = false;
    }
  }
}

function syncActivity() {
  const visible = !document.hidden && !today.hidden && !frame?.hidden;
  if (active === visible) return;
  active = visible;
  if (active) void load();
  else { if (dialog.open) dialog.close(); reset(); }
}

trigger.addEventListener('click', () => {
  if(pilotOwned){window.dispatchEvent(new CustomEvent('stars:open',{detail:{tab:'wallet'}}));return;}
  if (!active || ended || !enabled || dialog.open) return;
  generation++;
  pending = false;
  dialog.showModal();
  dialog.scrollTop = 0;
  void load();
});
dialog.querySelector('.points-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientY < rect.top || event.clientY > rect.bottom || event.clientX < rect.left || event.clientX > rect.right) dialog.close();
});
details.addEventListener('click', () => {
  setExpanded(!history.classList.contains('is-expanded'));
});
more.addEventListener('click', () => void load(nextCursor));
window.addEventListener('webpril:session-ended', () => {
  ended = true;
  if (dialog.open) dialog.close();
  reset();
});
window.addEventListener('pagehide', () => {
  active = false;
  if (dialog.open) dialog.close();
  reset();
});
subscribeStars(value => {
  const next = value?.enabled === true;
  if (next === pilotOwned) return;
  pilotOwned = next;
  if (next && dialog.open && !dialog.classList.contains('stars-dialog')) dialog.close();
  reset();
  if (!next && active && !ended) void load();
});
window.addEventListener('account:change', () => {
  const current = window.webprilSessionAccountId || window.webprilAccount?.user?.id;
  if (accountId && accountId !== current) {
    reset();
    if (active && !pilotOwned && !ended) void load();
  }
});
window.addEventListener('pageshow', syncActivity);
document.addEventListener('visibilitychange', syncActivity);
const observer = new MutationObserver(syncActivity);
observer.observe(today, { attributes: true, attributeFilter: ['hidden'] });
if (frame) observer.observe(frame, { attributes: true, attributeFilter: ['hidden'] });
syncActivity();
