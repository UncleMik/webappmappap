document.querySelectorAll('[data-password-toggle]').forEach((toggle) => {
  const input = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!input) return;
  toggle.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
    toggle.setAttribute('aria-pressed', String(visible));
    input.focus();
  });
});

document.querySelectorAll('form[data-auth-form]').forEach((form) => {
  const password = form.querySelector('[data-new-password]');
  const confirmation = form.querySelector('[data-confirm-password]');
  const status = form.querySelector('[data-auth-status]');

  function checkConfirmation() {
    if (!confirmation || !password) return;
    confirmation.setCustomValidity(confirmation.value && confirmation.value !== password.value ? 'Пароли не совпадают' : '');
  }

  password?.addEventListener('input', checkConfirmation);
  confirmation?.addEventListener('input', checkConfirmation);

  form.addEventListener('submit', (event) => {
    checkConfirmation();
    if (!form.reportValidity()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const kind = form.dataset.authForm;
    if (kind === 'register') {
      try { sessionStorage.setItem('onboardingName', form.elements.name.value.trim()); } catch (_) { /* Private mode may block storage. */ }
      window.location.assign('onboarding.html');
    } else if (status) {
      status.textContent = kind === 'forgot'
        ? 'Отправка писем ещё не подключена.'
        : kind === 'reset'
          ? 'Сохранение нового пароля ещё не подключено.'
          : 'Вход пока не подключён.';
    }
  });
});
