import { returnPage } from './auth-return.js';
import { authRequest } from './auth-client.js';

const emailForm = document.querySelector('#email-form'), codeForm = document.querySelector('#code-form');
const email = document.querySelector('#email'), code = document.querySelector('#code');
const status = document.querySelector('#login-status'), title = document.querySelector('#login-title');
const intro = document.querySelector('#login-intro'), signedIn = document.querySelector('#signed-in');
const resend = document.querySelector('#resend-code'), verify = document.querySelector('#verify-button');
let challenge, sentEmail, busy = false, retryAt = 0, completeRetryAt = 0, pending = false;
const nextPage = location.hash.startsWith('#next=') ? location.hash.slice(6) : new URLSearchParams(location.search).get('next');
signedIn.querySelector('a').href = returnPage(nextPage);
function cooldown(seconds) { retryAt = Math.max(retryAt, Date.now() + seconds * 1000); refresh(); }
function refresh() {
  document.querySelectorAll('form button, #logout').forEach(button => { button.disabled = busy; });
  const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  resend.disabled = busy || remaining > 0;
  resend.textContent = remaining > 0 ? `Новый код через ${remaining} с` : 'Отправить код ещё раз';
  email.readOnly = busy; code.readOnly = busy;
  const completeWait = Math.max(0, Math.ceil((completeRetryAt - Date.now()) / 1000));
  verify.disabled = busy || (pending && completeWait > 0);
  verify.textContent = busy ? 'Подождите…' : pending && completeWait > 0 ? `Повторить через ${completeWait} с` : pending ? 'Повторить завершение регистрации' : 'Войти';
  document.querySelector('#code-fields').hidden = pending;
  code.required = !pending;
}
function showError(error) {
  status.textContent = error.message;
  if (error.retryAfter && error.code !== 'getcourse_pending') cooldown(error.retryAfter);
  if (error.code === 'getcourse_pending') {
    pending = true; completeRetryAt = Date.now() + (error.retryAfter || 5) * 1000;
    title.textContent = 'Почта подтверждена'; intro.textContent = 'Осталось завершить регистрацию в школе.';
  }
  if (['invalid_code', 'invalid_challenge'].includes(error.code)) {
    pending = false; code.value = ''; title.textContent = 'Проверьте почту'; intro.textContent = 'Введите код из письма, чтобы продолжить.';
  }
}
async function task(run) {
  if (busy) return;
  busy = true; status.textContent = ''; refresh();
  try { await run(); } catch (error) { showError(error); }
  finally { busy = false; refresh(); }
}
function authenticated(user) {
  if (!user.profile?.completedAt) {
    const onboarding = new URL('onboarding.html', location.href);
    if (nextPage) onboarding.searchParams.set('next', nextPage);
    window.top.location.replace(onboarding.href); return;
  }
  window.top.location.replace(returnPage(nextPage));

  emailForm.hidden = true; codeForm.hidden = true; signedIn.hidden = false;
  document.querySelector('#account-email').textContent = user.email;
  title.textContent = 'Вы вошли'; intro.textContent = 'Вход сохранён на этом устройстве до 30 дней. На чужом устройстве выйдите после работы.';
  code.value = ''; challenge = undefined; pending = false; status.textContent = ''; title.focus();
}
async function requestCode() {
  const address = email.value.trim();
  const result = await authRequest('request', { email: address });
  challenge = result.challenge; sentEmail = address; pending = false;
  emailForm.hidden = true; codeForm.hidden = false; signedIn.hidden = true;
  title.textContent = 'Проверьте почту'; intro.textContent = 'Введите код из письма, чтобы продолжить.';
  document.querySelector('#sent-email').textContent = sentEmail;
  cooldown(result.retryAfter); code.value = ''; code.focus();
}
emailForm.addEventListener('submit', event => { event.preventDefault(); task(requestCode); });
resend.addEventListener('click', () => task(requestCode));
document.querySelector('#change-email').addEventListener('click', () => {
  challenge = undefined; pending = false; code.value = ''; codeForm.hidden = true; emailForm.hidden = false;
  title.textContent = 'Рады видеть вас'; intro.textContent = 'Войдите или создайте аккаунт по электронной почте. Пароль не нужен.';
  status.textContent = ''; refresh(); email.focus();
});
codeForm.addEventListener('submit', event => {
  event.preventDefault();
  task(async () => {
    const result = await authRequest(pending ? 'complete' : 'verify', { challenge, ...(pending ? {} : { code: code.value }) });
    authenticated(result.user);
  });
});
document.querySelector('#logout').addEventListener('click', () => task(async () => {
  await authRequest('logout', {}); location.reload();
}));
let timer;
function startTimer() {
  refresh();
  if (timer === undefined) timer = setInterval(refresh, 1000);
}
startTimer();
addEventListener('pagehide', () => { clearInterval(timer); timer = undefined; });
addEventListener('pageshow', startTimer);
if (location.hostname === 'unclemik.github.io') {
  emailForm.hidden = true;
  intro.textContent = 'Вход и регистрация работают на основном сайте приложения.';
  const link = document.createElement('a'); link.href = 'https://app.legkie-rody.ru/login.html';
  link.className = 'auth-button login-primary'; link.textContent = 'Войти или зарегистрироваться'; emailForm.after(link);
} else {
  task(async () => {
    const session = await authRequest('session');
    if (session.authenticated) authenticated(session.user);
    else if (session.reason === 'session_replaced' || new URLSearchParams(location.search).get('reason') === 'session_replaced') {
      status.textContent = 'Выполнен вход в другом браузере или на другом устройстве. Войдите заново.';
    }
  });
}
