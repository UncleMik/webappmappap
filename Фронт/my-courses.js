const access = window.courseAccess.get();
if (!access) location.replace('courses.html' + location.search);
else document.querySelector('#access-plan').textContent = {basic:'Базовый', optimal:'Оптимальный', premium:'Премиум'}[access.plan];
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  document.querySelectorAll('[data-category]').forEach(card => { card.hidden = button.dataset.filter !== 'all' && card.dataset.category !== button.dataset.filter; });
}));
document.querySelector('.reset-payment').addEventListener('click', () => {
  try { localStorage.removeItem('webpril.demoCourseAccess'); } catch { return; }
  location.href = 'courses.html';
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  const handled = !window.dispatchEvent(new CustomEvent('today:navigate', { cancelable:true, detail: {destination:button.dataset.action} }));
  if (handled) return;
  const status = document.querySelector('.course-action-status');
  status.textContent = button.dataset.action === 'course-support' ? 'В демонстрационной версии связь с поддержкой ещё не подключена.' : 'Доступ открыт. Учебные материалы появятся здесь после подключения программы.';
  status.hidden = false;
  status.scrollIntoView({block:'nearest', behavior:'smooth'});
}));
