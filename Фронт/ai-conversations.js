// Drawer owns presentation and native modal focus; chat data stays in ai.js?v=20261112-stars.
export function createConversationMenu({ onOpen, onNew, onSelect, onMore, onRetry }) {
  const dialog = document.querySelector('#conversations-dialog');
  const openButton = document.querySelector('#conversations-open');
  const newButton = document.querySelector('#conversation-new');
  const list = document.querySelector('#conversations-list');
  const more = document.querySelector('#conversations-more');
  const status = document.querySelector('#conversations-status');
  const retry = document.querySelector('#conversations-retry');
  function close(restore = true) {
    if (dialog.open) dialog.close();
    openButton.setAttribute('aria-expanded', 'false');
    if (restore && !openButton.disabled) openButton.focus({ preventScroll: true });
  }
  function open() {
    if (openButton.disabled) return;
    if (!dialog.open) dialog.showModal();
    openButton.setAttribute('aria-expanded', 'true');
    newButton.focus({ preventScroll: true }); onOpen();
  }
  openButton.addEventListener('click', open);
  document.querySelector('#conversations-close').addEventListener('click', () => close());
  newButton.addEventListener('click', onNew);
  more.addEventListener('click', onMore); retry.addEventListener('click', onRetry);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  const moscowDay = time => new Date(time + 3 * 3_600_000).toISOString().slice(0, 10);
  function render(rows, activeId, hasMore) {
    const focusId = list.contains(document.activeElement) ? document.activeElement.dataset.conversationId : null;
    list.replaceChildren();
    const today = moscowDay(Date.now()), yesterday = moscowDay(Date.now() - 86_400_000);
    for (const group of ['Сегодня', 'Вчера', 'Ранее']) {
      const items = rows.filter(row => {
        const day = moscowDay(Date.parse(row.updatedAt));
        return (day === today ? 'Сегодня' : day === yesterday ? 'Вчера' : 'Ранее') === group;
      });
      if (!items.length) continue;
      const section = document.createElement('section'); section.className = 'conversation-group';
      const heading = document.createElement('h3'); heading.textContent = group; section.append(heading);
      for (const row of items) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'conversation-choice';
        button.dataset.conversationId = row.id; button.textContent = row.title;
        if (row.id === activeId) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => onSelect(row.id)); section.append(button);
      }
      list.append(section);
    }
    more.hidden = !hasMore;
    if (focusId) [...list.querySelectorAll('button')].find(button => button.dataset.conversationId === focusId)?.focus({ preventScroll: true });
  }
  return {
    open, close, render,
    setEnabled(value) { openButton.disabled = !value; if (!value) close(false); },
    setBusy(value) { more.disabled = retry.disabled = value; },
    setCreating(value) { newButton.disabled = value; },
    notice(message, canRetry = false) { status.textContent = message; status.hidden = !message; retry.hidden = !canRetry; },
    reset() { close(false); list.replaceChildren(); status.textContent = ''; status.hidden = retry.hidden = more.hidden = true; newButton.disabled = false; openButton.disabled = true; },
  };
}
