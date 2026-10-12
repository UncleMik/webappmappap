(() => {
  const form = document.getElementById('onboarding-form');
  const content = document.getElementById('onboarding-content');
  const next = form.querySelector('.onboarding-next');
  const back = document.querySelector('.onboarding-back');
  const error = form.querySelector('.onboarding-error');
  const progress = document.querySelector('.step-progress');
  let step = 1;
  const state = { stage:'', method:'', conception:'', due:'', weeks:'', days:'', birth:'', goals:[] };
  const pregnancyGoals = ['Спокойно пройти беременность','Подготовиться к родам','Понимать развитие малыша','Подготовить тело к родам','Разобраться с анализами','Справиться с тревогой','Подготовиться к первым дням с малышом'];
  const motherGoals = ['Восстановиться после родов','Наладить грудное вскармливание','Разобраться с уходом за малышом','Наладить сон малыша и свой сон','Вернуться к физической активности','Справиться со стрессом','Общаться с мамами и делиться опытом'];
  const symbols = ['♡','✦','◌','↟','▤','☁','◇'];
  const dayMs = 86400000;
  // Calendar dates use UTC midnight so DST never changes their day difference.
  const today = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  const iso = value => new Date(value).toISOString().slice(0,10);
  const parse = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value+'T00:00:00Z') : NaN;
  const formatDate = value => new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(value);
  function pregnancy() {
    let days, due;
    if (state.method === 'weeks') {
      if (state.weeks === '' || state.days === '') return null;
      const w = Number(state.weeks), d = Number(state.days);
      if (!Number.isInteger(w) || !Number.isInteger(d) || w < 0 || w > 42 || d < 0 || d > 6) return null;
      days = w*7+d; due = today() + (280-days)*dayMs;
    } else if (state.method === 'due') {
      due = parse(state.due); days = 280-Math.round((due-today())/dayMs);
    } else if (state.method === 'conception') {
      const conception = parse(state.conception);
      if (conception > today()) return null;
      due = conception+266*dayMs; days = Math.round((today()-conception)/dayMs)+14;
    } else return null;
    return Number.isFinite(days) && Number.isFinite(due) && days >= 0 && days <= 300 ? {days,due} : null;
  }
  function valid() {
    if (step === 1) return Boolean(state.stage);
    if (step === 3) return state.goals.length > 0;
    if (state.stage === 'mother') return Number.isFinite(parse(state.birth)) && parse(state.birth) <= today();
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
    back.hidden = step === 1;
    progress.setAttribute('aria-label',`Шаг ${step} из 3`);
    progress.querySelectorAll('span').forEach((bar, i) => bar.classList.toggle('current', i < step));
    document.querySelector('.step-label').textContent = `Шаг ${step} из 3`;
    next.textContent = step === 3 ? 'Начать' : 'Продолжить';
    if (step === 1) content.innerHTML = `<h1 tabindex="-1">На каком этапе вы сейчас?</h1><p class="onboarding-description">Мы подберём материалы и рекомендации под вашу ситуацию.</p><div class="stage-options"><label class="stage-option"><input type="radio" name="stage" value="pregnancy"><span class="stage-art" aria-hidden="true"></span><span class="stage-copy"><strong>Я беременна</strong><small>Сопровождение по вашему сроку</small></span><span class="stage-arrow" aria-hidden="true">›</span></label><label class="stage-option mother"><input type="radio" name="stage" value="mother"><span class="stage-art" aria-hidden="true"></span><span class="stage-copy"><strong>Я уже мама</strong><small>После рождения малыша</small></span><span class="stage-arrow" aria-hidden="true">›</span></label></div>`;
    if (step === 2 && state.stage === 'pregnancy') content.innerHTML = `<h1 tabindex="-1">Уточните срок беременности</h1><p class="onboarding-description">Выберите один удобный способ — мы рассчитаем срок и настроим календарь.</p><fieldset class="method-options"><legend class="sr-only">Способ расчёта срока беременности</legend>${[['conception','♡','Дата зачатия','Рассчитаем предполагаемую дату родов'],['due','▦','Предполагаемая дата родов','Если ПДР уже сообщил врач'],['weeks','◷','Срок беременности','Укажите недели и дни']].map(([value,icon,title,desc])=>`<label class="method-option"><span class="option-icon" aria-hidden="true">${icon}</span><span class="method-copy"><strong>${title}</strong><small>${desc}</small></span><input type="radio" name="method" value="${value}" aria-label="${title}"></label>`).join('')}</fieldset><div class="method-fields"></div><div class="onboarding-summary" aria-live="polite" hidden><strong></strong><small></small></div>`;
    if (step === 2 && state.stage === 'mother') content.innerHTML = `<h1 tabindex="-1">Когда родился малыш?</h1><p class="onboarding-description">Укажите дату рождения, чтобы подобрать материалы по возрасту малыша.</p><div class="onboarding-fields">${field('birth','Дата рождения малыша','date',`max="${iso(today())}"`)}</div><div class="onboarding-summary" aria-live="polite" hidden><strong></strong><small>Материалы будут подобраны по возрасту</small></div>`;
    if (step === 3) {
      const goals = state.stage === 'mother' ? motherGoals : pregnancyGoals;
      content.innerHTML = `<h1 tabindex="-1">Что для вас сейчас важнее всего?</h1><p class="onboarding-description">Отметьте всё, что для вас важно — рекомендации изменятся под ваши цели.</p><div class="goal-options">${goals.map((goal,i)=>`<label class="goal-option"><span class="goal-symbol" aria-hidden="true">${symbols[i]}</span><span>${goal}</span><input type="checkbox" name="goal" value="${i}" aria-label="${goal}" ${state.goals.includes(i)?'checked':''}></label>`).join('')}</div><p class="goal-count" aria-live="polite">Выбрано: ${state.goals.length}</p>`;
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
  back.addEventListener('click',()=> { if(step > 1) { step--; render(); content.querySelector('h1').focus(); window.scrollTo(0,0); } });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if(!valid()) return;
    if(step < 3) { step++; render(); content.querySelector('h1').focus(); window.scrollTo(0,0); return; }
    const p = state.stage === 'pregnancy' ? pregnancy() : null;
    const answers = {...state, dueDate:p?iso(p.due):null, savedAt:new Date().toISOString()};
    let saved = true;
    try { localStorage.setItem('webpril.onboarding.preview.v1', JSON.stringify(answers)); } catch { saved = false; }
    back.hidden = true; progress.hidden = true; document.querySelector('.step-label').hidden = true;
    content.innerHTML = `<h1 tabindex="-1">Рады знакомству!</h1><p class="onboarding-description">${saved?'Ваши ответы сохранены в этом браузере.':'Не удалось сохранить ответы в браузере. Можно продолжить просмотр.'}</p><img class="onboarding-complete-art" src="assets/onboarding-motherhood.png" alt="Беременность и первые месяцы материнства"><p class="onboarding-description">Сейчас вы перейдёте к демонстрационной версии приложения. Персональные рекомендации пока не подключены.</p>`;
    form.querySelector('.onboarding-actions').innerHTML = '<a class="onboarding-open" href="index.html">Открыть приложение</a><p class="onboarding-preview">Предпросмотр · аккаунт пока не создаётся</p>';
    try {
      const name = sessionStorage.getItem('onboardingName')?.trim();
      if (name) content.querySelector('h1').textContent = `Рады знакомству, ${name}!`;
    } catch { /* The preview also works without browser storage. */ }
    content.querySelector('h1').focus(); window.scrollTo(0,0);
  });
  render();
})();
