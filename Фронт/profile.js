(() => {
  const notice = document.querySelector('.profile-notice');
  document.querySelectorAll('[data-pending]').forEach(button => {
    button.addEventListener('click', () => {
      notice.querySelector('p').textContent = `Раздел «${button.dataset.pending}» пока в разработке.`;
      notice.hidden = false;
    });
  });
  notice.querySelector('button').addEventListener('click', () => { notice.hidden = true; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') notice.hidden = true;
  });
})();

(() => {
  const dialog = document.querySelector('#support-dialog');
  const trigger = document.querySelector('#support-open');
  const close = dialog.querySelector('.calendar-close');
  const handle = dialog.querySelector('.calendar-drag-zone');
  const status = dialog.querySelector('.support-status');
  let savedScroll, savedStyles, drag, closing = false;
  function cleanup() {
    dialog.classList.remove('is-open', 'is-dragging');
    dialog.style.removeProperty('--drag-offset');
    if (savedStyles) {
      Object.assign(document.body.style, savedStyles);
      window.scrollTo(savedScroll.x, savedScroll.y);
      savedStyles = null;
    }
    closing = false;
    drag = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus({ preventScroll: true });
  }
  function hide() {
    if (!dialog.open || closing) return;
    closing = true;
    dialog.classList.remove('is-open', 'is-dragging');
    dialog.style.removeProperty('--drag-offset');
    setTimeout(() => dialog.close(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 270);
  }
  trigger.addEventListener('click', () => {
    if (dialog.open) return;
    document.querySelector('.profile-notice').hidden = true;
    status.hidden = true;
    savedScroll = { x: window.scrollX, y: window.scrollY };
    savedStyles = {};
    for (const key of ['position', 'top', 'left', 'right', 'width', 'overflow']) savedStyles[key] = document.body.style[key];
    Object.assign(document.body.style, { position: 'fixed', top: `-${savedScroll.y}px`, left: '0', right: '0', width: '100%', overflow: 'hidden' });
    dialog.showModal();
    dialog.querySelector('.calendar-content').scrollTop = 0;
    trigger.setAttribute('aria-expanded', 'true');
    close.focus({ preventScroll: true });
    requestAnimationFrame(() => requestAnimationFrame(() => { if (dialog.open && !closing) dialog.classList.add('is-open'); }));
  });
  close.addEventListener('click', hide);
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  dialog.addEventListener('close', cleanup);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) hide();
  });
  dialog.querySelectorAll('[data-support]').forEach(button => button.addEventListener('click', () => {
    status.textContent = `Поддержка в ${button.dataset.support} пока не подключена. Здесь появится ссылка для обращения.`;
    status.hidden = false;
  }));
  handle.addEventListener('pointerdown', event => {
    if (closing || !event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, offset: 0 };
    handle.setPointerCapture(event.pointerId);
    dialog.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.offset = Math.max(0, event.clientY - drag.y);
    dialog.style.setProperty('--drag-offset', `${drag.offset}px`);
  });
  function finish(event, cancelled = false) {
    if (!drag || drag.id !== event.pointerId) return;
    const offset = drag.offset;
    drag = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    dialog.classList.remove('is-dragging');
    if (!cancelled && offset > Math.min(100, dialog.offsetHeight * .18)) hide();
    else dialog.style.removeProperty('--drag-offset');
  }
  handle.addEventListener('pointerup', event => finish(event));
  handle.addEventListener('pointercancel', event => finish(event, true));
  handle.addEventListener('lostpointercapture', event => finish(event, true));
})();