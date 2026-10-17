import { authRequest } from './auth-client.js';
const section = document.querySelector('#account-access');
const link = section.querySelector('a'), button = section.querySelector('button'), message = section.querySelector('p');
if (location.hostname === 'app.legkie-rody.ru' || ['localhost', '127.0.0.1'].includes(location.hostname)) {
  authRequest('session').then(session => {
    section.hidden = false;
    if (!session.authenticated) return;
    message.textContent = `Вы вошли: ${session.user.email}`; link.hidden = true; button.hidden = false;
  }).catch(() => { /* Keep an honest sign-in link while the backend is unavailable. */ });
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try { await authRequest('logout', {}); location.reload(); }
  catch { message.textContent = 'Не удалось выйти. Проверьте интернет и повторите.'; button.disabled = false; }
});
