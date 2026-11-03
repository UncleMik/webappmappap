import { appendMessageText } from './club-chat-tools.js?v=20261103-chat';

const validId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value);
const dayKey = date => [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
function dayLabel(date) {
  const today = new Date(), yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return 'Сегодня';
  if (dayKey(date) === dayKey(yesterday)) return 'Вчера';
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
}

export function createChatTimeline({ log, messages, deletedIds, reactions, actions, canSend, onReply, onJump }) {
  let unreadStart = null, highlightTimer;
  const articles = () => [...log.querySelectorAll(':scope > article[data-id]')];
  const find = id => articles().find(article => article.dataset.id === id);
  function snapshot() {
    const bounds = log.getBoundingClientRect();
    const article = articles().find(node => node.getBoundingClientRect().bottom > bounds.top + 2);
    return article ? { messageId: article.dataset.id, offset: article.getBoundingClientRect().top - bounds.top } : null;
  }
  function restore(place) {
    const article = place && find(place.messageId); if (!article) return false;
    log.scrollTop += article.getBoundingClientRect().top - log.getBoundingClientRect().top - (Number(place.offset) || 0);
    return true;
  }
  function decorate() {
    log.querySelectorAll('.chat-date-divider,.chat-unread-divider').forEach(node => node.remove());
    let previousDay, unreadAdded = false;
    for (const article of articles()) {
      const message = messages.get(article.dataset.id), date = new Date(message.createdAt), key = dayKey(date);
      if (key !== previousDay) {
        const divider = document.createElement('p'); divider.className = 'chat-date-divider';
        divider.textContent = dayLabel(date); divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', divider.textContent);
        article.before(divider); previousDay = key;
      }
      if (!unreadAdded && unreadStart && BigInt(message.id) >= BigInt(unreadStart)) {
        const divider = document.createElement('p'); divider.id = 'chat-unread-divider'; divider.className = 'chat-unread-divider';
        divider.textContent = 'Новые сообщения'; divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', 'Новые сообщения');
        article.before(divider); unreadAdded = true;
      }
    }
  }
  function render(list, { replace = false, prepend = false, follow = false } = {}) {
    // An idle poll must not reannounce unchanged date separators in the live log.
    if (!replace && !list.length) return;
    const place = snapshot(), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (replace) { reactions.clear(); actions.reset(); messages.clear(); log.replaceChildren(); }
    for (const original of list) {
      if (!validId(original?.id) || typeof original.author?.name !== 'string') throw new Error('Не удалось прочитать сообщение.');
      if (original.deleted || deletedIds.has(original.id)) continue;
      if (typeof original.text !== 'string' || !Number.isFinite(Date.parse(original.createdAt))) throw new Error('Не удалось прочитать сообщение.');
      const message = original.reply && deletedIds.has(original.reply.id)
        ? { ...original, reply: { ...original.reply, text: null, deleted: true } } : original;
      const article = document.createElement('article'); article.className = 'discussion-message' + (message.own ? ' own-message' : '');
      article.dataset.id = message.id; article.tabIndex = -1;
      if (!message.own) {
        const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = message.author.name.split(/\s+/u).slice(0, 2).map(part => part[0] || '').join(''); article.append(avatar);
      }
      const bubble = document.createElement('div'); bubble.className = 'discussion-bubble';
      const author = document.createElement('h2'); author.textContent = message.own ? 'Вы' : message.author.name; bubble.append(author);
      if (message.reply) {
        const quote = document.createElement('blockquote'), name = document.createElement('strong'), text = document.createElement('span');
        name.textContent = message.reply.authorName; text.textContent = message.reply.deleted ? 'Сообщение удалено' : message.reply.text.slice(0, 200);
        if (message.reply.deleted) quote.append(text);
        else {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-quote-link';
          button.setAttribute('aria-label', 'Перейти к сообщению: ' + message.reply.authorName);
          button.append(name, text); button.addEventListener('click', () => onJump(message.reply.id)); quote.append(button);
        }
        bubble.append(quote);
      }
      const text = document.createElement('p'); appendMessageText(text, message.text); bubble.append(text);
      const footer = document.createElement('footer'), replyButton = document.createElement('button'), time = document.createElement('time');
      reactions.add(message, footer);
      replyButton.type = 'button'; replyButton.className = 'chat-reply-button'; replyButton.textContent = 'Ответить';
      replyButton.setAttribute('aria-label', 'Ответить на сообщение: ' + message.text.slice(0, 60)); replyButton.disabled = !canSend();
      replyButton.addEventListener('click', () => onReply(messages.get(message.id) || message));
      time.dateTime = message.createdAt;
      time.textContent = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
      time.title = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
      time.setAttribute('aria-label', time.title);
      const metadata = document.createElement('span'); metadata.className = 'discussion-message-meta'; metadata.append(time);
      footer.append(replyButton, metadata); bubble.append(footer); article.append(bubble); actions.attach(article, message);
      const existing = find(message.id), next = articles().find(child => BigInt(child.dataset.id) > BigInt(message.id));
      if (existing) existing.replaceWith(article); else log.insertBefore(article, next || null);
      messages.set(message.id, message);
    }
    decorate();
    if (follow || (!replace && !prepend && atBottom)) log.scrollTop = log.scrollHeight;
    else if (!replace) restore(place);
  }
  return {
    snapshot, restore, find,
    setUnread(id) { unreadStart = validId(id) ? id : null; const place = snapshot(); decorate(); restore(place); },
    render,
    clear() { clearTimeout(highlightTimer); reactions.clear(); actions.reset(); messages.clear(); log.replaceChildren(); },
    remove(id) {
      const place = snapshot(); deletedIds.add(id); messages.delete(id); actions.removed(id); reactions.remove(id); find(id)?.remove();
      const affected = [...messages.values()].filter(message => message.reply?.id === id && !message.reply.deleted);
      if (affected.length) render(affected.map(message => ({ ...message, reply: { ...message.reply, text: null, deleted: true } })), { prepend: true });
      else decorate();
      restore(place);
    },
    show(id, { offset, highlight = false } = {}) {
      const article = find(id); if (!article) return false;
      const bounds = log.getBoundingClientRect(), box = article.getBoundingClientRect();
      log.scrollTop += box.top - bounds.top - (offset ?? Math.max(16, (bounds.height - Math.min(box.height, bounds.height)) / 2));
      if (highlight) {
        clearTimeout(highlightTimer); log.querySelectorAll('.chat-message-highlight').forEach(node => node.classList.remove('chat-message-highlight'));
        article.classList.add('chat-message-highlight'); article.focus({ preventScroll: true });
        highlightTimer = setTimeout(() => article.classList.remove('chat-message-highlight'), 2500);
      }
      return true;
    },
    visibleLastId() {
      const bounds = log.getBoundingClientRect(); let last = null;
      for (const article of articles()) {
        const box = article.getBoundingClientRect();
        if (box.bottom > bounds.top + 4 && box.bottom <= bounds.bottom + 2 && box.top < bounds.bottom - 4) last = article.dataset.id;
      }
      return last;
    },
    atBottom: () => log.scrollHeight - log.scrollTop - log.clientHeight < 80,
    firstId: () => articles()[0]?.dataset.id,
    lastId: () => articles().at(-1)?.dataset.id,
  };
}
