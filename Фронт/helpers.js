(() => {
  const key = 'webpril:movements:v1';
  const dialog = document.createElement('dialog');
  dialog.className = 'helper-dialog';
  dialog.setAttribute('aria-labelledby', 'helper-title');
  dialog.innerHTML = `<header><h2 id="helper-title"></h2><button type="button" data-helper-close aria-label="Закрыть">×</button></header><div class="helper-content"></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector('.helper-content');
  let opener;
  let mode;
  function read() {
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(rows) || rows.some(value => !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime()))) throw new Error('Invalid movement history');
    return rows;
  }
  const format = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  function summary() {
    const block = document.querySelector('.movement-copy');
    if (!block) return;
    try {
      const rows = read();
      block.querySelector('p').textContent = rows.length ? `Последняя запись: ${format(rows.reduce((latest, value) => Math.max(latest, value), 0))}` : 'Записей пока нет';
      block.querySelector('.movement-status').textContent = rows.length ? `Всего шевелений: ${rows.length}` : 'Запишите шевеление, когда почувствуете его';
    } catch {
      block.querySelector('p').textContent = 'Не удалось прочитать записи';
      block.querySelector('.movement-status').textContent = 'Проверьте доступ к хранению в браузере';
    }
  }
  function history() {
    const list = content.querySelector('.movement-history');
    const error = content.querySelector('.helper-error');
    const expandedDays = new Set(Array.from(list.querySelectorAll('details[open]'), day => day.dataset.day));
    list.replaceChildren();
    error.hidden = true;
    try {
      const rows = read().sort((a, b) => b - a);
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.textContent = 'Записей пока нет';
        list.append(empty);
      }
      const days = new Map();
      rows.forEach(value => {
        const date = new Date(value);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(value);
      });
      days.forEach((values, day) => {
        const item = document.createElement('li');
        const details = document.createElement('details');
        details.dataset.day = day;
        details.open = expandedDays.has(day);
        const heading = document.createElement('summary');
        const time = document.createElement('time');
        time.dateTime = day;
        time.textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(values[0]));
        const total = document.createElement('span');
        total.className = 'movement-day-total';
        total.textContent = `Всего шевелений: ${values.length}`;
        heading.append(time, total);
        const records = document.createElement('ul');
        records.className = 'movement-day-records';
        values.forEach(value => {
          const record = document.createElement('li');
          const recordedAt = document.createElement('time');
          recordedAt.dateTime = new Date(value).toISOString();
          recordedAt.textContent = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
          record.append(recordedAt);
          records.append(record);
        });
        details.append(heading, records);
        item.append(details);
        list.append(item);
      });
    } catch {
      error.textContent = 'Не удалось прочитать историю. Проверьте настройки хранения в браузере.';
      error.hidden = false;
    }
  }
  function open(type, trigger) {
    opener = trigger;
    mode = type;
    dialog.querySelector('h2').textContent = type === 'tools' ? 'Все инструменты' : 'Шевеления малыша';
    if (type === 'tools') {
      content.innerHTML = `<div class="helper-options"><button type="button" data-helper-calendar>Календарь <span aria-hidden="true">›</span></button><button type="button" data-action="breathing">Дыхание <span aria-hidden="true">›</span></button><button type="button" data-action="movements">Шевеления <span aria-hidden="true">›</span></button></div>`;
    } else {
      content.innerHTML = `<p>Нажмите, когда почувствуете шевеление: сохраним текущие дату и время.</p><button type="button" class="helper-save">Записать сейчас</button><p class="helper-feedback" role="status"></p><p class="helper-error" role="alert" hidden></p><h3>История записей</h3><ul class="movement-history"></ul><p class="helper-storage-note">Записи сохраняются в этом браузере, без синхронизации между устройствами.</p>`;
      history();
    }
    if (!dialog.open) dialog.showModal();
  }
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (!control || !['tools', 'movements'].includes(control.dataset.action)) return;
    event.preventDefault();
    const trigger = dialog.contains(control) ? opener : control;
    open(control.dataset.action, trigger);
  });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-helper-close]')) dialog.close();
    if (event.target.closest('[data-helper-calendar]')) {
      dialog.close();
      document.querySelector('[data-action="calendar"]').click();
    }
    if (event.target.closest('.helper-save')) {
      try {
        const rows = read();
        rows.push(Date.now());
        localStorage.setItem(key, JSON.stringify(rows));
        history();
        summary();
        content.querySelector('.helper-feedback').textContent = 'Шевеление записано';
      } catch {
        const error = content.querySelector('.helper-error');
        error.textContent = 'Не удалось сохранить запись. Проверьте настройки хранения в браузере и попробуйте снова.';
        error.hidden = false;
        content.querySelector('.helper-feedback').textContent = '';
      }
    }
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => opener?.focus());
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    summary();
    if (dialog.open && mode === 'movements') history();
  });
  summary();
})();
