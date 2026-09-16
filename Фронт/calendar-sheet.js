(() => {
  const dialog = document.querySelector('#journey-calendar');
  if (!dialog) return;

  const currentWeek = 27;
  const completedWeeks = 26;
  const grid = dialog.querySelector('.calendar-weeks');
  const tabs = [...dialog.querySelectorAll('[data-trimester]')];
  const dragZone = dialog.querySelector('.calendar-drag-zone');
  const closeButton = dialog.querySelector('.calendar-close');
  const detailsButton = dialog.querySelector('.calendar-details');
  const progressDetails = dialog.querySelector('.calendar-progress-details');
  const triggers = [...document.querySelectorAll('[data-action="calendar"]')];
  let selectedWeek = currentWeek;
  let opener = null;
  let scrollPosition = null;
  let bodyStyles = null;
  let closing = false;
  let drag = null;
  let closeTimer = null;
  let afterClose = null;

  triggers.forEach(button => {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', dialog.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => openCalendar(button));
  });

  function renderWeeks(trimester) {
    const starts = { 1: 1, 2: 14, 3: 28 };
    const start = starts[trimester];
    // Match the reference: show 20 weeks from the trimester start, including
    // the following trimester's preview; stop at week 40.
    const end = Math.min(start + 19, 40);
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
      button.setAttribute('aria-label', `${week}-я неделя${week <= completedWeeks ? ', пройдена' : week === currentWeek ? ', сейчас' : ''}`);
      if (week === currentWeek) button.setAttribute('aria-current', 'step');
      button.innerHTML = `<strong>${week}</strong><span>неделя</span>${week === currentWeek ? '<span class="week-now">Сейчас</span>' : ''}${week <= completedWeeks ? '<svg class="calendar-week-check" aria-hidden="true"><use href="#j-check"/></svg>' : ''}`;
      grid.append(button);
    }
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
  });

  function openCalendar(button) {
    if (dialog.open) return;
    opener = button;
    closing = false;
    afterClose = null;
    selectedWeek = currentWeek;
    renderWeeks(2);
    progressDetails.hidden = true;
    detailsButton.setAttribute('aria-expanded', 'false');
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

  detailsButton.setAttribute('aria-expanded', 'false');
  progressDetails.id = 'calendar-progress-details';
  detailsButton.setAttribute('aria-controls', progressDetails.id);
  detailsButton.addEventListener('click', () => {
    progressDetails.hidden = !progressDetails.hidden;
    detailsButton.setAttribute('aria-expanded', String(!progressDetails.hidden));
  });

  dialog.querySelector('.calendar-go-current').addEventListener('click', () => closeCalendar(() => {
    const current = document.querySelector('.journey-week');
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
