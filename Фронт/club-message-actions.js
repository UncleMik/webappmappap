export function createMessageActions({ log, getMessage, canReply, onReply, onDelete }) {
  const menu = document.querySelector('#chat-message-menu');
  const replyButton = menu.querySelector('[data-chat-action="reply"]');
  const deleteButton = menu.querySelector('[data-chat-action="delete"]');
  const dialog = document.querySelector('#chat-delete-dialog');
  const confirm = document.querySelector('#chat-delete-confirm');
  const cancel = document.querySelector('#chat-delete-cancel');
  const error = document.querySelector('#chat-delete-error');
  let menuId, dialogId, anchor, anchorPosition, deleting = false, backdropDown = false, hold, holdId, point;
  function closeMenu(restore = false) {
    menu.hidden = true;
    menuId = null;
    if (anchor?.isConnected) { anchor.setAttribute('aria-expanded', 'false'); if (restore) anchor.focus(); }
  }
  function closeDialog() { if (dialog.open) dialog.close(); dialogId = null; }
  function stopHold() { clearTimeout(hold); holdId = null; point = null; }
  function open(id, button, position) {
    const message = getMessage(id);
    if (!message || message.deleted || dialog.open) return;
    closeMenu(); menuId = id; anchor = button;
    replyButton.disabled = !canReply(); deleteButton.hidden = !message.canDelete;
    menu.hidden = false; anchor?.setAttribute('aria-expanded', 'true');
    const box = button.getBoundingClientRect(), bounds = log.getBoundingClientRect();
    anchorPosition = { x: box.x, y: box.y };
    const x = position?.x ?? box.right, y = position?.y ?? box.bottom;
    menu.style.left = Math.max(bounds.left + 8, Math.min(x, bounds.right - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    [...menu.querySelectorAll('button')].find(b => !b.hidden && !b.disabled)?.focus();
  }
  replyButton.addEventListener('click', () => {
    const message = getMessage(menuId); closeMenu(); if (message && canReply()) onReply(message);
  });
  deleteButton.addEventListener('click', () => {
    const id = menuId, message = getMessage(id);
    if (!message?.canDelete) { closeMenu(); return; }
    closeMenu(); dialogId = id; error.textContent = ''; deleting = false; backdropDown = false;
    confirm.disabled = cancel.disabled = false; confirm.textContent = 'Удалить';
    dialog.showModal(); cancel.focus();
  });
  cancel.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    dialogId = null;
    if (menu.hidden && anchor?.isConnected) anchor.focus();
  });
  dialog.addEventListener('pointerdown', event => {
    const box = dialog.getBoundingClientRect();
    backdropDown = !deleting && event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (backdropDown && !deleting && event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeDialog();
    backdropDown = false;
  });
  confirm.addEventListener('click', async () => {
    if (deleting || !dialogId || !getMessage(dialogId)?.canDelete) return;
    const id = dialogId; deleting = true; confirm.disabled = cancel.disabled = true;
    confirm.textContent = 'Удаляем…'; error.textContent = '';
    try { if (await onDelete(id)) closeDialog(); }
    catch (failure) { if (dialog.open && dialogId === id) error.textContent = failure.message || 'Не удалось подтвердить удаление. Повторите попытку.'; }
    finally {
      if (dialogId === id) { deleting = false; confirm.disabled = cancel.disabled = false; confirm.textContent = 'Удалить'; }
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')].filter(button => !button.hidden && !button.disabled);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !anchor?.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) closeMenu(true); });
  log.addEventListener('scroll', () => {
    stopHold();
    if (!menu.hidden && anchor?.isConnected && anchorPosition) {
      const box = anchor.getBoundingClientRect();
      if (Math.abs(box.x - anchorPosition.x) > 1 || Math.abs(box.y - anchorPosition.y) > 1) closeMenu();
    }
  }, { passive: true });
  window.addEventListener('resize', () => { stopHold(); closeMenu(); });
  log.addEventListener('pointerdown', event => {
    if (!['touch', 'pen'].includes(event.pointerType) || event.button !== 0 || event.target.closest('button,a')) return;
    const article = event.target.closest('.discussion-message'); if (!article) return;
    stopHold(); holdId = article.dataset.id; point = { x: event.clientX, y: event.clientY };
    hold = setTimeout(() => { open(article.dataset.id, article.querySelector('.chat-message-more'), point); }, 550);
  });
  log.addEventListener('pointermove', event => { if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) stopHold(); });
  for (const type of ['pointerup', 'pointercancel']) log.addEventListener(type, stopHold);
  log.addEventListener('contextmenu', event => {
    const article = event.target.closest('.discussion-message'); if (!article) return;
    event.preventDefault(); stopHold(); open(article.dataset.id, article.querySelector('.chat-message-more'), { x: event.clientX, y: event.clientY });
  });
  return {
    attach(article, message) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-message-more';
      button.textContent = '⋮'; button.setAttribute('aria-label', 'Действия с сообщением');
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', () => { if (!menu.hidden && menuId === message.id) closeMenu(true); else open(message.id, button); });
      article.querySelector('.discussion-message-meta').append(button);
    },
    removed(id) { if (holdId === id) stopHold(); if (menuId === id) closeMenu(); if (dialogId === id) closeDialog(); },
    permissionsChanged() { closeMenu(); if (dialogId && !getMessage(dialogId)?.canDelete) closeDialog(); },
    reset() { stopHold(); closeMenu(); closeDialog(); deleting = false; },
  };
}
