import { authRequest } from './auth-client.js?v=20261109-pilot';
import { clubRequest, chatLease } from './club-api.js?v=20261105-rooms';
import { clubRooms } from './club-rooms.js?v=20261105-rooms';

const frame = window.frameElement;
const today = document.querySelector('#today');
const triggers = document.querySelectorAll('[data-notifications-trigger]');
const dialog = document.createElement('dialog');
dialog.id = 'notifications-dialog';
dialog.className = 'notifications-dialog';
dialog.setAttribute('aria-labelledby', 'notifications-title');
dialog.innerHTML = `
  <header class="notifications-heading">
    <h2 id="notifications-title">Уведомления</h2>
    <button type="button" class="close-button notifications-close" aria-label="Закрыть" autofocus>
      <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button>
  </header>
  <div class="notifications-content">
    <p class="notifications-status" role="status"></p>
    <section aria-labelledby="notification-announcements-title" hidden>
      <h3 id="notification-announcements-title">Объявления школы</h3>
      <ul id="notification-announcements"></ul>
    </section>
    <section aria-labelledby="notification-messages-title" hidden>
      <h3 id="notification-messages-title">Новые сообщения</h3>
      <ul id="notification-messages"></ul>
    </section>
    <section aria-labelledby="notification-points-title" hidden>
      <h3 id="notification-points-title">Начисления баллов</h3>
      <ul id="notification-points"></ul>
    </section>
    <button type="button" class="notifications-retry" hidden>Обновить</button>
  </div>`;
document.body.append(dialog);

const status = dialog.querySelector('.notifications-status');
const announcements = dialog.querySelector('#notification-announcements');
const messages = dialog.querySelector('#notification-messages');
const points = dialog.querySelector('#notification-points');
const retry = dialog.querySelector('.notifications-retry');
const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const plurals = new Intl.PluralRules('ru');
const pointLabels = new Map([
  ['club_message', 'Первое сообщение в Клубе за день'],
  ['article_read', 'Прочтение статьи'],
  ['video_watch', 'Просмотр бесплатного видео'],
]);

let generation = 0, controller, expiry, ended = false;
const visible = () => !document.hidden && !frame?.hidden && !today?.hidden;
const sameAccount = id => [window.webprilSessionAccountId, frame && window.parent.webprilSessionAccountId]
  .every(current => !current || current === id);
const lostSession = error => error?.status === 401 || error?.code === 'account_changed';

function setItems(list, items) {
  list.replaceChildren(...items);
  list.parentElement.hidden = items.length === 0;
}

function reset() {
  generation++;
  controller?.abort();
  clearTimeout(expiry);
  setItems(messages, []);
  setItems(points, []);
  setItems(announcements, []);
  status.textContent = '';
  retry.hidden = true;
}

function dismiss() {
  reset();
  if (dialog.open) dialog.close();
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function pointItem(row) {
  const item = document.createElement('li');
  const copy = document.createElement('div');
  const time = element('time', dates.format(new Date(row.occurredAt)) + ' МСК');
  time.dateTime = row.occurredAt;
  copy.append(element('strong', pointLabels.get(row.kind) || 'Начисление баллов'), time);
  const amount = element('span', '+' + row.amount);
  amount.className = 'notifications-amount';
  item.append(copy, amount);
  return item;
}

function messageItem(room, count) {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = 'club-chat.html?room=' + encodeURIComponent(room.id);
  const word = { one: 'новое сообщение', few: 'новых сообщения', many: 'новых сообщений' }[plurals.select(count)];
  link.append(element('strong', room.kind === 'experts' ? 'Экспертный чат · ' + room.title : room.title),
    element('span', count + ' ' + word));
  item.append(link);
  return item;
}

function announcementItem(row) {
  const item = document.createElement('li');
  const copy = document.createElement('div');
  const time = element('time', dates.format(new Date(row.publishedAt)) + ' МСК');
  time.dateTime = row.publishedAt;
  const body = element('p', row.body);
  body.className = 'notification-announcement-body';
  copy.append(element('strong', row.title), body, time);
  if (row.link) {
    try {
      const url = new URL(row.link, location.origin);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const link = element('a', 'Открыть ссылку');
        link.href = url.href;
        copy.append(link);
      }
    } catch { /* An invalid link does not hide the announcement. */ }
  }
  item.append(copy);
  return item;
}

