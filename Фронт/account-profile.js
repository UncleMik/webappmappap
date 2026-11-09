import { authRequest } from './auth-client.js';
import { profileTiming, formatDate } from './profile-dates.js';

const russianPlural = new Intl.PluralRules('ru');
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
  document.querySelectorAll('[data-profile-field]').forEach(element => {
    const key = element.dataset.profileField;
    element.textContent = profile?.[key] ? (key === 'birthday' ? formatDate(profile[key]) : profile[key]) : (key === 'phone' ? 'Не указан' : '—');
  });
  document.querySelectorAll('[data-account-photo]').forEach(element => {
    const version = profile?.photoVersion || '';
    const key = `${user?.id || ''}:${version}`;
    if (element.profilePhotoKey === key) return;
    element.profilePhotoKey = key;
    element.profilePlaceholder ??= element.innerHTML;
    element.setAttribute('aria-label', version ? 'Фото профиля' : 'Фото пока не добавлено');
    if (!version) { element.innerHTML = element.profilePlaceholder; return; }
    const img = document.createElement('img'); img.alt = '';
    img.src = '/api/auth/profile-photo?v=' + encodeURIComponent(version);
    img.addEventListener('error', () => { if (element.profilePhotoKey === key) { element.innerHTML = element.profilePlaceholder; element.profilePhotoKey = ''; element.setAttribute('aria-label', 'Не удалось загрузить фото'); } });
    element.replaceChildren(img);
  });
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
    const pregnant = profile?.stage === 'pregnancy' && Boolean(timing);
    const age = summary.querySelector('.pregnancy-age');
    const description = summary.querySelector('.section-description');
    const meta = summary.querySelector('.pregnancy-meta');
    const progress = summary.querySelector('.summary-progress');

    age.textContent = pregnant ? timing.label : 'Материалы по неделям беременности';
    description.textContent = pregnant ? `ПДР: ${formatDate(profile.dueDate)}` : 'Библиотека школы';
    summary.href = pregnant ? `journey.html?week=${timing.week}` : 'journey.html';

    if (meta && progress) {
      meta.hidden = progress.hidden = !pregnant;
      description.hidden = pregnant;
      summary.removeAttribute('aria-label');
      if (pregnant) {
        const weeks = Math.max(0, Math.floor(timing.days / 7));
        const days = Math.max(0, timing.days % 7);
        const weekWord = { one: 'неделя', few: 'недели', many: 'недель' }[russianPlural.select(weeks)];
        const dayWords = { one: 'день', few: 'дня', many: 'дней' };
        age.textContent = `${weeks} ${weekWord} и ${days} ${dayWords[russianPlural.select(days)]}`;

        const trimester = timing.week < 14 ? 1 : timing.week < 28 ? 2 : 3;
        const remaining = Math.max(0, progress.max - timing.days);
        meta.querySelector('.summary-trimester').textContent = `${trimester} триместр`;
        meta.querySelector('.summary-days').textContent = remaining
          ? `До родов ≈ ${remaining} ${dayWords[russianPlural.select(remaining)]}`
          : timing.days === progress.max ? 'ПДР сегодня' : 'ПДР прошла';
        progress.value = Math.max(0, Math.min(timing.days, progress.max));
      }
    }
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
  window.addEventListener('profile:saved', refresh);
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('webpril-profile');
    channel.addEventListener('message', event => { if (event.data?.type === 'saved') refresh(); });
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'profile-saved') return;
    if (event.source !== window.parent && ![...document.querySelectorAll('iframe.app-section-frame')].some(frame => frame.contentWindow === event.source)) return;
    refresh();
    document.querySelectorAll('iframe.app-section-frame').forEach(frame => { if (frame.contentWindow !== event.source) frame.contentWindow.postMessage({ type: 'profile-saved' }, location.origin); });
  });
} else { render(null); }
