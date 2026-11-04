import { clubRequest, chatLease } from './club-api.js?v=20261030-delete';

const status = document.querySelector('#club-access-status');
const link = document.querySelector('#club-access-link');
const retry = document.querySelector('#club-access-retry');
const unread = document.querySelector('#club-unread');
let revision = 0, controller, timer, accountId, ended = false;
function clear() {
  revision++; controller?.abort(); clearTimeout(timer); link.removeAttribute('href');
  unread.hidden = true; unread.textContent = '';
}
async function refresh() {
  clear();
  if (document.hidden || ended) return;
  const current = revision; controller = new AbortController();
  status.textContent = 'Проверяем доступ к чату…'; retry.hidden = true;
  try {
    const data = await clubRequest('club', { accountId, signal: controller.signal });
    if (current !== revision) return;
    const remaining = chatLease(data, accountId); accountId = data.accountId;
    if (!['available', 'purchase_required'].includes(data.access)) throw new Error('Не удалось проверить доступ.');
    status.textContent = data.access === 'available' ? 'Общение с участницами курса' : 'Доступен ученицам курса «Лёгкие роды»';
    link.href = data.access === 'available' ? 'club-chat.html?room=pregnancy-students' : 'courses.html';
    const count = data.access === 'available' && Number.isSafeInteger(data.readState?.unreadCount) ? data.readState.unreadCount : 0;
    unread.textContent = count > 99 ? '99+' : String(count);
    unread.setAttribute('aria-label', 'Непрочитанных сообщений: ' + count); unread.hidden = count <= 0;
    timer = setTimeout(refresh, Math.min(remaining, 15_000));
  } catch (error) {
    if (current !== revision) return;
    status.textContent = error.message; retry.hidden = false;
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
window.addEventListener('webpril:session-ended', () => { ended = true; clear(); status.textContent = ''; });
refresh();
