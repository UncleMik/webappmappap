import { clubRequest, chatLease } from './club-api.js?v=20261029-chat';
import { createReactionControls } from './chat-reactions.js?v=20261029-reactions';

const room = new URLSearchParams(location.search).get('room');
if (room !== 'pregnancy-students') {
  location.replace('club.html#' + (room?.startsWith('motherhood-') || room?.startsWith('baby-') || room === 'moms' ? 'motherhood' : 'pregnancy'));
} else {
  const log = document.querySelector('#chat-messages'), status = document.querySelector('#chat-status');
  const controls = document.querySelector('#chat-controls'), form = document.querySelector('#chat-form');
  const input = document.querySelector('#chat-text'), sendButton = document.querySelector('#chat-send');
  const history = document.querySelector('#chat-history'), retry = document.querySelector('#chat-retry');
  const courses = document.querySelector('#chat-courses'), replyPreview = document.querySelector('#chat-reply');
  const reactionStatus = document.querySelector('#reaction-status');
  const messages = new Map();
  const reactionControls = createReactionControls({ root: log, onSelect: setReaction });
  let reactionEpoch = 0, reacting = false;
  let revision = 0, controller, timer, leaseTimer, accountId, cursor, oldest, reply, pending, busy = false, ended = false;
  const current = value => value === revision && !document.hidden && !ended;
  function clear() {
    revision++; controller?.abort(); clearTimeout(timer); clearTimeout(leaseTimer);
    reactionEpoch++; reacting = false; reactionControls.clear(); reactionStatus.textContent = '';
    messages.clear(); log.replaceChildren(); cursor = oldest = null; reply = null;
    replyPreview.hidden = true; controls.hidden = true; history.hidden = true; busy = false;
    retry.hidden = true; courses.hidden = true;
  }
  function meta(data) {
    const remaining = chatLease(data, accountId); accountId = data.accountId;
    clearTimeout(leaseTimer); leaseTimer = setTimeout(start, remaining);
  }
  function failure(error) {
    clear(); status.textContent = error.message;
    if (error.status === 401 || error.code === 'account_changed') {
      input.value = ''; pending = null; ended = true; window.webprilSessionGate?.end();
    } else if (error.code === 'club_course_required') { courses.hidden = false; }
    else retry.hidden = false;
  }
  function chooseReply(message) {
    reply = message;
    replyPreview.querySelector('p').textContent = message.author.name + ': ' + message.text.slice(0, 160);
    replyPreview.hidden = false; input.focus();
  }
  function render(list, { prepend = false, ownSend = false } = {}) {
    const height = log.scrollHeight, top = log.scrollTop;
    const bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    for (const message of list) {
      if (messages.has(message.id)) continue;
      if (!/^[1-9]\d{0,18}$/.test(message.id) || typeof message.text !== 'string' || typeof message.author?.name !== 'string') throw new Error('Не удалось прочитать сообщение.');
      const article = document.createElement('article'); article.className = 'discussion-message' + (message.own ? ' own-message' : '');
      article.dataset.id = message.id;
      if (!message.own) {
        const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = message.author.name.split(/\s+/u).slice(0, 2).map(part => part[0] || '').join(''); article.append(avatar);
      }
      const bubble = document.createElement('div'); bubble.className = 'discussion-bubble';
      const author = document.createElement('h2'); author.textContent = message.own ? 'Вы' : message.author.name; bubble.append(author);
      if (message.reply) {
        const quote = document.createElement('blockquote'), name = document.createElement('strong'), text = document.createElement('span');
        name.textContent = message.reply.authorName; text.textContent = message.reply.text.slice(0, 200); quote.append(name, text); bubble.append(quote);
      }
      const text = document.createElement('p'); text.textContent = message.text; bubble.append(text);
      reactionControls.add(message, bubble);
      const footer = document.createElement('footer'), replyButton = document.createElement('button'), time = document.createElement('time');
      replyButton.type = 'button'; replyButton.className = 'chat-reply-button'; replyButton.textContent = 'Ответить';
      replyButton.setAttribute('aria-label', 'Ответить на сообщение: ' + message.text.slice(0, 60));
      replyButton.addEventListener('click', () => chooseReply(message));
      time.dateTime = message.createdAt;
      time.textContent = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
      footer.append(replyButton, time); bubble.append(footer); article.append(bubble);
      const next = [...log.children].find(child => BigInt(child.dataset.id) > BigInt(message.id));
      log.insertBefore(article, next || null); messages.set(message.id, message);
    }
    if (prepend) log.scrollTop = top + log.scrollHeight - height;
    else if (bottom || ownSend) log.scrollTop = log.scrollHeight;
  }
  function options(body) { return { accountId, signal: controller.signal, ...(body ? { body } : {}) }; }
  function applyReactions(data, epoch) {
    if (!reacting && epoch === reactionEpoch) reactionControls.update(data.reactions);
  }
  async function syncReactions(value) {
    const messageIds = reactionControls.visibleIds();
    if (!messageIds.length || reacting || !current(value)) return;
    const epoch = reactionEpoch;
    const data = await clubRequest('club/reactions/read', options({ messageIds }));
    if (!current(value)) return;
    meta(data); applyReactions(data, epoch);
  }
  async function setReaction(messageId, reaction) {
    if (reacting || controls.hidden || ended) return;
    const value = revision;
    reacting = true; reactionEpoch++; reactionControls.setBusy(true);
    reactionStatus.textContent = 'Сохраняем реакцию…';
    try {
      const data = await clubRequest('club/reactions', options({ messageId, reaction }));
      if (!current(value)) return;
      meta(data); reactionEpoch++; reactionControls.update(data.reactions);
      reactionStatus.textContent = reaction === null ? 'Реакция убрана.' : 'Реакция сохранена.';
    } catch (error) {
      if (!current(value)) return;
      if (error.status === 400 || error.status === 429) reactionStatus.textContent = error.message;
      else failure(error);
    } finally {
      if (current(value)) { reacting = false; reactionControls.setBusy(false); }
    }
  }
  async function poll(value) {
    if (!current(value)) return;
    try {
      const epoch = reactionEpoch;
      const data = await clubRequest('club/messages' + (cursor ? '/after/' + cursor : ''), options());
      if (!current(value)) return;
      meta(data); render(data.messages); applyReactions(data, epoch);
      if (!oldest) oldest = data.messages[0]?.id;
      if (data.messages.length) cursor = data.messages.at(-1).id;
      status.textContent = messages.size ? '' : 'Сообщений пока нет. Можно написать первой.';
      await syncReactions(value);
      if (!current(value)) return;
      timer = setTimeout(() => poll(value), data.hasMore ? 0 : 3000);
    } catch (error) { if (current(value)) failure(error); }
  }
  async function start() {
    clear();
    if (document.hidden || ended) return;
    const value = revision; controller = new AbortController(); status.textContent = 'Проверяем доступ к чату…';
    try {
      const info = await clubRequest('club', options());
      if (!current(value)) return;
      meta(info);
      if (info.access !== 'available') throw Object.assign(new Error('Чат доступен при действующем доступе к курсу «Лёгкие роды».'), { code: 'club_course_required' });
      const data = await clubRequest('club/messages', options());
      if (!current(value)) return;
      meta(data); render(data.messages); applyReactions(data, reactionEpoch);
      cursor = data.messages.at(-1)?.id || '0'; oldest = data.messages[0]?.id;
      history.hidden = !data.hasMore; controls.hidden = false; sendButton.disabled = false;
      status.textContent = messages.size ? '' : 'Сообщений пока нет. Можно написать первой.';
      timer = setTimeout(() => poll(value), 3000);
    } catch (error) { if (current(value)) failure(error); }
  }
  history.addEventListener('click', async () => {
    if (!oldest || history.disabled) return;
    const value = revision; history.disabled = true;
    try {
      const epoch = reactionEpoch;
      const data = await clubRequest('club/messages/before/' + oldest, options());
      if (!current(value)) return;
      meta(data); render(data.messages, { prepend: true }); applyReactions(data, epoch);
      oldest = data.messages[0]?.id || oldest; history.hidden = !data.hasMore;
    } catch (error) { if (current(value)) failure(error); }
    finally { history.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || controls.hidden || !input.value.trim()) return;
    const text = input.value.trim(), replyTo = reply?.id || null;
    const signature = JSON.stringify({ text, replyTo });
    if (pending?.signature !== signature) pending = { signature, body: { requestId: crypto.randomUUID(), text, replyTo } };
    const attempt = pending, value = revision; busy = true; sendButton.disabled = true;
    try {
      const epoch = reactionEpoch;
      const data = await clubRequest('club/messages', options(attempt.body));
      if (!current(value)) return;
      meta(data); render([data.message], { ownSend: true }); applyReactions(data, epoch); status.textContent = '';
      // Only history reads advance cursor: own sends may arrive ahead of another author's message.
      if (JSON.stringify({ text: input.value.trim(), replyTo: reply?.id || null }) === attempt.signature) {
        input.value = ''; reply = null; replyPreview.hidden = true; pending = null;
      }
    } catch (error) {
      if (!current(value)) return;
      if (error.status === 400 || error.status === 429 || error.code === 'chat_request_reused') {
        status.textContent = error.message; if (error.code === 'chat_request_reused') pending = null;
      } else failure(error);
    } finally { if (current(value)) { busy = false; sendButton.disabled = false; } }
  });
  replyPreview.querySelector('button').addEventListener('click', () => { reply = null; replyPreview.hidden = true; input.focus(); });
  retry.addEventListener('click', start);
  window.addEventListener('focus', () => { if (controls.hidden && !busy) start(); });
  document.addEventListener('visibilitychange', start);
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  window.addEventListener('webpril:session-ended', () => { ended = true; clear(); input.value = ''; pending = null; status.textContent = ''; });
  function resize() { document.documentElement.style.setProperty('--club-viewport-height', (window.visualViewport?.height || innerHeight) + 'px'); }
  window.visualViewport?.addEventListener('resize', resize); window.addEventListener('resize', resize); resize(); start();
}
