import { authRequest } from './auth-client.js';
import { todayDate, isoDate, parseDate, formatDate, pregnancyDate, returnPage } from './profile-dates.js';

(() => {
  const form = document.getElementById('onboarding-form');
  const content = document.getElementById('onboarding-content');
  const next = form.querySelector('.onboarding-next');
  const back = document.querySelector('.onboarding-back');
  const error = form.querySelector('.onboarding-error');
  const progress = document.querySelector('.step-progress');
  let step = 1, busy = false, ready = false;
  const destination = returnPage(new URLSearchParams(location.search).get('next'));
  const retry = document.querySelector('#retry-profile');
  const state = { name:'', stage:'', method:'', conception:'', due:'', weeks:'', days:'', birth:'', goals:[] };
  const pregnancyGoals = ['Спокойно пройти беременность','Подготовиться к родам','Понимать развитие малыша','Подготовить тело к родам','Разобраться с анализами','Справиться с тревогой','Подготовиться к первым дням с малышом'];
  const motherGoals = ['Восстановиться после родов','Наладить грудное вскармливание','Разобраться с уходом за малышом','Наладить сон малыша и свой сон','Вернуться к физической активности','Справиться со стрессом','Общаться с мамами и делиться опытом'];
  const symbols = ['♡','✦','◌','↟','▤','☁','◇'];
  const dayMs = 86400000, today = todayDate, iso = isoDate, parse = parseDate;
  const pregnancy = () => pregnancyDate(state);
  function valid() {
    if (!ready || busy) return false;
    if (step === 1) return Boolean(state.stage);
    if (step === 3) return state.goals.length > 0;
    if (!state.name.trim() || [...state.name.trim()].length > 80 || /[\p{Cc}\p{Cf}]/u.test(state.name)) return false;
    if (state.stage === 'mother') return Number.isFinite(parse(state.birth)) && parse(state.birth) <= today() && parse(state.birth) >= Date.UTC(1900,0,1);
    return Boolean(pregnancy());
  }
  function summary() {
    const box = content.querySelector('.onboarding-summary');
    if (!box) return;
    if (state.stage === 'mother') {
      const birth = parse(state.birth);
      box.hidden = !Number.isFinite(birth) || birth > today();
      if (!box.hidden) {
        const date = new Date(birth), current = new Date(today());
        let months = (current.getUTCFullYear()-date.getUTCFullYear())*12 + current.getUTCMonth()-date.getUTCMonth();
        if (current.getUTCDate() < date.getUTCDate()) months--;
        box.querySelector('strong').textContent = months < 1 ? 'Меньше месяца' : `${months} мес.`;
      }
    } else {
      const p = pregnancy(); box.hidden = !p;
      if (p) {
        box.querySelector('strong').textContent = `${Math.floor(p.days/7)} нед. и ${p.days%7} дн.`;
        box.querySelector('small').textContent = `ПДР: ${formatDate(p.due)}`;
      }
    }
  }
  function field(name, label, type='date', attrs='') {
    return `<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`;
  }
  function fillFields() {
    content.querySelectorAll('input:not([type=radio]):not([type=checkbox])').forEach(input => { input.value = state[input.name] || ''; });
  }
  function methodFields() {
    const box = content.querySelector('.method-fields');
    if (!box) return;
    let fields = '';
    if (state.method === 'conception') fields = field('conception','Дата зачатия','date',`max="${iso(today())}"`);
    if (state.method === 'due') fields = field('due','Предполагаемая дата родов','date',`min="${iso(today()-20*dayMs)}" max="${iso(today()+280*dayMs)}"`);
    if (state.method === 'weeks') fields = field('weeks','Недели','number','min="0" max="42" step="1" inputmode="numeric" placeholder="Например, 27"')+field('days','Дни','number','min="0" max="6" step="1" inputmode="numeric" placeholder="0–6"');
    box.innerHTML = fields ? `<div class="onboarding-fields">${fields}</div>` : '';
    fillFields(); summary();
  }
  function render() {
    error.hidden = true;
    back.hidden = step === 1; back.disabled = busy;
    progress.setAttribute('aria-label',`Шаг ${step} из 3`);
    progress.querySelectorAll('span').forEach((bar, i) => bar.classList.toggle('current', i < step));
    document.querySelector('.step-label').textContent = `Шаг ${step} из 3`;
    next.textContent = step === 3 ? 'Начать' : 'Продолжить';
    if (step === 1) content.innerHTML = `<h1 tabindex="-1">На каком этапе вы сейчас?</h1><p class="onboarding-description">Сохраним ваш этап в личном профиле.</p><div class="stage-options"><label class="stage-option"><input type="radio" name="stage" value="pregnancy"><span class="stage-art" aria-hidden="true"></span><span class="stage-copy"><strong>Я беременна</strong><small>Сопровождение по вашему сроку</small></span><span class="stage-arrow" aria-hidden="true">›</span></label><label class="stage-option mother"><input type="radio" name="stage" value="mother"><span class="stage-art" aria-hidden="true"></span><span class="stage-copy"><strong>Я уже мама</strong><small>После рождения малыша</small></span><span class="stage-arrow" aria-hidden="true">›</span></label></div>`;
    if (step === 2 && state.stage === 'pregnancy') content.innerHTML = `<h1 tabindex="-1">Уточните срок беременности</h1><p class="onboarding-description">Выберите один удобный способ — мы рассчитаем срок и настроим календарь.</p><fieldset class="method-options"><legend class="sr-only">Способ расчёта срока беременности</legend>${[['conception','♡','Дата зачатия','Рассчитаем предполагаемую дату родов'],['due','▦','Предполагаемая дата родов','Если ПДР уже сообщил врач'],['weeks','◷','Срок беременности','Укажите недели и дни']].map(([value,icon,title,desc])=>`<label class="method-option"><span class="option-icon" aria-hidden="true">${icon}</span><span class="method-copy"><strong>${title}</strong><small>${desc}</small></span><input type="radio" name="method" value="${value}" aria-label="${title}"></label>`).join('')}</fieldset><div class="method-fields"></div><div class="onboarding-summary" aria-live="polite" hidden><strong></strong><small></small></div>`;
    if (step === 2 && state.stage === 'mother') content.innerHTML = `<h1 tabindex="-1">Когда родился малыш?</h1><p class="onboarding-description">Укажите дату рождения малыша.</p><div class="onboarding-fields">${field('birth','Дата рождения малыша','date',`max="${iso(today())}"`)}</div><div class="onboarding-summary" aria-live="polite" hidden><strong></strong><small>Возраст малыша</small></div>`;
    if (step === 3) {
      const goals = state.stage === 'mother' ? motherGoals : pregnancyGoals;
      content.innerHTML = `<h1 tabindex="-1">Что для вас сейчас важнее всего?</h1><p class="onboarding-description">Выберите хотя бы одну цель. Ответы сохранятся в вашем профиле.</p><div class="goal-options">${goals.map((goal,i)=>`<label class="goal-option"><span class="goal-symbol" aria-hidden="true">${symbols[i]}</span><span>${goal}</span><input type="checkbox" name="goal" value="${i}" aria-label="${goal}" ${state.goals.includes(i)?'checked':''}></label>`).join('')}</div><p class="goal-count" aria-live="polite">Выбрано: ${state.goals.length}</p>`;
    }
    if (step === 2) {
      const nameBox = document.createElement('div');
      nameBox.className = 'onboarding-fields';
      nameBox.innerHTML = '<label>Как к вам обращаться<input name="name" type="text" autocomplete="given-name" maxlength="80" required placeholder="Ваше имя"></label>';
      content.querySelector('.onboarding-description').after(nameBox);
    }
    content.querySelectorAll('.stage-art').forEach(holder => {
      const image = document.createElement('img');
      image.src = 'assets/onboarding-motherhood.png';
      image.alt = '';
      holder.append(image);
    });
    if (state.stage) content.querySelector(`input[name=stage][value=${state.stage}]`)?.setAttribute('checked','');
    if (state.method) content.querySelector(`input[name=method][value=${state.method}]`)?.setAttribute('checked','');
    methodFields(); fillFields(); summary(); next.disabled = !valid();
  }
  form.addEventListener('input', event => {
    const input = event.target;
    if (input.name === 'stage') { if(state.stage !== input.value) state.goals = []; state.stage = input.value; }
    else if (input.name === 'method') { state.method = input.value; methodFields(); }
    else if (input.name === 'goal') {
      state.goals = [...content.querySelectorAll('input[name=goal]:checked')].map(item=>Number(item.value));
      content.querySelector('.goal-count').textContent = `Выбрано: ${state.goals.length}`;
    } else if (Object.hasOwn(state,input.name)) state[input.name] = input.value;
    summary(); next.disabled = !valid();
  });
  back.addEventListener('click',()=> { if(!busy && step > 1) { step--; render(); content.querySelector('h1').focus(); window.scrollTo(0,0); } });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if(!valid()) return;
    if(step < 3) { step++; render(); content.querySelector('h1').focus(); window.scrollTo(0,0); return; }
    busy = true; next.disabled = true; back.disabled = true;
    next.textContent = 'Сохраняем…'; error.hidden = true;
    form.querySelectorAll('input').forEach(input => { input.disabled = true; });
    try {
      await authRequest('profile', state);
      window.top.location.replace(destination);
    } catch (failure) {
      if (failure.code === 'sign_in_required') {
        const login = new URL('login.html', location.href);
        const requested = new URLSearchParams(location.search).get('next');
        if (requested) login.searchParams.set('next', requested);
        window.top.location.replace(login.href); return;
      }
      error.textContent = failure.message; error.hidden = false;
      error.scrollIntoView({block:'nearest'});
    } finally {
      busy = false; back.disabled = false;
      form.querySelectorAll('input').forEach(input => { input.disabled = false; });
      next.textContent = 'Начать'; next.disabled = !valid();
    }
  });
  async function load() {
    retry.hidden = true; form.hidden = true;
    const status = document.querySelector('#onboarding-status');
    status.textContent = 'Проверяем аккаунт…';
    try {
      const session = await authRequest('session');
      if (!session.authenticated) {
        const login = new URL('login.html', location.href);
        const requested = new URLSearchParams(location.search).get('next');
        if (requested) login.searchParams.set('next', requested);
        window.top.location.replace(login.href); return;
      }
      if (session.user.profile?.completedAt) { window.top.location.replace(destination); return; }
      ready = true; status.textContent = ''; form.hidden = false; render();
    } catch (failure) {
      status.textContent = failure.message; retry.hidden = false;
    }
  }
  retry.addEventListener('click', load);
  if (location.hostname === 'unclemik.github.io') {
    document.querySelector('#onboarding-status').textContent = 'Регистрация доступна на основном сайте приложения.';
    retry.hidden = true; form.hidden = true;
    const link = document.createElement('a'); link.href = 'https://app.legkie-rody.ru/login.html';
    link.className = 'onboarding-open'; link.textContent = 'Перейти к регистрации';
    document.querySelector('.onboarding-shell').append(link);
  } else { load(); }
})();
