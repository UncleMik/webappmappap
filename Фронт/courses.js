const plans = { basic: ['Базовый', '2 990'], optimal: ['Оптимальный', '4 990'], premium: ['Премиум', '7 990'] };
const payment = document.querySelector('.payment-dialog');
let selectedPlan;
if (window.courseAccess.get()) location.replace('my-courses.html' + location.search);
document.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => {
  selectedPlan = button.dataset.plan;
  const [name, price] = plans[selectedPlan];
  payment.querySelector('.payment-summary').textContent = `Тариф «${name}» · ${price} ₽ · единоразово`;
  payment.querySelector('.payment-error').hidden = true;
  payment.showModal();
}));
payment.querySelector('.payment-cancel').addEventListener('click', () => payment.close());
payment.addEventListener('click', event => { if (event.target === payment) { const r = payment.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) payment.close(); } });
payment.querySelector('.payment-confirm').addEventListener('click', () => {
  if (window.courseAccess.grant(selectedPlan)) location.href = 'my-courses.html' + location.search;
  else { const error = payment.querySelector('.payment-error'); error.textContent = 'Разрешите хранение данных в браузере, чтобы сохранить тестовую оплату.'; error.hidden = false; }
});
