const choices = [
  { id: 'heart', emoji: '❤️', label: 'Сердце' },
  { id: 'love', emoji: '🥰', label: 'Улыбка с сердечками' },
  { id: 'like', emoji: '👍', label: 'Палец вверх' },
];

export function createReactionControls({ root, onSelect }) {
  const entries = new Map();
  const picker = document.createElement('div');
  picker.className = 'reaction-picker'; picker.id = 'reaction-picker'; picker.hidden = true;
  picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'Выберите реакцию');
  let target, busy = false, focusReturn;
  function close(restore = false) {
    const trigger = target?.bar.querySelector('.add-reaction');
    trigger?.setAttribute('aria-expanded', 'false');
    target = null; picker.hidden = true;
    if (restore && trigger?.isConnected && !trigger.disabled) trigger.focus();
  }
  function select(entry, reaction) {
    if (busy) return;
    focusReturn = entry; close();
    onSelect(entry.message.id, entry.state.selected === reaction ? null : reaction);
  }
  function open(entry) {
    if (busy) return;
    if (target === entry) { close(true); return; }
    close(); target = entry;
    const trigger = entry.bar.querySelector('.add-reaction');
    trigger.setAttribute('aria-expanded', 'true');
    picker.replaceChildren();
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reaction-option'; button.textContent = choice.emoji;
      button.title = choice.label; button.setAttribute('aria-label', choice.label);
      button.setAttribute('aria-pressed', String(entry.state.selected === choice.id));
      button.addEventListener('click', () => select(entry, choice.id)); picker.append(button);
    }
    entry.bar.append(picker); picker.hidden = false;
    const anchor = trigger.getBoundingClientRect(), panel = picker.getBoundingClientRect();
    const column = root.getBoundingClientRect();
    const left = Math.max(8, column.left + 4), right = Math.min(innerWidth - 8, column.right - 4);
    picker.style.left = Math.max(left, Math.min(anchor.left, right - panel.width)) + 'px';
    picker.style.top = Math.max(8, anchor.top >= panel.height + 16
      ? anchor.top - panel.height - 8 : Math.min(anchor.bottom + 8, innerHeight - panel.height - 8)) + 'px';
    const active = picker.querySelector('[aria-pressed="true"]') || picker.firstElementChild;
    active.focus({ preventScroll: true });
  }
  function draw(entry) {
    const popupOpen = target === entry;
    const popupFocus = popupOpen && picker.contains(document.activeElement)
      ? [...picker.children].indexOf(document.activeElement) : -1;
    const focused = entry.bar.contains(document.activeElement) && !picker.contains(document.activeElement)
      ? document.activeElement.dataset.reaction : undefined;
    // Keep a currently open choice panel and its focus when polling refreshes counts.
    if (popupOpen) picker.remove();
    entry.bar.replaceChildren();
    for (const choice of choices) {
      const count = entry.state.counts[choice.id];
      if (!count) continue;
      const selected = entry.state.selected === choice.id;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'reaction'; button.dataset.reaction = choice.id;
      button.setAttribute('aria-pressed', String(selected)); button.disabled = busy;
      button.setAttribute('aria-label', `${choice.label}: ${count}. ${selected ? 'Ваша реакция. Нажмите, чтобы убрать.' : 'Нажмите, чтобы поставить.'}`);
      const emoji = document.createElement('span'), total = document.createElement('span');
      emoji.className = 'reaction-emoji'; emoji.textContent = choice.emoji; emoji.setAttribute('aria-hidden', 'true');
      total.className = 'reaction-count'; total.textContent = String(count); total.setAttribute('aria-hidden', 'true');
      button.append(emoji, total); button.addEventListener('click', () => select(entry, choice.id)); entry.bar.append(button);
    }
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'add-reaction'; add.disabled = busy; add.dataset.reaction = 'add';
    add.setAttribute('aria-label', 'Выбрать реакцию на сообщение: ' + entry.message.text.slice(0, 60));
    add.title = 'Выбрать реакцию'; add.setAttribute('aria-haspopup', 'dialog');
    add.setAttribute('aria-controls', picker.id); add.setAttribute('aria-expanded', 'false');
    add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 14.5A9 9 0 1 1 14.5 3.4M8 14s1 2 4 2 4-2 4-2M8 9h.01M14 9h.01M19 2v6M16 5h6"/></svg>';
    add.addEventListener('click', () => open(entry)); entry.bar.append(add);
    if (popupOpen) {
      add.setAttribute('aria-expanded', 'true'); entry.bar.append(picker);
      [...picker.children].forEach((button, index) => button.setAttribute('aria-pressed', String(entry.state.selected === choices[index].id)));
      if (popupFocus >= 0) picker.children[popupFocus].focus({ preventScroll: true });
    }
    if (focused) (entry.bar.querySelector(`[data-reaction="${focused}"]`) || add).focus({ preventScroll: true });
  }
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...picker.children];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });
  picker.addEventListener('focusout', event => {
    if (event.relatedTarget && !picker.contains(event.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', event => {
    if (target && !picker.contains(event.target) && !target.bar.querySelector('.add-reaction').contains(event.target)) close();
  });
  root.addEventListener('scroll', () => close(), { passive: true });
  window.addEventListener('resize', () => close());
  return {
    add(message, bubble) {
      const bar = document.createElement('div'); bar.className = 'message-reactions';
      bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Реакции на сообщение');
      const entry = { message, bar, state: { counts: { heart: 0, love: 0, like: 0 }, selected: null } };
      entries.set(message.id, entry); bubble.append(bar); draw(entry);
    },
    update(states) {
      if (!Array.isArray(states)) throw new Error('Не удалось загрузить реакции. Повторите подключение.');
      for (const state of states) {
        if (typeof state?.messageId !== 'string' || !choices.every(choice => Number.isSafeInteger(state.counts?.[choice.id]) && state.counts[choice.id] >= 0)
          || (state.selected !== null && !choices.some(choice => choice.id === state.selected && state.counts[choice.id] > 0))) {
          throw new Error('Не удалось загрузить реакции. Повторите подключение.');
        }
        const entry = entries.get(state.messageId);
        if (!entry || JSON.stringify(entry.state) === JSON.stringify({ counts: state.counts, selected: state.selected })) continue;
        entry.state = { counts: state.counts, selected: state.selected }; draw(entry);
      }
    },
    visibleIds() {
      const bounds = root.getBoundingClientRect();
      return [...entries.values()].filter(entry => {
        const rect = entry.bar.closest('article').getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }).slice(0, 100).map(entry => entry.message.id);
    },
    setBusy(value) {
      busy = value;
      root.querySelectorAll('.message-reactions button').forEach(button => { button.disabled = value; });
      if (!value && focusReturn && document.activeElement === document.body) {
        focusReturn.bar.querySelector('.add-reaction')?.focus({ preventScroll: true });
      }
      if (!value) focusReturn = null;
    },
    clear() { close(); picker.remove(); entries.clear(); busy = false; focusReturn = null; },
  };
}
