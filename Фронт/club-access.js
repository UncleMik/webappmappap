import { clubRequest, chatLease } from './club-api.js?v=20261105-rooms';
import { clubRooms } from './club-rooms.js?v=20261105-rooms';

const status = document.querySelector('#club-access-status');
const retry = document.querySelector('#club-access-retry');
const rows = new Map();
let revision = 0, controller, timer, accountId, ended = false;
for (const room of clubRooms) {
  const row = document.createElement('a'); row.className = 'community-row club-entry'; row.dataset.room = room.id;
  const icon = document.createElement('span'); icon.className = 'community-icon people'; const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', room.kind === 'experts' ? '#crown' : '#people'); svg.append(use); icon.append(svg); icon.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span'); copy.className = 'community-copy';
  const title = document.createElement('strong'); title.textContent = room.title;
  const description = document.createElement('span'); description.textContent = 'Проверяем доступ…';
  const unread = document.createElement('span'); unread.className = 'unread'; unread.hidden = true;
  const lock = document.createElement('span'); lock.className = 'club-room-lock'; lock.hidden = true; lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', 'Нужна покупка курса');
  const lockSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const lockUse = document.createElementNS('http://www.w3.org/2000/svg', 'use'); lockUse.setAttribute('href', '#lock'); lockSvg.setAttribute('viewBox', '0 0 16 20'); lockSvg.setAttribute('aria-hidden', 'true'); lockSvg.append(lockUse); lock.append(lockSvg);
  copy.append(title, description); row.append(icon, copy, lock, unread);
  document.querySelector(room.kind === 'experts' ? '#club-expert-rooms' : room.id.startsWith('pregnancy-') ? '#club-pregnancy-rooms' : '#club-mother-rooms').append(row);
  rows.set(room.id, { row, description, lock, unread });
}
function clear() {
  revision++; controller?.abort(); clearTimeout(timer);
  for (const { row, lock, unread } of rows.values()) { lock.hidden = true; row.removeAttribute('href'); unread.hidden = true; unread.textContent = ''; }
}
async function refresh() {
  clear();
  if (document.hidden || ended) return;
  const current = revision; controller = new AbortController();
  status.textContent = 'Проверяем доступ к чатам…'; retry.hidden = true;
  try {
    const data = await clubRequest('club', { accountId, signal: controller.signal });
    if (current !== revision) return;
    if (typeof data.accountId !== 'string' || !Array.isArray(data.rooms)) throw new Error('Не удалось проверить доступ к чатам.');
    accountId = data.accountId;
    let remaining = 15_000, failed = false;
    for (const definition of clubRooms) {
      const { row, description, lock, unread } = rows.get(definition.id);
      const matches = data.rooms.filter(item => item.id === definition.id);
      const room = matches.length === 1 ? matches[0] : null;
      try {
        if (!room || !['available', 'purchase_required', 'temporarily_unavailable'].includes(room.access)) throw new Error();
        if (room.access === 'temporarily_unavailable') throw new Error();
        remaining = Math.min(remaining, chatLease({ ...room, accountId, responseAgeMs: data.responseAgeMs }, accountId));
        if (room.allowed === true && room.access === 'available') {
          description.textContent = definition.kind === 'experts' ? 'Общение с экспертами школы' : 'Общение и поддержка участниц';
          row.href = 'club-chat.html?room=' + definition.id;
          const count = room.readState?.unreadCount ?? room.unreadCount;
          if (Number.isSafeInteger(count) && count > 0) {
            unread.textContent = count > 99 ? '99+' : String(count); unread.hidden = false;
            unread.setAttribute('aria-label', 'Непрочитанных сообщений: ' + count);
          }
        } else if (room.access === 'purchase_required' && definition.kind === 'experts') {
          description.textContent = 'Доступны при действующей покупке любого курса'; lock.hidden = false; row.href = 'courses.html';
        } else throw new Error();
      } catch {
        description.textContent = 'Не удалось проверить доступ. Повторите попытку.'; failed = true;
      }
    }
    status.textContent = failed ? 'Доступ к некоторым чатам пока не подтверждён.' : '';
    retry.hidden = !failed; timer = setTimeout(refresh, remaining);
  } catch (error) {
    if (current !== revision) return;
    status.textContent = error.message; retry.hidden = false;
    for (const { description } of rows.values()) description.textContent = 'Доступ пока не подтверждён';
    if (error.status === 401 || error.code === 'account_changed') window.webprilSessionGate?.end();
    else timer = setTimeout(refresh, 15_000);
  }
  document.dispatchEvent(new Event('club:entries-changed'));
}
retry.addEventListener('click', refresh);
window.addEventListener('focus', refresh);
window.addEventListener('online', refresh);
document.addEventListener('visibilitychange', refresh);
window.addEventListener('pagehide', clear);
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
window.addEventListener('webpril:session-ended', () => { ended = true; clear(); status.textContent = ''; for (const { description } of rows.values()) description.textContent = ''; });
refresh();
