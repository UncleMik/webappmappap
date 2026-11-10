(() => {
  const emailForm = document.querySelector('#email-form');
  const codeForm = document.querySelector('#code-form');
  const status = document.querySelector('#login-status');
  let challenge;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  async function submit(form, route, body, onSuccess) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    message('Подождите…');
    try {
      const response = await fetch('/api/admin/' + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Вход временно недоступен.');
      onSuccess(data);
    } catch (error) { message(error.message || 'Не удалось войти.', true); }
    finally { button.disabled = false; }
  }

  emailForm.addEventListener('submit', event => {
    event.preventDefault();
    void submit(emailForm, 'request', { email: emailForm.elements.email.value }, data => {
      challenge = data.challenge;
      emailForm.hidden = true;
      codeForm.hidden = false;
      codeForm.elements.code.focus();
      message('Письмо отправлено. Проверьте почту.');
    });
  });
  codeForm.addEventListener('submit', event => {
    event.preventDefault();
    void submit(codeForm, 'verify', { challenge, code: codeForm.elements.code.value }, () => location.replace('/admin'));
  });
  document.querySelector('#edit-email').addEventListener('click', () => {
    codeForm.reset();
    codeForm.hidden = true;
    emailForm.hidden = false;
    challenge = undefined;
    message('');
    emailForm.elements.email.focus();
  });
  if (location.hash === '#access') message('У этого аккаунта нет доступа к админке.', true);
})();
