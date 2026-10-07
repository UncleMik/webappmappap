(() => {
  const button = document.querySelector('[data-action="baby-data"]');
  const dialog = document.querySelector('.baby-data-dialog');
  if (!button || !dialog) return;
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.baby-form-error');
  const legacyKey = 'webpril:baby-data:v1';
  const weekKey = week => `webpril:baby-data:v2:week:${week}`;
  const normalizeWeek = value => integer(value, 42) ? Number(value) : 27;
  const positions = { head: 'Головное', breech: 'Тазовое', transverse: 'Поперечное' };
  const fields = ['heartRate', 'ultrasoundDate', 'ultrasoundWeek', 'position'];
  const integer = (value, max = Infinity) => /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= max;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  function normalize(data) {
    return {
      heartRate: integer(data?.heartRate) ? String(data.heartRate) : '',
      ultrasoundDate: validDate(data?.ultrasoundDate || '') ? data.ultrasoundDate : '',
      ultrasoundWeek: integer(data?.ultrasoundWeek, 42) ? String(data.ultrasoundWeek) : '',
      position: Object.hasOwn(positions, data?.position) ? data.position : '',
    };
  }
  let selectedWeek = normalizeWeek(new URLSearchParams(location.search).get('week'));
  let editingWeek = selectedWeek;
  function read(week) {
    try {
      const stored = localStorage.getItem(weekKey(week));
      return normalize(JSON.parse(stored ?? (week === 27 ? localStorage.getItem(legacyKey) : null)));
    } catch { return normalize({}); }
  }
  let saved = read(selectedWeek);
  const tiles = document.querySelectorAll('.baby-data .data-tile');
  function render() {
    const values = [
      [saved.heartRate ? `${saved.heartRate} уд/мин` : '—', saved.heartRate ? 'Ваша запись' : '—'],
      [saved.ultrasoundWeek ? `${saved.ultrasoundWeek} нед.` : '—', saved.ultrasoundDate ? new Intl.DateTimeFormat('ru-RU').format(new Date(`${saved.ultrasoundDate}T12:00:00`)) : '—'],
      [positions[saved.position] || '—', saved.position ? 'Ваша запись' : '—'],
    ];
    values.forEach(([value, note], index) => {
      tiles[index].querySelector('strong').textContent = value;
      tiles[index].querySelector('p').textContent = note;
    });
  }
  button.setAttribute('aria-haspopup', 'dialog');
  window.addEventListener('baby:week-change', event => {
    selectedWeek = normalizeWeek(event.detail.week);
    saved = read(selectedWeek);
    render();
  });
  button.addEventListener('click', () => {
    editingWeek = selectedWeek;
    saved = read(editingWeek);
    dialog.querySelector('#baby-form-title').textContent = `Данные о малыше · ${editingWeek} неделя`;
    fields.forEach(name => { form.elements.namedItem(name).value = saved[name]; });
    error.hidden = true;
    dialog.showModal();
  });
  dialog.querySelectorAll('[data-close-baby-form]').forEach(control => control.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => button.focus());
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = normalize(Object.fromEntries(new FormData(form)));
    try { localStorage.setItem(weekKey(editingWeek), JSON.stringify(data)); } catch {
      error.textContent = 'Не удалось сохранить данные в браузере. Проверьте настройки хранения и попробуйте снова.';
      error.hidden = false;
      return;
    }
    saved = read(selectedWeek);
    render();
    dialog.close();
  });
  render();
})();
