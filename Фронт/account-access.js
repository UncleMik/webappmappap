import { authRequest } from './auth-client.js';
const section = document.querySelector('#account-access');
const link = section?.querySelector('a'), message = section?.querySelector('p');
const emails = document.querySelectorAll('[data-account-email]');
const buttons = document.querySelectorAll('[data-account-logout]');
let revision = 0;
function render(session, failed = false) {
  const user = session?.authenticated === true && typeof session.user?.id === 'string' &&
    typeof session.user.email === 'string' ? session.user : null;
  if (section) section.hidden = false;
  if (message) message.textContent = failed ? 'Не удалось проверить вход. Обновите страницу.'
    : user ? `Вы вошли: ${user.email}` : 'Войдите или создайте аккаунт по электронной почте.';
  if (link) link.hidden = Boolean(user);
  emails.forEach(element => { element.textContent = user?.email || '—'; });
  buttons.forEach(button => { button.hidden = !user; });
}
async function refresh() {
  const current = ++revision;
  try {
    const session = await authRequest('session');
    if (current === revision) render(session);
  } catch {
    if (current === revision) render(null, true);
  }
}
buttons.forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    await authRequest('logout', {});
    ++revision;
    render(null);
    // Discard every preserved section, including those inside app-navigation iframes.
    window.top.location.assign(new URL('login.html', location.href).href);
  } catch {
    if (message) message.textContent = 'Не удалось выйти. Проверьте интернет и повторите.';
    button.disabled = false;
  }
}));
if (location.hostname === 'app.legkie-rody.ru' || ['localhost', '127.0.0.1'].includes(location.hostname)) {
  refresh();
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
} else {
  render(null);
}
