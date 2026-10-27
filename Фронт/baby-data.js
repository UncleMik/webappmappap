(() => {
  const button = document.querySelector('[data-action="baby-data"]');
  const dialog = document.querySelector('.baby-data-dialog');
  if (!button || !dialog) return;
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.baby-form-error');
  const api = window.personalDataApi;
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
  let saving = false;
  function read(week) { return normalize(api.get().baby[String(week)] || {}); }
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
    if (!api.isLoaded()) { error.textContent = 'Загружаем записи. Попробуйте через несколько секунд.'; error.hidden = false; return; }
    editingWeek = selectedWeek;
    saved = read(editingWeek);
    dialog.querySelector('#baby-form-title').textContent = `Данные о малыше · ${editingWeek} неделя`;
    fields.forEach(name => { form.elements.namedItem(name).value = saved[name]; });
    error.hidden = true;
    dialog.showModal();
  });
  dialog.querySelectorAll('[data-close-baby-form]').forEach(control => control.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('click', event => {
    if (saving) return;
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => button.focus());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = normalize(Object.fromEntries(new FormData(form)));
    const formControls = [...form.querySelectorAll('input, select, button')];
    saving = true;
    formControls.forEach(control => { control.disabled = true; });
    error.hidden = true;
    try { await api.write({ operation: 'setBaby', week: editingWeek, ...data }); } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      saving = false;
      formControls.forEach(control => { control.disabled = false; });
      return;
    }
    saving = false;
    formControls.forEach(control => { control.disabled = false; });
    saved = read(selectedWeek);
    render();
    dialog.close();
  });
  const loadStatus = document.createElement('p');
  loadStatus.className = 'weekly-load-status';
  loadStatus.setAttribute('role', 'status'); loadStatus.textContent = 'Загружаем личные записи…';
  document.querySelector('.baby-data-grid').before(loadStatus);
  api.subscribe(() => {
    saved = read(selectedWeek); render(); button.disabled = !api.isLoaded();
    if (api.isLoaded()) loadStatus.remove();
  });
  api.load().catch(() => { loadStatus.textContent = 'Не удалось загрузить личные записи. Обновите страницу.'; });
})();
