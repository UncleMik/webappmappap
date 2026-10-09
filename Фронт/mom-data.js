(() => {
  const dialog = document.querySelector('.mom-data-dialog');
  if (!dialog) return;
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.mom-form-error');
  const key = 'webpril:mom-data:v1';
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const moods = { good: 'Хорошо', normal: 'Нормально', bad: 'Плохо' };
  function face(state) {
    const mouth = state === 'good' ? 'M19 30Q30 42 41 30' : state === 'bad' ? 'M19 38Q30 26 41 38' : 'M21 34H39';
    return `<svg class="wellbeing-face face-${state || 'normal'}" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="29" fill="currentColor"/><g fill="#343a32"><circle cx="21" cy="23" r="2.7"/><circle cx="39" cy="23" r="2.7"/></g><path d="${mouth}" fill="none" stroke="#343a32" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(key)) || {};
      return {
        weights: Array.isArray(data.weights) ? data.weights.filter(item => positive(item?.value)).map(item => ({ value: Number(item.value), recordedAt: item.recordedAt })) : [],
        pressure: data.pressure && positive(data.pressure.systolic) && positive(data.pressure.diastolic) ? data.pressure : null,
        wellbeing: moods[data.wellbeing?.state] ? { state: data.wellbeing.state, comment: typeof data.wellbeing.comment === 'string' ? data.wellbeing.comment : '' } : { state: '', comment: typeof data.wellbeing === 'string' ? data.wellbeing : '' },
      };
    } catch { return { weights: [], pressure: null, wellbeing: { state: '', comment: '' } }; }
  }
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const delta = value => `${value > 0 ? '+' : ''}${number.format(value)} кг`;
  const difference = (a, b) => Math.round((a - b) * 10) / 10;
  function render() {
    const data = read();
    const last = data.weights.at(-1);
    const previous = data.weights.at(-2);
    const weight = document.querySelector('.metric-weight');
    const gain = document.querySelector('.metric-gain');
    weight.querySelector('strong').textContent = last ? `${number.format(last.value)} кг` : '—';
    weight.querySelector('.metric-note').textContent = `Всего: ${last ? delta(difference(last.value, data.weights[0].value)) : '—'}`;
    const change = last && previous ? difference(last.value, previous.value) : null;
    gain.querySelector('strong').textContent = change === null ? '—' : delta(change);
    gain.querySelector('.gain-icon').classList.toggle('is-up', change > 0);
    gain.querySelector('.gain-icon').classList.toggle('is-down', change !== null && change < 0);
    gain.setAttribute('aria-label', `Прибавка с последнего взвешивания: ${change === null ? 'нет данных' : delta(change)}`);
    const pressure = document.querySelector('.metric-pressure');
    pressure.querySelector('strong').textContent = data.pressure ? `${data.pressure.systolic}/${data.pressure.diastolic}` : '—';
    pressure.querySelector('.metric-note').textContent = data.pressure ? 'мм рт. ст.' : '—';
    const wellbeing = document.querySelector('.metric-wellbeing');
    wellbeing.querySelector('strong').textContent = moods[data.wellbeing.state] || '—';
    wellbeing.querySelector('.wellbeing-icon').innerHTML = face(data.wellbeing.state);
    wellbeing.querySelector('.metric-note').textContent = data.wellbeing.comment || '\u00a0';
    wellbeing.setAttribute('aria-label', `Самочувствие: ${moods[data.wellbeing.state] || 'не выбрано'}${data.wellbeing.comment ? `. ${data.wellbeing.comment}` : ''}`);
  }
  const configs = {
    weight: { title: 'Записать вес', fields: [{ name: 'weight', label: 'Вес, кг', type: 'number', min: '0.1', step: '0.1' }] },
    'blood-pressure': { title: 'Записать давление', fields: [
      { name: 'systolic', label: 'Верхнее давление, мм рт. ст.', type: 'number', min: '1', step: '1' },
      { name: 'diastolic', label: 'Нижнее давление, мм рт. ст.', type: 'number', min: '1', step: '1' },
    ] },
    wellbeing: { title: 'Самочувствие', fields: [] },
  };
  let action;
  let opener;
  document.querySelectorAll('[data-action="weight"], [data-action="weight-gain"], [data-action="blood-pressure"], [data-action="wellbeing"]').forEach(button => {
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => {
      opener = button;
      action = button.dataset.action === 'weight-gain' ? 'weight' : button.dataset.action;
      const data = read();
      const values = { weight: data.weights.at(-1)?.value ?? '', systolic: data.pressure?.systolic ?? '', diastolic: data.pressure?.diastolic ?? '', wellbeing: data.wellbeing };
      dialog.querySelector('#mom-form-title').textContent = configs[action].title;
      const fields = dialog.querySelector('.mom-form-fields');
      fields.replaceChildren();
      if (action === 'wellbeing') {
        fields.innerHTML = `<fieldset class="wellbeing-options"><legend>Как вы себя чувствуете?</legend><div class="wellbeing-choices">${Object.entries(moods).map(([state, text]) => `<label class="wellbeing-choice"><input type="radio" name="wellbeingState" value="${state}" required><span>${face(state)}<span>${text}</span></span></label>`).join('')}</div></fieldset><label class="wellbeing-comment">Комментарий <span>(необязательно)</span><textarea name="wellbeingComment" maxlength="120" rows="3" placeholder="Можно добавить пару слов"></textarea></label>`;
        const selected = fields.querySelector(`input[value="${data.wellbeing.state}"]`);
        if (selected) selected.checked = true;
        fields.querySelector('textarea').value = data.wellbeing.comment;
      }
      configs[action].fields.forEach(({ label: text, ...attributes }) => {
        const label = document.createElement('label');
        label.textContent = text;
        const input = document.createElement('input');
        Object.assign(input, attributes, { required: true, value: values[attributes.name] });
        if (input.type === 'number') input.inputMode = attributes.step === '1' ? 'numeric' : 'decimal';
        label.append(input);
        fields.append(label);
      });
      error.hidden = true;
      dialog.showModal();
    });
  });
  dialog.querySelectorAll('[data-close-mom-form]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => opener?.focus());
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = read();
    const values = Object.fromEntries(new FormData(form));
    if (action === 'weight') data.weights.push({ value: Number(values.weight), recordedAt: new Date().toISOString() });
    if (action === 'blood-pressure') data.pressure = { systolic: Number(values.systolic), diastolic: Number(values.diastolic) };
    if (action === 'wellbeing') {
      if (!moods[values.wellbeingState]) return;
      data.wellbeing = { state: values.wellbeingState, comment: values.wellbeingComment.trim() };
    }
    try { localStorage.setItem(key, JSON.stringify(data)); } catch {
      error.textContent = 'Не удалось сохранить данные в браузере. Проверьте настройки хранения и попробуйте снова.';
      error.hidden = false;
      return;
    }
    render();
    dialog.close();
  });
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) render(); });
  render();
})();
