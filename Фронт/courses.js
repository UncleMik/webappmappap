// Editorial highlights from the school lesson inventory; product IDs keep each
// description tied to the actual offer composition. This never grants access.
const programHighlights = {
  8835218: [
    [[4309095], 'Подготовка к родам', 'Как распознать начало родов, когда ехать в роддом и что взять с собой.'],
    [[4309095], 'Дыхание и облегчение схваток', 'Практики дыхания, удобные позы, массаж и подготовка к потугам.'],
    [[4309095], 'Спокойный настрой', 'Упражнения для работы со страхами и тревогами перед родами.'],
    [[4307012], 'Первые месяцы с малышом', 'Уход за ребёнком от рождения до года и аптечка для новорождённого.'],
    [[4307003, 4516222], 'Развитие малыша до года', 'Особенности развития на этапах от рождения до 6 месяцев и от 6 до 12 месяцев.'],
  ],
  8835266: [
    [[4302509], 'Подготовка к родам', 'Начало родов, дыхание в схватках, позы, массаж и подготовка к потугам.'],
    [[4302509], 'Грудное вскармливание', 'Прикладывание, удобные позы, организация кормлений и частые трудности с ГВ.'],
    [[4302509], 'Уход за новорождённым', 'Купание, гигиена, пеленание, колики и способы успокоить малыша.'],
    [[4302520], 'Сон ребёнка', 'Безопасные условия сна, возрастные нормы, режим и ритуалы засыпания.'],
    [[4302575, 4302584], 'Развитие до первого дня рождения', 'Этапы развития малыша от рождения до 6 месяцев и от 6 месяцев до года.'],
    [[4302620], 'Вакцинация и иммунитет', 'Уроки о детском иммунитете и вакцинации.'],
  ],
  8835331: [
    [[4302509], 'Роды и грудное вскармливание', 'Дыхание, облегчение схваток, подготовка к потугам и организация ГВ.'],
    [[4302520, 4302575, 4302584], 'Сон и развитие малыша', 'Режим, ритуалы засыпания и этапы развития ребёнка до года.'],
    [[4302523, 4302526], 'Прикорм и завершение ГВ', 'Готовность к прикорму, введение продуктов, кусочки и завершение кормлений.'],
    [[4302617], 'Первая помощь малышу', 'Разбор ситуаций, когда ребёнок подавился, получил ожог или перегрелся.'],
    [[4302529], 'Восстановление после родов', 'Тазовое дно, восстановление после кесарева сечения и бережные практики для тела.'],
    [[3317400, 3317398], 'Поддержка специалистов', 'Участие в онлайн-встречах и доступ к Telegram-чату на 60 дней.'],
  ],
};

export function mountCourseOffers(container) {
  const plans = container.querySelector('.plans');
  const status = container.querySelector('.selection-status');
  const retry = container.querySelector('.offers-retry');
  const programs = container.querySelector('.offer-programs');
  const programList = programs.querySelector('.offer-program-list');
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
  function createProgram(offer) {
    const program = element('section', 'offer-program');
    program.id = `program-${offer.offerId}`;
    const title = element('h3', '', offer.displayName);
    title.id = `${program.id}-title`;
    program.setAttribute('aria-labelledby', title.id);
    const items = element('ul', 'offer-items');
    const productIds = new Set(offer.items.map(item => item.productId));
    const highlights = (programHighlights[offer.offerId] || [])
      .filter(([ids]) => ids.every(id => productIds.has(id)));
    for (const [, title, description] of highlights) {
      const row = element('li');
      row.append(element('strong', '', title), element('small', '', description));
      items.append(row);
    }
    program.append(title, items);
    return program;
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
    const link = element('a', 'choose-plan', 'Программа');
    link.href = `#program-${offer.offerId}`;
    link.setAttribute('aria-label', `Программа тарифа «${offer.displayName}»`);
    const purchase = element('a', 'choose-plan offer-purchase', 'Купить на сайте школы');
    purchase.href = 'https://legkie-rody.ru/tarif';
    card.append(list, link, purchase);
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
    programs.hidden = true;
    programList.replaceChildren();
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
      programList.replaceChildren(...data.offers.map(createProgram));
      programs.hidden = false;
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
  load();
  return load;
}

const standalone = document.querySelector('.courses-main');
if (standalone) {
  const reload = mountCourseOffers(standalone);
  window.addEventListener('pageshow', event => { if (event.persisted) reload(); });
}
