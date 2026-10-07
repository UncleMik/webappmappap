(() => {
  const button = document.querySelector('[data-action="baby-data"]');
  const dialog = document.querySelector('.baby-data-dialog');
  if (!button || !dialog) return;
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.baby-form-error');
  const key = 'webpril:baby-data:v1';
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
  let saved = normalize({});
  try { saved = normalize(JSON.parse(localStorage.getItem(key))); } catch { /* Empty form remains usable. */ }
  const tiles = document.querySelectorAll('.baby-data .data-tile');
  function render() {
    const values = [
      [saved.heartRate ? `${saved.heartRate} уд/мин` : 'Не указано', saved.heartRate ? 'Ваша запись' : 'Добавьте значение'],
      [saved.ultrasoundWeek ? `${saved.ultrasoundWeek} нед.` : 'Не указано', saved.ultrasoundDate ? new Intl.DateTimeFormat('ru-RU').format(new Date(`${saved.ultrasoundDate}T12:00:00`)) : 'Дата не указана'],
      [positions[saved.position] || 'Не указано', saved.position ? 'Ваша запись' : 'Добавьте положение'],
    ];
    values.forEach(([value, note], index) => {
      tiles[index].querySelector('strong').textContent = value;
      tiles[index].querySelector('p').textContent = note;
    });
  }
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => {
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
    try { localStorage.setItem(key, JSON.stringify(data)); } catch {
      error.textContent = 'Не удалось сохранить данные в браузере. Проверьте настройки хранения и попробуйте снова.';
      error.hidden = false;
      return;
    }
    saved = data;
    render();
    dialog.close();
  });
  render();
})();
