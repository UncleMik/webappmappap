import { authRequest } from './auth-client.js';
import { profileTiming, formatDate } from './profile-dates.js';

const pregnancyGoals = ['Спокойно пройти беременность', 'Подготовиться к родам', 'Понимать развитие малыша', 'Подготовить тело к родам', 'Разобраться с анализами', 'Справиться с тревогой', 'Подготовиться к первым дням с малышом'];
const motherGoals = ['Восстановиться после родов', 'Наладить грудное вскармливание', 'Разобраться с уходом за малышом', 'Наладить сон малыша и свой сон', 'Вернуться к физической активности', 'Справиться со стрессом', 'Общаться с мамами и делиться опытом'];
let revision = 0;
let resolveInitialProfile;
window.webprilProfileReady = new Promise(resolve => { resolveInitialProfile = resolve; });
function render(user) {
  const profile = user?.profile?.completedAt ? user.profile : null;
  const timing = profileTiming(profile);
  window.webprilAccount = { user, profile, ...timing };
  document.documentElement.classList.toggle('account-stage-mother', profile?.stage === 'mother');
  document.querySelectorAll('[data-account-name]').forEach(element => { element.textContent = profile?.name || 'Мой аккаунт'; });
  document.querySelectorAll('[data-profile-name]').forEach(element => { element.textContent = profile?.name || '—'; });
  document.querySelectorAll('[data-account-summary]').forEach(element => {
    element.textContent = timing ? timing.label + (profile.stage === 'pregnancy' ? ` · ПДР ${formatDate(profile.dueDate)}` : ` · ${formatDate(profile.birthDate)}`) : '';
  });
  document.querySelectorAll('[data-account-stage]').forEach(element => { element.textContent = profile?.stage === 'mother' ? 'Я уже мама' : 'Мой срок беременности'; });
  document.querySelectorAll('[data-profile-banner]').forEach(element => { element.hidden = !profile; });
  document.querySelectorAll('[data-profile-goals]').forEach(element => {
    const goals = profile?.stage === 'mother' ? motherGoals : pregnancyGoals;
    element.textContent = profile ? profile.goals.map(id => goals[id]).filter(Boolean).join(' · ') : '';
  });
  const greeting = document.querySelector('.greeting');
  if (greeting) greeting.firstChild.textContent = profile ? `Рады видеть вас, ${profile.name}! ` : 'Рады видеть вас! ';
  const summary = document.querySelector('#today .pregnancy-summary');
  if (summary) {
    summary.querySelector('.pregnancy-age').textContent = profile?.stage === 'pregnancy' ? timing.label : 'Материалы по неделям беременности';
    summary.querySelector('.section-description').textContent = profile?.stage === 'pregnancy' ? `ПДР: ${formatDate(profile.dueDate)}` : 'Библиотека школы';
    summary.href = profile?.stage === 'pregnancy' ? `journey.html?week=${timing.week}` : 'journey.html';
  }
  window.dispatchEvent(new CustomEvent('account:change', { detail: window.webprilAccount }));
  resolveInitialProfile();
}
async function refresh() {
  const current = ++revision;
  try {
    const session = await authRequest('session');
    if (current !== revision) return;
    const user = session.authenticated === true && session.user?.id ? session.user : null;
    if (user && !user.profile?.completedAt) {
      window.top.location.replace(new URL('onboarding.html', location.href).href); return;
    }
    render(user);
  } catch {
    if (current === revision) render(null);
  }
}
if (location.hostname === 'app.legkie-rody.ru' || ['localhost', '127.0.0.1'].includes(location.hostname)) {
  refresh();
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
} else { render(null); }
