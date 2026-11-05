import { clubRooms } from './club-rooms.js?v=20261105-rooms';
import { createReactionControls } from './chat-reactions.js?v=20261031-chips';
import { createMessageActions } from './club-message-actions.js?v=20261103-chat';
import { createDraftStore, copyMessageText } from './club-chat-tools.js?v=20261105-rooms';
import { createChatTimeline } from './club-chat-timeline.js?v=20261103-chat';
import { clubRequest, chatLease } from './club-api.js?v=20261105-rooms';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const definition = clubRooms.find(item => item.id === room);
if (!definition || params.getAll('room').length !== 1) {
  location.replace('club.html#participants');
} else {
  document.title = definition.title + ' — Клуб';
  document.querySelector('.discussion-header h1').textContent = definition.title;
  document.querySelector('.discussion-header p').textContent = definition.kind === 'experts' ? 'Экспертный чат' : 'Чат участниц';
  document.querySelector('.discussion-header > a').href = 'club.html#' + definition.kind;
  const log = document.querySelector('#chat-messages'), status = document.querySelector('#chat-status');
  const controls = document.querySelector('#chat-controls'), form = document.querySelector('#chat-form');
  const input = document.querySelector('#chat-text'), sendButton = document.querySelector('#chat-send');
  const history = document.querySelector('#chat-history'), retry = document.querySelector('#chat-retry');
  const courses = document.querySelector('#chat-courses'), replyPreview = document.querySelector('#chat-reply');
  const reactionStatus = document.querySelector('#reaction-status'), sendStatus = document.querySelector('#chat-send-status');
  const down = document.querySelector('#chat-down'), searchToggle = document.querySelector('#chat-search-toggle');
  const searchPanel = document.querySelector('#chat-search-panel'), searchForm = document.querySelector('#chat-search-form');
  const searchInput = document.querySelector('#chat-search-text'), searchResults = document.querySelector('#chat-search-results');
  const searchStatus = document.querySelector('#chat-search-status'), searchMore = document.querySelector('#chat-search-more');
  const reactionControls = createReactionControls({ root: log, onSelect: setReaction });
  const messages = new Map(), deletedIds = new Set();
  let canSend = false, canModerate = false, ready = false, ended = false, blocked = false, busy = false, reacting = false;
  let revision = 0, windowEpoch = 0, navigationEpoch = 0, controller, timer, leaseTimer, reconnectTimer, readTimer, saveTimer, accountId, draftBound = false;
  let cursor = '0', reply = null, restoreReplyId = null, pending = null, savedPlace = null;
  let hasBefore = false, hasAfter = false, loadingHistory = false, navigating = false, readBusy = false;
  let reactionEpoch = 0, readEpoch = 0, retryAttempt = 0, unreadStart = null;
  let readState = { initialized: false, lastReadId: '0', unreadCount: 0, firstUnreadId: null };
  let searchVersion = 0, searchNext = null, searchQuery = '', searching = false;
  const current = value => value === revision && !document.hidden && !ended;
  const validId = id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id);
  const positionKey = () => 'webpril:club-position:v1:' + room + ':' + accountId;
  const draft = createDraftStore({ input, room, onChange: () => {
    // An uncertain attempt keeps its ID while its unchanged text is retried.
    if (pending && pending.signature !== JSON.stringify({ text: input.value.trim(), replyTo: reply?.id || restoreReplyId || null })) pending = null;
    persistDraft();
  } });
  const actions = createMessageActions({ log, getMessage: id => messages.get(id), canReply: () => canSend && ready,
    onReply: chooseReply, onDelete: deleteForAll, onCopy: async message => {
      try { await copyMessageText(message.text); if (ready) status.textContent = 'Текст скопирован.'; }
      catch (error) { if (ready) status.textContent = error.message; }
    } });
  const view = createChatTimeline({ log, messages, deletedIds, reactions: reactionControls, actions,
    canSend: () => canSend && ready, onReply: chooseReply, onJump: jumpToMessage });

  function persistDraft() { draft.save({ replyTo: reply?.id || restoreReplyId || null, pending }); }
  function readPlace() {
    try {
      const value = JSON.parse(sessionStorage.getItem(positionKey()));
      return validId(value?.messageId) && Number.isFinite(value.offset) ? value : null;
    } catch { return null; }
  }
  function savePlace() {
    if (!ready) return;
    const value = view.snapshot(); if (!value) return;
    savedPlace = value;
    try { sessionStorage.setItem(positionKey(), JSON.stringify(value)); } catch { /* Optional per-tab position. */ }
  }
  function snapshotContext() {
    savePlace();
    if (reply) restoreReplyId = reply.id;
    persistDraft();
  }
  function closeSearch({ forget = false, focus = false } = {}) {
    searchVersion++; searching = false; searchPanel.hidden = true; searchToggle.setAttribute('aria-expanded', 'false');
    searchMore.disabled = false;
    if (forget) { searchInput.value = ''; searchQuery = ''; searchNext = null; searchResults.replaceChildren(); searchStatus.textContent = ''; }
    if (focus && !searchToggle.disabled) searchToggle.focus({ preventScroll: true });
  }
  function suspend({ preserve = true } = {}) {
    if (preserve) snapshotContext();
    revision++; windowEpoch++; navigationEpoch++; controller?.abort(); clearTimeout(timer); clearTimeout(leaseTimer); clearTimeout(reconnectTimer);
    clearTimeout(readTimer); clearTimeout(saveTimer); readBusy = false; loadingHistory = false; navigating = false;
    reactionEpoch++; readEpoch++; reacting = false; ready = false; busy = false;
    view.clear(); deletedIds.clear(); reply = null; controls.hidden = true; history.hidden = true; history.disabled = false; down.hidden = true;
    retry.hidden = true; courses.hidden = true; searchToggle.disabled = true; closeSearch({ forget: true });
    reactionStatus.textContent = ''; reactionStatus.classList.remove('reaction-status-error');
    sendStatus.textContent = ''; form.removeAttribute('aria-busy'); draft.setBusy(false);
  }
  function acceptRead(data, epoch = readEpoch) {
    if (!data.readState || epoch !== readEpoch) return;
    const next = data.readState;
    if (typeof next.initialized !== 'boolean' || !/^(0|[1-9]\d{0,18})$/.test(next.lastReadId)
      || !Number.isSafeInteger(next.unreadCount) || next.unreadCount < 0
      || (next.firstUnreadId !== null && !validId(next.firstUnreadId))) throw new Error('Не удалось обновить непрочитанные сообщения.');
    if (readState.initialized && BigInt(next.lastReadId) < BigInt(readState.lastReadId)) return;
    readState = next;
    if (!unreadStart && next.firstUnreadId) { unreadStart = next.firstUnreadId; view.setUnread(unreadStart); }
    updateDown();
  }
  function meta(data, epoch = readEpoch) {
    const remaining = chatLease(data, accountId);
    if (!draftBound) {
      accountId = data.accountId;
      const restored = draft.bind(accountId); restoreReplyId = restored.replyTo; pending = restored.pending; savedPlace = readPlace();
      draftBound = true;
    }
    clearTimeout(leaseTimer); leaseTimer = setTimeout(() => start(), remaining);
    const changed = canSend !== (data.canSend === true) || canModerate !== (data.canModerate === true);
    canSend = data.canSend === true; canModerate = data.canModerate === true;
    controls.hidden = !canSend || !ready; reactionControls.setBusy(reacting || !canSend || !ready);
    if (changed) {
      for (const message of messages.values()) message.canDelete = message.own || canModerate;
      log.querySelectorAll('.chat-reply-button').forEach(button => { button.disabled = !canSend || !ready; });
      actions.permissionsChanged();
    }
    acceptRead(data, epoch);
  }
  function options(body) { return { accountId, room, signal: controller?.signal, ...(body === undefined ? {} : { body }) }; }
  function updateStatus() {
    status.textContent = !canSend ? 'Режим модерации: можно удалять сообщения участниц.'
      : messages.size ? '' : 'Сообщений пока нет. Можно написать первой.';
  }
  function updateDown() {
    down.hidden = !ready || (!hasAfter && view.atBottom());
    const count = readState.unreadCount;
    const label = count % 10 === 1 && count % 100 !== 11 ? 'новое' : 'новых';
    down.textContent = count ? 'Вниз · ' + count + ' ' + label : 'К последним сообщениям ↓';
    down.disabled = navigating;
  }
  function reconnect() {
    if (ended || blocked || document.hidden || navigator.onLine === false) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt++, 5));
    reconnectTimer = setTimeout(() => start(), delay);
  }
  function failure(error) {
    suspend(); status.textContent = error.message || 'Чат временно недоступен.';
    if (error.status === 401 || error.code === 'account_changed') {
      ended = true; draft.unbind({ purge: true }); draftBound = false; pending = null; restoreReplyId = null; savedPlace = null;
      window.webprilSessionGate?.end();
    } else if (error.code === 'club_course_required' || error.code === 'onboarding_required') {
      blocked = true; courses.hidden = false; draft.unbind(); draftBound = false; pending = null; restoreReplyId = null; savedPlace = null;
    } else {
      retry.hidden = false;
      if (error.code !== 'chat_update_required') reconnect();
    }
  }
  function updateReply() {
    replyPreview.hidden = !reply && !(restoreReplyId && pending);
    if (reply) replyPreview.querySelector('p').textContent = reply.author.name + ': ' + reply.text.slice(0, 160);
    else if (restoreReplyId && pending) replyPreview.querySelector('p').textContent = 'Исходное сообщение удалено. Можно проверить предыдущую отправку или отменить ответ.';
    persistDraft();
  }
  function chooseReply(message) {
    if (!ready || !canSend || deletedIds.has(message.id)) return;
    reply = message; restoreReplyId = message.id; pending = null; updateReply(); input.focus();
  }
  async function restoreReply(value) {
    if (!restoreReplyId || !canSend) return;
    let message = messages.get(restoreReplyId);
    if (!message) {
      try {
        const epoch = readEpoch, data = await clubRequest('club/messages/around/' + restoreReplyId, options());
        if (!current(value)) return;
        meta(data, epoch); message = data.messages.find(item => item.id === restoreReplyId);
      } catch (error) {
        if (error.code !== 'chat_message_not_found') throw error;
      }
    }
    if (!current(value)) return;
    if (message && !message.deleted) reply = message;
    else {
      reply = null;
      if (!pending || pending.body.replyTo !== restoreReplyId) restoreReplyId = null;
      status.textContent = 'Исходное сообщение удалено. Текст черновика сохранён.';
    }
    updateReply();
  }
  function removeMessage(id) {
    view.remove(id);
    if (reply?.id === id || restoreReplyId === id) {
      reply = null; restoreReplyId = pending?.body.replyTo === id ? id : null; updateReply();
    }
    searchResults.querySelector('[data-message-id="' + id + '"]')?.closest('li')?.remove();
  }
  function applyReactions(data, epoch) { if (!reacting && epoch === reactionEpoch) reactionControls.update(data.reactions); }
  function applyWindow(data, { replace = false, prepend = false, follow = false } = {}, epoch = reactionEpoch) {
    for (const message of data.messages) if (message.deleted) removeMessage(message.id);
    view.render(data.messages, { replace, prepend, follow }); applyReactions(data, epoch);
    reactionControls.setBusy(reacting || !canSend || !ready);
    if (replace) { windowEpoch++; hasBefore = data.hasBefore ?? data.hasMore; hasAfter = data.hasAfter === true; cursor = data.changeCursor; }
    else if (prepend) hasBefore = data.hasBefore ?? data.hasMore;
    else {
      const catchingUp = hasAfter;
      hasAfter = data.hasAfter === true;
      if (catchingUp && !hasAfter) {
        // Polling may have skipped live rows while this older page was in
        // flight. Replay changes since its snapshot before declaring live.
        if (BigInt(data.changeCursor) < BigInt(cursor)) cursor = data.changeCursor;
        windowEpoch++;
      }
    }
    history.hidden = !hasBefore; updateDown();
  }
  function scheduleRead() { clearTimeout(readTimer); if (ready) readTimer = setTimeout(markVisibleRead, 450); }
  async function markVisibleRead() {
    if (!ready || document.hidden || readBusy || navigating || loadingHistory || !current(revision)) return;
    const id = view.visibleLastId() || (!messages.size && !readState.initialized ? '0' : null);
    if (id === null || (readState.initialized && BigInt(id) <= BigInt(readState.lastReadId))) return;
    const value = revision; readBusy = true; readEpoch++;
    try {
      const data = await clubRequest('club/read', options({ messageId: id }));
      if (!current(value)) return;
      meta(data); readEpoch++; updateDown();
    } catch (error) { if (current(value)) failure(error); }
    finally { if (current(value)) readBusy = false; }
  }
  async function syncReactions(value) {
    const ids = reactionControls.visibleIds(); if (!ids.length || reacting || !current(value)) return;
    const epoch = reactionEpoch, reading = readEpoch;
    const data = await clubRequest('club/reactions/read', options({ messageIds: ids }));
    if (!current(value)) return;
    meta(data, reading); applyReactions(data, epoch);
  }
  async function poll(value) {
    if (!current(value) || !ready) return;
    try {
      const epoch = reactionEpoch, reading = readEpoch, windowVersion = windowEpoch;
      const data = await clubRequest('club/changes/after/' + cursor, options());
      if (!current(value)) return;
      if (windowVersion !== windowEpoch) { timer = setTimeout(() => poll(value), 0); return; }
      meta(data, reading);
      const list = data.messages.filter(message => message.deleted || messages.has(message.id) || !hasAfter);
      for (const message of list) if (message.deleted) removeMessage(message.id);
      view.render(list, { prepend: hasAfter }); applyReactions(data, epoch); cursor = data.changeCursor;
      updateStatus(); updateDown(); scheduleRead(); await syncReactions(value);
      if (current(value)) timer = setTimeout(() => poll(value), data.hasMore ? 0 : 3000);
    } catch (error) { if (current(value)) failure(error); }
  }
  async function start() {
    if (ended || document.hidden || blocked) return;
    suspend();
    const value = revision; controller = new AbortController(); status.textContent = retryAttempt ? 'Восстанавливаем соединение…' : 'Проверяем доступ к чату…';
    try {
      const reading = readEpoch, info = await clubRequest('club', options());
      if (!current(value)) return;
      meta(info, reading);
      if (info.access !== 'available') throw Object.assign(new Error('Экспертный чат доступен при действующей покупке курса школы.'), { code: 'club_course_required' });
      unreadStart ||= readState.firstUnreadId; view.setUnread(unreadStart);
      const anchor = savedPlace?.messageId || (readState.initialized && readState.lastReadId !== '0' ? readState.lastReadId : readState.firstUnreadId);
      let data; const epoch = reactionEpoch, readVersion = readEpoch;
      if (anchor) {
        try { data = await clubRequest('club/messages/around/' + anchor, options()); }
        catch (error) { if (error.code !== 'chat_message_not_found') throw error; }
      }
      if (!data && readState.firstUnreadId && anchor !== readState.firstUnreadId) {
        try { data = await clubRequest('club/messages/around/' + readState.firstUnreadId, options()); }
        catch (error) { if (error.code !== 'chat_message_not_found') throw error; }
      }
      if (!data) data = await clubRequest('club/messages', options());
      if (!current(value)) return;
      meta(data, readVersion); applyWindow(data, { replace: true }, epoch);
      await restoreReply(value); if (!current(value)) return;
      ready = true; controls.hidden = !canSend; history.hidden = !hasBefore; searchToggle.disabled = false;
      sendButton.disabled = false; reactionControls.setBusy(!canSend); draft.resize();
      log.querySelectorAll('.chat-reply-button').forEach(button => { button.disabled = !canSend; });
      if (!view.restore(savedPlace) && !(anchor && view.show(anchor, { offset: 16 }))) log.scrollTop = log.scrollHeight;
      updateStatus(); updateDown(); retryAttempt = 0; scheduleRead();
      timer = setTimeout(() => poll(value), 3000);
    } catch (error) { if (current(value)) failure(error); }
  }
  async function loadHistory(direction) {
    if (!ready || loadingHistory || navigating || (direction === 'before' ? !hasBefore : !hasAfter)) return;
    const id = direction === 'before' ? view.firstId() : view.lastId(); if (!id) return;
    const value = revision, epoch = reactionEpoch, reading = readEpoch, windowVersion = windowEpoch;
    loadingHistory = true; history.disabled = true;
    try {
      const data = await clubRequest('club/messages/' + direction + '/' + id, options());
      if (!current(value) || windowVersion !== windowEpoch) return;
      meta(data, reading);
      const place = view.snapshot();
      applyWindow(data, { prepend: direction === 'before' }, epoch);
      view.restore(place); updateDown(); scheduleRead();
    } catch (error) { if (current(value)) failure(error); }
    finally { if (current(value)) { loadingHistory = false; history.disabled = false; } }
  }
  async function jumpToMessage(id) {
    if (!ready || navigating || !validId(id)) return;
    if (view.show(id, { highlight: true })) { closeSearch(); updateDown(); scheduleRead(); return; }
    const value = revision, epoch = reactionEpoch, reading = readEpoch, navigation = ++navigationEpoch; navigating = true; updateDown();
    try {
      const data = await clubRequest('club/messages/around/' + id, options());
      if (!current(value) || navigation !== navigationEpoch) return;
      meta(data, reading); applyWindow(data, { replace: true }, epoch); closeSearch(); view.show(id, { highlight: true });
      updateStatus(); savePlace(); scheduleRead();
    } catch (error) {
      if (!current(value) || navigation !== navigationEpoch) return;
      if (error.code === 'chat_message_not_found') { removeMessage(id); status.textContent = 'Сообщение удалено или больше недоступно.'; }
      else failure(error);
    } finally { if (current(value) && navigation === navigationEpoch) { navigating = false; updateDown(); scheduleRead(); } }
  }
  async function goDown({ force = false } = {}) {
    if (!ready || (navigating && !force)) return;
    if (!hasAfter && !force) { log.scrollTop = log.scrollHeight; updateDown(); scheduleRead(); return; }
    const value = revision, epoch = reactionEpoch, reading = readEpoch, navigation = ++navigationEpoch; navigating = true; updateDown();
    try {
      const data = await clubRequest('club/messages', options()); if (!current(value) || navigation !== navigationEpoch) return;
      meta(data, reading); applyWindow(data, { replace: true, follow: true }, epoch); updateStatus();
    } catch (error) { if (current(value) && navigation === navigationEpoch) failure(error); }
    finally { if (current(value) && navigation === navigationEpoch) { navigating = false; updateDown(); scheduleRead(); } }
  }
  async function deleteForAll(id) {
    const value = revision;
    try {
      const data = await clubRequest('club/messages/' + id + '/delete', options({}));
      if (!current(value)) return false;
      meta(data); removeMessage(id); updateStatus(); updateDown(); return true;
    } catch (error) {
      if (!current(value)) return false;
      if (deletedIds.has(id)) return true;
      if (error.status === 401 || error.code === 'account_changed' || error.code === 'club_course_required') { failure(error); return false; }
      throw error;
    }
  }
  async function setReaction(messageId, reaction) {
    if (reacting || !ready || !canSend || ended) return;
    const value = revision; reacting = true; reactionEpoch++; reactionControls.setBusy(true);
    reactionStatus.classList.remove('reaction-status-error'); reactionStatus.textContent = 'Сохраняем реакцию…';
    try {
      const data = await clubRequest('club/reactions', options({ messageId, reaction })); if (!current(value)) return;
      meta(data); reactionEpoch++; reactionControls.update(data.reactions);
      reactionStatus.textContent = reaction === null ? 'Реакция убрана.' : 'Реакция сохранена.';
    } catch (error) {
      if (!current(value)) return;
      if (error.code === 'reaction_message_not_found') { removeMessage(messageId); reactionStatus.textContent = 'Сообщение удалено.'; }
      else if (error.status === 400 || error.status === 429) { reactionStatus.textContent = error.message; reactionStatus.classList.add('reaction-status-error'); }
      else failure(error);
    } finally { if (current(value)) { reacting = false; reactionControls.setBusy(!canSend); } }
  }
  async function search({ more = false } = {}) {
    if (!ready || searching) return;
    const query = searchInput.value.trim();
    if ([...query].length < 2 || [...query].length > 100) { searchStatus.textContent = 'Введите от 2 до 100 символов.'; return; }
    const value = revision, version = ++searchVersion, reading = readEpoch;
    if (!more || query !== searchQuery) { searchResults.replaceChildren(); searchNext = null; searchQuery = query; }
    searching = true; searchMore.disabled = true; searchStatus.textContent = 'Ищем по всей переписке…';
    try {
      const data = await clubRequest('club/search', options({ query, ...(more && searchNext ? { before: searchNext } : {}) }));
      if (!current(value) || version !== searchVersion) return;
      meta(data, reading);
      for (const message of data.messages) {
        const item = document.createElement('li'), button = document.createElement('button'), name = document.createElement('strong'), text = document.createElement('span');
        button.type = 'button'; button.dataset.messageId = message.id;
        name.textContent = message.author.name + ' · ' + new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
        text.textContent = message.text.slice(0, 200); button.append(name, text); button.addEventListener('click', () => jumpToMessage(message.id));
        if (!message.deleted && !deletedIds.has(message.id) && !searchResults.querySelector('[data-message-id="' + message.id + '"]')) {
          item.append(button); searchResults.append(item);
        }
      }
      searchNext = data.nextBefore; searchMore.hidden = !data.hasMore;
      searchStatus.textContent = searchResults.children.length ? 'Найдено: ' + searchResults.children.length + (data.hasMore ? '. Есть ещё результаты.' : '.') : 'Сообщений по этому запросу нет.';
    } catch (error) {
      if (!current(value) || version !== searchVersion) return;
      if (error.status === 400 || error.status === 429) searchStatus.textContent = error.message;
      else failure(error);
    } finally { if (version === searchVersion) { searching = false; searchMore.disabled = false; } }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !ready || controls.hidden || !input.value.trim()) return;
    const text = input.value.trim(), replyTo = reply?.id || restoreReplyId || null, signature = JSON.stringify({ text, replyTo });
    if (pending?.signature !== signature) pending = { signature, body: { requestId: crypto.randomUUID(), text, replyTo } };
    const attempt = pending, value = revision; busy = true; sendButton.disabled = true; draft.setBusy(true); persistDraft();
    form.setAttribute('aria-busy', 'true'); sendStatus.textContent = 'Отправляется…';
    try {
      const data = await clubRequest('club/messages', options(attempt.body));
      if (!current(value)) return;
      meta(data);
      const sent = data.message;
      if (pending === attempt) { input.value = ''; reply = null; restoreReplyId = null; pending = null; draft.clear(); updateReply(); }
      sendStatus.textContent = 'Сообщение отправлено.';
      if (sent.deleted) { removeMessage(sent.id); sendStatus.textContent = 'Сообщение уже было отправлено и удалено.'; }
      // Reload a continuous latest page before acknowledging reading: other
      // messages may have arrived between the previous poll and this write.
      else { await goDown({ force: true }); }
      if (current(value)) { updateStatus(); updateDown(); scheduleRead(); }
    } catch (error) {
      if (!current(value)) return;
      if (error.status === 400 || error.status === 429 || error.code === 'chat_request_reused') {
        sendStatus.textContent = error.message;
        if (error.code === 'chat_request_reused' || error.code === 'reply_not_found') {
          pending = null;
          if (error.code === 'reply_not_found') { reply = null; restoreReplyId = null; updateReply(); }
          persistDraft();
        }
      } else failure(error);
    } finally {
      if (current(value)) { busy = false; sendButton.disabled = false; draft.setBusy(false); form.removeAttribute('aria-busy'); draft.resize(); }
    }
  });
  replyPreview.querySelector('button').addEventListener('click', () => { reply = null; restoreReplyId = null; pending = null; updateReply(); input.focus(); });
  history.addEventListener('click', () => loadHistory('before'));
  down.addEventListener('click', goDown);
  retry.addEventListener('click', () => { blocked = false; start(); });
  searchToggle.addEventListener('click', () => {
    if (!ready) return;
    if (!searchPanel.hidden) { closeSearch({ focus: true }); return; }
    searchPanel.hidden = false; searchToggle.setAttribute('aria-expanded', 'true'); searchInput.focus(); updateDown();
  });
  document.querySelector('#chat-search-close').addEventListener('click', () => closeSearch({ focus: true }));
  searchForm.addEventListener('submit', event => { event.preventDefault(); search(); });
  searchMore.addEventListener('click', () => search({ more: true }));
  searchPanel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeSearch({ focus: true }); } });
  log.addEventListener('scroll', () => {
    updateDown(); scheduleRead(); clearTimeout(saveTimer); saveTimer = setTimeout(savePlace, 150);
    if (ready && hasAfter && !loadingHistory && log.scrollHeight - log.scrollTop - log.clientHeight < 100) loadHistory('after');
  }, { passive: true });
  window.addEventListener('online', () => { if (!ready && !blocked && !ended) start(); });
  window.addEventListener('focus', () => { if (!ready && !busy && !blocked) start(); else scheduleRead(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else start(); });
  window.addEventListener('pagehide', () => suspend());
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  window.addEventListener('webpril:session-ended', () => {
    ended = true; suspend({ preserve: false }); draft.unbind({ purge: true }); draftBound = false; pending = null; restoreReplyId = null; savedPlace = null; status.textContent = '';
  });
  function resize() {
    document.documentElement.style.setProperty('--club-viewport-height', (window.visualViewport?.height || innerHeight) + 'px');
    draft.resize(); updateDown(); scheduleRead();
  }
  window.visualViewport?.addEventListener('resize', resize); window.addEventListener('resize', resize); resize(); start();
}
