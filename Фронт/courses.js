(() => {
  const plans = document.querySelector('.plans');
  const status = document.querySelector('.selection-status');
  const retry = document.querySelector('.offers-retry');
  const dialog = document.querySelector('.offer-dialog');
  const plural = new Intl.PluralRules('ru');
  const price = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  const days = value => `${value} ${{ one: 'день', few: 'дня', many: 'дней', other: 'дня' }[plural.select(value)]}`;
  let pending = false;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showOffer(offer) {
    dialog.querySelector('h2').textContent = `Тариф «${offer.displayName}»`;
    dialog.querySelector('.offer-summary').textContent = price.format(offer.price);
    dialog.querySelector('.offer-items').replaceChildren(...offer.items.map(item => {
      const row = element('li');
      row.append(element('span', '', item.title), element('small', '', `Доступ — ${days(item.accessDays)}`));
      return row;
    }));
    dialog.showModal();
  }
  function createPlan(offer, index) {
    const card = element('article', `plan ${['basic', 'optimal', 'premium'][index] || ''}`);
    card.append(element('h3', '', offer.displayName), element('p', 'price', price.format(offer.price)));
    const trainings = offer.items.filter(item => item.type === 'training');
    const list = element('ul');
    list.append(element('li', '', `Учебных разделов: ${trainings.length}`));
    const periods = [...new Set(trainings.map(item => item.accessDays))];
    list.append(element('li', '', `Доступ к учебным материалам — ${periods.map(days).join(', ')}`));
    for (const item of offer.items.filter(item => item.type === 'groups')) {
      const title = item.productId === 3317400 ? 'Онлайн-встречи' : item.productId === 3317398 ? 'Telegram-чат' : item.title;
      list.append(element('li', '', `${title} — ${days(item.accessDays)}`));
    }
    const button = element('button', 'choose-plan', 'Состав тарифа');
    button.type = 'button';
    button.setAttribute('aria-label', `Состав тарифа «${offer.displayName}»`);
    button.addEventListener('click', () => showOffer(offer));
    card.append(list, button);
    return card;
  }
  function validOffers(value) {
    return Array.isArray(value) && value.length === 3 && value.every(offer =>
      Number.isSafeInteger(offer.offerId) && typeof offer.displayName === 'string' && offer.displayName &&
      Number.isFinite(offer.price) && offer.price >= 0 && offer.currency === 'RUB' &&
      Array.isArray(offer.items) && offer.items.length > 0 && offer.items.every(item =>
        Number.isSafeInteger(item.productId) && typeof item.title === 'string' && item.title &&
        ['training', 'groups'].includes(item.type) && Number.isSafeInteger(item.accessDays) && item.accessDays > 0));
  }
  async function load() {
    if (pending) return;
    pending = true;
    plans.replaceChildren();
    plans.setAttribute('aria-busy', 'true');
    status.hidden = false;
    status.textContent = 'Загружаем тарифы…';
    retry.hidden = true;
    try {
      const response = await fetch('/api/course-offers', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('courses_unavailable');
      const data = await response.json();
      if (!validOffers(data.offers)) throw new Error('invalid_catalog');
      plans.replaceChildren(...data.offers.map(createPlan));
      status.textContent = '';
      status.hidden = true;
    } catch {
      status.textContent = 'Не удалось загрузить тарифы. Попробуйте ещё раз.';
      retry.hidden = false;
    } finally {
      plans.setAttribute('aria-busy', 'false');
      pending = false;
    }
  }
  retry.addEventListener('click', load);
  dialog.querySelector('.payment-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  window.addEventListener('pagehide', () => { if (dialog.open) dialog.close(); });
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
})();
