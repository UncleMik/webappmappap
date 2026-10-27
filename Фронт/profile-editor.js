import { authRequest } from './auth-client.js';
import { pregnancyDate, todayDate, isoDate } from './profile-dates.js';

const GOALS = {
  pregnancy: ['Спокойно пройти беременность', 'Подготовиться к родам', 'Понимать развитие малыша', 'Подготовить тело к родам', 'Разобраться с анализами', 'Справиться с тревогой', 'Подготовиться к первым дням с малышом'],
  mother: ['Восстановиться после родов', 'Наладить грудное вскармливание', 'Разобраться с уходом за малышом', 'Наладить сон малыша и свой сон', 'Вернуться к физической активности', 'Справиться со стрессом', 'Общаться с мамами и делиться опытом'],
};
const fields = {
  name: ['Имя', 'text', 'given-name', 80], surname: ['Фамилия', 'text', 'family-name', 80],
  birthday: ['Дата рождения', 'date', 'bday'], city: ['Город', 'text', 'address-level2', 100],
  phone: ['Номер телефона', 'tel', 'tel', 20],
};
const dialog = document.createElement('dialog');
dialog.className = 'profile-editor';
dialog.setAttribute('aria-labelledby', 'profile-editor-title');
dialog.innerHTML = '<header><h2 id="profile-editor-title"></h2><button class="editor-close close-button" type="button" aria-label="Закрыть"><svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><form><div class="editor-body"></div><p class="editor-error" role="alert" hidden></p><div class="editor-actions"><button type="button" data-cancel>Отмена</button><button type="submit">Сохранить</button></div></form>';
document.body.append(dialog);
const form = dialog.querySelector('form'), body = dialog.querySelector('.editor-body');
const error = dialog.querySelector('.editor-error'), submit = form.querySelector('[type=submit]');
let kind, account, profile, email, busy = false, opening = false, trigger, photo;
let generation = 0;
let scrollStyle;
const message = document.createElement('p');
message.className = 'profile-saved'; message.setAttribute('role', 'status'); message.hidden = true;
(document.querySelector('.data-main, .profile-main') || document.body).prepend(message);
function showError(text) { error.textContent = text; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); }
function close() { if (!busy) dialog.close(); }
function textField(name, label, type = 'text') {
  return `<label>${label}<input name="${name}" type="${type}"></label>`;
}
function goals(stage, selected) {
  const box = document.createElement('fieldset');
  box.style.border = '0';
  box.innerHTML = '<legend>Выберите хотя бы одну цель</legend>';
  GOALS[stage].forEach((label, index) => {
    const row = document.createElement('label'); row.className = 'editor-check';
    const check = document.createElement('input'); check.type = 'checkbox'; check.name = 'goal'; check.value = String(index); check.checked = selected.includes(index);
    row.append(check, document.createTextNode(label)); box.append(row);
  });
  return box;
}
function photoPreview(src) {
  const img = body.querySelector('.editor-photo');
  img.hidden = !src;
  if (src) img.src = src; else img.removeAttribute('src');
}
function methodFields(method, initial = false) {
  const box = body.querySelector('[data-method-fields]');
  if (!box) return;
  box.innerHTML = method === 'weeks' ? textField('weeks', 'Недели', 'number') + textField('days', 'Дни', 'number')
    : method === 'conception' ? textField('conception', 'Дата зачатия', 'date') : textField('due', 'Предполагаемая дата родов', 'date');
  for (const input of box.querySelectorAll('input')) input.required = true;
  if (method === 'weeks') {
    Object.assign(form.elements.weeks, { min: '0', max: '42', step: '1' });
    Object.assign(form.elements.days, { min: '0', max: '6', step: '1', value: '0' });
  } else if (method === 'conception') form.elements.conception.max = isoDate(todayDate());
  if (initial && profile.stage === 'pregnancy' && profile.dueDate && method === 'due') form.elements.due.value = profile.dueDate;
}
function stageFields(stage) {
  const box = body.querySelector('[data-stage-fields]');
  if (stage === 'pregnancy') {
    box.innerHTML = '<label>Способ расчёта срока<select name="method"><option value="due">Предполагаемая дата родов</option><option value="weeks">Недели и дни</option><option value="conception">Дата зачатия</option></select></label><div data-method-fields></div>';
    methodFields('due', true);
    form.elements.method.addEventListener('change', () => methodFields(form.elements.method.value));
  } else {
    box.innerHTML = textField('birthDate', 'Дата рождения малыша', 'date');
    form.elements.birthDate.required = true; form.elements.birthDate.max = isoDate(todayDate());
    form.elements.birthDate.min = '1900-01-01'; form.elements.birthDate.value = profile.birthDate || '';
    if (profile.stage !== 'mother') box.insertAdjacentHTML('beforeend', '<label class="editor-check"><input name="confirmMother" type="checkbox" required>Подтверждаю, что малыш родился</label>');
  }
  body.querySelector('[data-stage-goals]').replaceChildren(goals(stage, stage === profile.stage ? profile.goals : []));
}
async function open(which, source) {
  if (busy || opening || dialog.open) return;
  opening = true;
  const current = generation;
  trigger = source; message.hidden = true;
  // Read fresh identity before an editor is populated; focus rechecks never overwrite a draft.
  try {
    const session = await authRequest('session');
    if (current !== generation) return;
    if (!session.authenticated || !session.user?.profile?.completedAt) throw new Error('Не удалось загрузить профиль. Обновите страницу и повторите.');
    account = session.user.id; profile = session.user.profile; email = session.user.email;
  } catch (failure) { message.textContent = failure.message; message.hidden = false; opening = false; return; }
  opening = false;
  kind = which; photo = undefined; error.hidden = true;
  submit.hidden = which === 'settings' || which === 'email';
  form.querySelector('[data-cancel]').textContent = submit.hidden ? 'Закрыть' : 'Отмена';
  const title = dialog.querySelector('h2');
  body.replaceChildren();
  if (fields[which]) {
    const [label, type, autocomplete, maxLength] = fields[which]; title.textContent = label;
    body.innerHTML = textField(which, label, type);
    const input = form.elements[which]; input.value = profile[which] || ''; input.autocomplete = autocomplete;
    if (maxLength) input.maxLength = maxLength;
    if (which === 'birthday') { input.max = isoDate(todayDate()); input.min = '1900-01-01'; }
    input.required = which === 'name';
    if (which === 'phone') { input.placeholder = '+79991234567'; body.insertAdjacentHTML('beforeend', '<p class="editor-hint">Укажите номер с кодом страны, например +79991234567.</p>'); }
    if (which !== 'name') body.insertAdjacentHTML('beforeend', '<p class="editor-hint">Необязательное поле. Чтобы удалить значение, оставьте его пустым и сохраните.</p>');
  } else if (which === 'goals') {
    title.textContent = 'Цели и интересы'; body.append(goals(profile.stage, profile.goals));
  } else if (which === 'stage') {
    title.textContent = 'Мой этап и срок';
    body.innerHTML = '<label>Мой этап<select name="stage"><option value="pregnancy">Я беременна</option><option value="mother">Я уже мама</option></select></label><div data-stage-fields></div><div data-stage-goals></div>';
    form.elements.stage.value = profile.stage; stageFields(profile.stage);
    form.elements.stage.addEventListener('change', () => stageFields(form.elements.stage.value));
  } else if (which === 'photo') {
    title.textContent = 'Фото профиля';
    body.innerHTML = '<img class="editor-photo" alt="Предпросмотр фото" hidden><label>Выберите фото<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label><p class="editor-hint">JPG, PNG или WebP до 8 МБ. Фото будет уменьшено для профиля.</p><button class="editor-link" type="button" data-remove-photo>Удалить фото</button>';
    photoPreview(profile.photoVersion ? '/api/auth/profile-photo?v=' + encodeURIComponent(profile.photoVersion) : '');
    body.querySelector('[data-remove-photo]').disabled = !profile.photoVersion;
    body.querySelector('[data-remove-photo]').addEventListener('click', () => { photo = null; photoPreview(''); form.elements.photo.value = ''; });
    form.elements.photo.addEventListener('change', preparePhoto);
  } else if (which === 'email') {
    title.textContent = 'Электронная почта';
    body.innerHTML = '<p data-email-value></p><p class="editor-hint">Для смены email обратитесь в поддержку школы. Она проверит принадлежность аккаунта и покупок.</p>';
    body.querySelector('[data-email-value]').textContent = email;
  } else if (which === 'settings') {
    title.textContent = 'Настройки';
    body.innerHTML = '<div class="editor-settings"><a class="editor-link" href="personal-data.html">Личные данные</a><button class="editor-link" type="button" data-settings-goals>Цели и интересы</button><p>Язык приложения: Русский</p><p>Часовой пояс: Москва (UTC+3)</p><p>Способ входа: Код на email</p></div>';
    body.querySelector('[data-settings-goals]').addEventListener('click', () => { dialog.addEventListener('close', () => open('goals', source), { once: true }); close(); });
  } else return;
  dialog.showModal(); scrollStyle = document.body.style.overflow; document.body.style.overflow = 'hidden';
}
async function preparePhoto() {
  const current = generation;
  const file = form.elements.photo.files[0];
  if (!file) return;
  error.hidden = true; photo = undefined;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { showError('Выберите JPG, PNG или WebP размером до 8 МБ.'); return; }
  busy = true; submit.disabled = true;
  form.elements.photo.disabled = true;
  body.querySelector('[data-remove-photo]').disabled = true;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (current !== generation || !dialog.open) return;
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error();
    const ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .85); photo = data.split(',')[1];
    if (photo.length > 470000) throw new Error();
    photoPreview(data); body.querySelector('[data-remove-photo]').disabled = false;
  } catch { if (current === generation && dialog.open) { photo = undefined; showError('Не удалось прочитать фото. Попробуйте другое изображение.'); } }
  finally {
    bitmap?.close();
    if (current === generation && dialog.open) {
      busy = false; submit.disabled = false; form.elements.photo.disabled = false;
      body.querySelector('[data-remove-photo]').disabled = photo === undefined && !profile.photoVersion;
    }
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || submit.hidden || !form.reportValidity()) return;
  error.hidden = true;
  const changes = {}, values = new FormData(form);
  let confirmMother = false;
  if (fields[kind]) changes[kind] = String(values.get(kind)).trim();
  else if (kind === 'goals') changes.goals = values.getAll('goal').map(Number);
  else if (kind === 'stage') {
    const stage = values.get('stage'); changes.stage = stage;
    // Preserve an unchanged historical due date even after 42 weeks.
    if (stage === 'pregnancy') {
      const method = values.get('method'), due = values.get('due');
      if (profile.stage !== stage || method !== 'due' || due !== profile.dueDate) {
        const timing = pregnancyDate(Object.fromEntries(values));
        if (!timing) { showError('Проверьте срок беременности: от 0 до 42 недель и 6 дней.'); return; }
        changes.dueDate = isoDate(timing.due);
      }
    } else { changes.birthDate = values.get('birthDate'); confirmMother = values.get('confirmMother') === 'on'; }
    changes.goals = values.getAll('goal').map(Number);
  } else if (kind === 'photo' && photo === undefined) { showError('Выберите фото или нажмите «Удалить фото».'); return; }
  if (changes.goals && !changes.goals.length) { showError('Выберите хотя бы одну цель.'); return; }
  if (Object.hasOwn(changes, 'phone')) changes.phone = changes.phone.replace(/[\s()-]/g, '');
  const current = generation;
  busy = true; submit.textContent = 'Сохраняем…'; form.querySelectorAll('input,select,button').forEach(item => { item.disabled = true; });
  try {
    const result = kind === 'photo' ? await authRequest('profile-photo', { accountId: account, photo }) : await authRequest('profile-edit', { accountId: account, changes, confirmMother });
    if (current !== generation || !dialog.open) return;
    // Publish only a signal; every existing panel reads the authoritative session itself.
    window.dispatchEvent(new Event('profile:saved'));
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('webpril-profile') : null;
    channel?.postMessage({ type: 'saved' }); channel?.close();
    if (!channel) {
      if (window.parent !== window) window.parent.postMessage({ type: 'profile-saved' }, location.origin);
      document.querySelectorAll('iframe.app-section-frame').forEach(frame => frame.contentWindow.postMessage({ type: 'profile-saved' }, location.origin));
    }
    profile = result.user.profile; busy = false; dialog.close();
    message.textContent = 'Изменения сохранены.'; message.hidden = false;
  } catch (failure) { if (current === generation && dialog.open) showError(failure.message); }
  finally { if (current === generation) { busy = false; submit.textContent = 'Сохранить'; form.querySelectorAll('input,select,button').forEach(item => { item.disabled = false; }); } }
});
dialog.querySelector('.editor-close').addEventListener('click', close);
form.querySelector('[data-cancel]').addEventListener('click', close);
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientY < rect.top || event.clientX < rect.left || event.clientX > rect.right) close(); } });
dialog.addEventListener('close', () => { generation++; busy = false; opening = false; submit.textContent = 'Сохранить'; submit.disabled = false; form.querySelector('[data-cancel]').disabled = false; document.body.style.overflow = scrollStyle || ''; body.replaceChildren(); trigger?.focus({ preventScroll: true }); });
document.addEventListener('click', event => { const button = event.target.closest('[data-edit]'); if (button) open(button.dataset.edit, button); });
window.addEventListener('webpril:session-ended', () => { generation++; busy = false; opening = false; if (dialog.open) dialog.close(); });