async function load() {
  reset();
  const request = generation;
  const current = () => request === generation && dialog.open && visible() && !ended;
  controller = new AbortController();
  status.textContent = 'Загружаем уведомления…';
  try {
    const session = window.webprilSessionAccountId || (await authRequest('session')).user?.id;
    if (!current()) return;
    if (!session || !sameAccount(session)) { dismiss(); return; }
    const started = performance.now();
    const [wallet, club, school] = await Promise.allSettled([
      authRequest('points', undefined, { headers: { 'X-Webpril-Account': session } }),
      clubRequest('club', { accountId: session, signal: controller.signal }),
      authRequest('announcements', undefined, { headers: { 'X-Webpril-Account': session } }),
    ]);
    if (!current()) return;
    if (!sameAccount(session) || [wallet, school].some(result => result.status === 'fulfilled' && result.value?.accountId !== session) ||
        [wallet, club, school].some(result => result.status === 'rejected' && lostSession(result.reason))) {
      dismiss();
      return;
    }

    const history = wallet.value?.history;
    const walletFailed = wallet.status === 'rejected' || wallet.value?.enabled === true && !Array.isArray(history);
    const schoolRows = school.value?.announcements;
    const schoolFailed = !Array.isArray(schoolRows);
    setItems(announcements, (Array.isArray(schoolRows) ? schoolRows : [])
      .filter(row => typeof row?.title === 'string' && typeof row?.body === 'string' && Number.isFinite(Date.parse(row.publishedAt)))
      .map(announcementItem));
    setItems(points, (Array.isArray(history) ? history : [])
      .filter(row => Number.isSafeInteger(row?.amount) && row.amount > 0 && Number.isFinite(Date.parse(row.occurredAt)))
      .map(pointItem));

    const rooms = club.value?.rooms;
    const items = [];
    let remaining = Infinity;
    let clubFailed = !Array.isArray(rooms) && club.reason?.code !== 'onboarding_required';
    for (const definition of clubRooms) {
      const room = Array.isArray(rooms) ? rooms.find(entry => entry?.id === definition.id) : null;
      if (room?.access === 'temporarily_unavailable') clubFailed = true;
      const count = room?.readState?.unreadCount ?? room?.unreadCount;
      if (room?.allowed !== true || room.access !== 'available' || !Number.isSafeInteger(count) || count <= 0) continue;
      try {
        const lease = chatLease({ ...room, accountId: session, responseAgeMs: performance.now() - started }, session);
        remaining = Math.min(remaining, lease);
        items.push(messageItem(definition, count));
      } catch { clubFailed = true; }
    }
    setItems(messages, items);
    const failed = walletFailed || clubFailed || schoolFailed;
    status.textContent = walletFailed && clubFailed && schoolFailed ? 'Не удалось загрузить уведомления.' :
      failed ? 'Часть уведомлений пока недоступна.' :
      points.children.length || items.length || announcements.children.length ? '' : 'Пока нет уведомлений.';
    retry.hidden = !failed;
    if (Number.isFinite(remaining)) expiry = setTimeout(() => {
      if (!current()) return;
      setItems(messages, []);
      status.textContent = 'Обновите уведомления, чтобы проверить новые сообщения.';
      retry.hidden = false;
    }, remaining);
  } catch {
    if (!current()) return;
    status.textContent = 'Не удалось загрузить уведомления.';
    retry.hidden = false;
  }
}

for (const button of triggers) button.addEventListener('click', () => {
  if (dialog.open || ended || !visible()) return;
  dialog.showModal();
  dialog.scrollTop = 0;
  void load();
});
dialog.querySelector('.notifications-close').addEventListener('click', dismiss);
dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientY < rect.top || event.clientX < rect.left || event.clientX > rect.right) dismiss();
});
retry.addEventListener('click', load);
addEventListener('webpril:session-ended', () => { ended = true; dismiss(); });
addEventListener('pagehide', dismiss);
const closeIfHidden = () => { if (!visible()) dismiss(); };
document.addEventListener('visibilitychange', closeIfHidden);
const observer = new MutationObserver(closeIfHidden);
if (today) observer.observe(today, { attributes: true, attributeFilter: ['hidden'] });
if (frame) observer.observe(frame, { attributes: true, attributeFilter: ['hidden'] });
