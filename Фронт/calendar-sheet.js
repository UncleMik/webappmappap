(() => {
  const dialog = document.querySelector('#journey-calendar');
  if (!dialog) return;

  const currentWeek = 27;
  // Demonstration events supplied in the user's calendar reference.
  const events = {
    8: [{ type: 'visit', title: 'Приём' }, { type: 'tests', title: 'Анализы' }],
    11: [
      { type: 'scan', title: 'УЗИ', description: 'I скрининг. Период: 11–13 недель 6 дней.' },
      { type: 'tests', title: 'Анализы', description: 'Биохимическая часть I скрининга.' }
    ],
    18: [
      { type: 'scan', title: 'УЗИ', description: 'II скрининг. Период: 18–20 недель 6 дней.' },
      { type: 'tests', title: 'Анализы', description: 'При Rh-отрицательной крови: контроль антител. Период: 18–20 недель.' }
    ],
    20: [{ type: 'study', title: 'Подготовка' }],
    24: [{ type: 'tests', title: 'Анализы' }]
  };
  const icons = {
    visit: '<rect x="5" y="6" width="14" height="15" rx="2"/><path d="M8 3v6m8-6v6M5 11h14"/>',
    tests: '<path d="M9 3h6M10 3v7L5 19a1 1 0 0 0 1 2h12a1 1 0 0 0 1-2l-5-9V3M8 15h8"/>',
    scan: '<path d="m7 4-4 14q9 6 18 0L17 4q-5 3-10 0Z"/><circle cx="12" cy="13" r="3"/>',
    study: '<path d="m2 8 10-5 10 5-10 5-10-5ZM6 10v7q6 5 12 0v-7M22 8v9"/>'
  };
  const icon = type => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[type]}</svg>`;
  const grid = dialog.querySelector('.calendar-weeks');
  const tabs = [...dialog.querySelectorAll('[data-trimester]')];
  const dragZone = dialog.querySelector('.calendar-drag-zone');
  const closeButton = dialog.querySelector('.calendar-close');
  const triggers = [...document.querySelectorAll('[data-action="calendar"]')];
  let selectedWeek = currentWeek;
  let opener = null;
  let scrollPosition = null;
  let bodyStyles = null;
  let closing = false;
  let drag = null;
  let closeTimer = null;
  let afterClose = null;

  function renderImportant() {
    const content = dialog.querySelector('.calendar-important-content');
    const items = events[selectedWeek] || [];
    content.innerHTML = items.length ? items.map(item => `<article class="calendar-event"><span class="calendar-event-icon ${item.type}">${icon(item.type)}</span><div><h4>${item.title}</h4>${item.description ? `<p>${item.description}</p>` : ''}</div></article>`).join('') : '<p class="calendar-empty">События этой недели пока не добавлены.</p>';
    if (selectedWeek === 11) content.insertAdjacentHTML('beforeend', '<p class="calendar-note"><span aria-hidden="true">i</span>Постановку на учёт и стартовые анализы желательно пройти до 10–12 недель.</p>');
    if (selectedWeek === 18) content.insertAdjacentHTML('beforeend', '<p class="calendar-note"><span aria-hidden="true">i</span>Подготовку к родам удобно начинать с 20–24 недель.</p>');
    dialog.querySelector('.calendar-go-current').setAttribute('aria-label', `Перейти к материалам ${selectedWeek}-й недели`);
  }

  triggers.forEach(button => {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', dialog.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      // A wheel neighbor selects a week; only the centered week opens the calendar.
      if (button.classList.contains('week-option') && Number(button.dataset.week) !== Number(document.querySelector('#journey')?.dataset.week)) return;
      openCalendar(button);
    });
  });

  function renderWeeks(trimester) {
    const ranges = { 1: [1, 13], 2: [14, 27], 3: [28, 42] };
    const [start, end] = ranges[trimester];
    if (selectedWeek < start || selectedWeek > end) selectedWeek = start;
    tabs.forEach(tab => {
      const active = Number(tab.dataset.trimester) === trimester;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    grid.setAttribute('aria-labelledby', `trimester-${trimester}`);
    grid.replaceChildren();
    for (let week = start; week <= end; week++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-week';
      button.dataset.week = week;
      button.setAttribute('aria-pressed', String(week === selectedWeek));
      button.setAttribute('aria-label', `${week}-я неделя${week === currentWeek ? ', сейчас' : ''}${events[week] ? ', ' + events[week].map(item => item.title).join(', ') : ''}`);
      if (week === currentWeek) button.setAttribute('aria-current', 'step');
      button.innerHTML = `<strong>${week}</strong><span>неделя</span>${events[week] ? `<span class="calendar-week-events">${events[week].map(item => `<span class="calendar-week-event ${item.type}">${icon(item.type)}<span>${item.title}</span></span>`).join('')}</span>` : ''}${week === currentWeek ? '<span class="week-now">Сейчас</span>' : ''}`;
      grid.append(button);
    }
    renderImportant();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => renderWeeks(Number(tab.dataset.trimester)));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      renderWeeks(Number(tabs[next].dataset.trimester));
      tabs[next].focus();
    });
  });

  grid.addEventListener('click', event => {
    const button = event.target.closest('[data-week]');
    if (!button) return;
    selectedWeek = Number(button.dataset.week);
    grid.querySelectorAll('[data-week]').forEach(week => week.setAttribute('aria-pressed', String(week === button)));
    renderImportant();
  });

  function openWeek(week) {
    if (document.querySelector('#journey')) {
      window.dispatchEvent(new CustomEvent('journey:select-week', { detail: { week } }));
    } else {
      location.href = 'journey.html?week=' + week;
    }
  }

  function openCalendar(button) {
    if (dialog.open) return;
    opener = button;
    closing = false;
    afterClose = null;
    selectedWeek = Number(document.querySelector('#journey')?.dataset.week) || currentWeek;
    renderWeeks(selectedWeek <= 13 ? 1 : selectedWeek <= 27 ? 2 : 3);
    scrollPosition = { x: window.scrollX, y: window.scrollY };
    bodyStyles = {};
    for (const property of ['position', 'top', 'left', 'right', 'width', 'overflow']) bodyStyles[property] = document.body.style[property];
    Object.assign(document.body.style, { position: 'fixed', top: `-${scrollPosition.y}px`, left: '0', right: '0', width: '100%', overflow: 'hidden' });
    dialog.style.removeProperty('--drag-offset');
    dialog.showModal();
    dialog.querySelector('.calendar-content').scrollTop = 0;
    triggers.forEach(trigger => trigger.setAttribute('aria-expanded', 'true'));
    closeButton.focus({ preventScroll: true });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (dialog.open && !closing) dialog.classList.add('is-open');
    }));
  }

  function cleanup() {
    if (!scrollPosition) return;
    clearTimeout(closeTimer);
    dialog.classList.remove('is-open', 'is-dragging');
    dialog.style.removeProperty('--drag-offset');
    Object.assign(document.body.style, bodyStyles);
    window.scrollTo(scrollPosition.x, scrollPosition.y);
    scrollPosition = null;
    bodyStyles = null;
    drag = null;
    closing = false;
    triggers.forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    const callback = afterClose;
    afterClose = null;
    callback?.();
  }

  function closeCalendar(callback = null) {
    if (!dialog.open || closing) return;
    closing = true;
    afterClose = callback;
    drag = null;
    dialog.classList.remove('is-open', 'is-dragging');
    dialog.style.removeProperty('--drag-offset');
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 270;
    closeTimer = setTimeout(() => {
      dialog.close();
      cleanup();
    }, duration);
  }

  closeButton.addEventListener('click', () => closeCalendar());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeCalendar();
  });
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientY < bounds.top || event.clientY > bounds.bottom || event.clientX < bounds.left || event.clientX > bounds.right) closeCalendar();
  });

  dialog.querySelector('.calendar-go-current').addEventListener('click', () => closeCalendar(() => {
    openWeek(selectedWeek);
    const current = document.querySelector('.journey-week');
    if (!current) return;
    current.setAttribute('tabindex', '-1');
    current.focus({ preventScroll: true });
    current.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }));

  dragZone.addEventListener('pointerdown', event => {
    if (closing || !event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, start: performance.now(), offset: 0 };
    dragZone.setPointerCapture(event.pointerId);
    dialog.classList.add('is-dragging');
  });
  dragZone.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.offset = Math.max(0, event.clientY - drag.y);
    dialog.style.setProperty('--drag-offset', `${drag.offset}px`);
  });
  function finishDrag(event, cancelled = false) {
    if (!drag || drag.id !== event.pointerId) return;
    const { offset, start } = drag;
    drag = null;
    if (dragZone.hasPointerCapture(event.pointerId)) dragZone.releasePointerCapture(event.pointerId);
    dialog.classList.remove('is-dragging');
    const velocity = offset / Math.max(1, performance.now() - start);
    if (!cancelled && (offset > Math.min(100, dialog.offsetHeight * .18) || (offset > 35 && velocity > .55))) {
      closeCalendar();
    } else {
      dialog.style.removeProperty('--drag-offset');
    }
  }
  dragZone.addEventListener('pointerup', event => finishDrag(event));
  dragZone.addEventListener('pointercancel', event => finishDrag(event, true));
  dragZone.addEventListener('lostpointercapture', event => finishDrag(event, true));
})();
