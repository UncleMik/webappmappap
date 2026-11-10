import { createConversationMenu } from './ai-conversations.js?v=20261106-conversations';

const conversation = document.querySelector('#conversation');
const input = document.querySelector('#chat-input');
const form = document.querySelector('#chat-form');
const send = form.querySelector('.send-button');
const status = document.querySelector('#chat-status');
const quotaLabel = document.querySelector('#chat-quota');
const historyMore = document.querySelector('#history-more');
const retry = document.querySelector('#chat-retry');
let accountId, revision = 0, controller, ended = false, ready = false;
let messages = [], hasMore = false, nextBefore = null, busy = false, pending = null;
let quotaTimer, quotaFlight = null, quotaDeadline = null, quotaRetryAt = 0, quotaSnapshot = null, quotaClock = null, limitNotice = false;
let remaining = null, currentLimit = null, replyWaiting = false, selectedAttachment = null;
const fileInput = document.querySelector('#analysis-file');
const attachmentChip = document.querySelector('#selected-attachment');
const attachmentName = document.querySelector('#attachment-name');
const attachmentButton = document.querySelector('#attachment');
const analysesButton = document.querySelector('#analysis-attachment');
const removeAttachment = document.querySelector('#attachment-remove');
function selectAttachment(file) {
  selectedAttachment = file; fileInput.value = '';
  attachmentName.textContent = file?.name || ''; attachmentChip.hidden = !file;
  updateControls();
}
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(Object.assign(new Error('Не удалось прочитать файл.'), { code: 'invalid_ai_attachment' }));
    reader.readAsDataURL(file);
  });
}
let voice = null;
const voiceControls = document.querySelector('#voice-controls');
const voiceStatus = document.querySelector('#voice-status');
const voiceCancel = document.querySelector('#voice-cancel');
const voiceRetry = document.querySelector('#voice-retry');
let expandedSources = new Set();
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const sendingId = requestId => `sending:${requestId}`;

const threadStates = new Map();
let activeConversationId = null, conversations = [], listHasMore = false, listNext = null, listBusy = false;
let listRevision = 0, listController, accountEpoch = 0;
const conversationTitle = document.querySelector('#conversation-title');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const menu = createConversationMenu({
  onOpen: () => loadConversations(), onNew: newConversation, onSelect: id => selectConversation(id, true),
  onMore: () => loadConversations(true), onRetry: () => initializeConversations(),
});
function validConversation(row) {
  return row && uuid(row.id) && typeof row.title === 'string' && row.title.trim() && [...row.title].length <= 60
    && Number.isFinite(Date.parse(row.createdAt)) && Number.isFinite(Date.parse(row.updatedAt));
}
function renderConversations() { menu.render(conversations, activeConversationId, listHasMore); }
function rememberConversation(row) {
  if (!validConversation(row)) return;
  const previous = conversations.find(item => item.id === row.id);
  if (previous && Date.parse(previous.updatedAt) > Date.parse(row.updatedAt)) return;
  conversations = conversations.filter(item => item.id !== row.id); conversations.push(row);
  conversations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id));
  if (row.id === activeConversationId) conversationTitle.textContent = row.title;
  renderConversations();
}
function acceptConversation(data) { if (data.conversation?.id === activeConversationId) rememberConversation(data.conversation); }
function saveThread() {
  if (!activeConversationId) return;
  const state = threadStates.get(activeConversationId) || {};
  Object.assign(state, { messages, hasMore, nextBefore, pending, draft: input.value, attachment: selectedAttachment, expandedSources });
  threadStates.set(activeConversationId, state);
}
function leaveThread() {
  saveThread(); revision++; controller?.abort(); controller = null; cancelVoice(); busy = false;
}
function showThread(id) {
  activeConversationId = id; const state = id && threadStates.get(id);
  messages = state?.messages || []; hasMore = state?.hasMore || false; nextBefore = state?.nextBefore || null;
  pending = state?.pending || null; replyWaiting = false; expandedSources = state?.expandedSources || new Set();
  input.value = state?.draft || ''; selectAttachment(state?.attachment || null); ready = false;
  conversationTitle.textContent = conversations.find(row => row.id === id)?.title || 'Новый чат';
  notice(''); render(); renderConversations();
}
async function selectConversation(id, focus = false) {
  if (ended || !accountId || !uuid(id)) return;
  if (id === activeConversationId && ready) { menu.close(false); if (focus) conversationTitle.focus({ preventScroll: true }); return; }
  leaveThread(); showThread(id); menu.close(false); updateControls();
  const current = revision, state = threadStates.get(id);
  try {
    if (state && !state.saved) await ensureConversation(id);
    if (current !== revision || ended) return;
    await loadHistory();
  } catch (error) {
    if (current !== revision || ended || validateIdentity(error)) return;
    ready = true; render(); notice('Не удалось создать чат. Повторите попытку — новый чат не потерян.'); updateControls();
  }
  if (focus && id === activeConversationId && !ended) conversationTitle.focus({ preventScroll: true });
}
function allocateConversation() {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  activeConversationId = id; threadStates.set(id, { saved: false }); saveThread();
  rememberConversation({ id, title: 'Новый чат', createdAt: now, updatedAt: now });
  return id;
}
async function ensureConversation(id) {
  const state = threadStates.get(id); if (!state) throw new Error('Conversation unavailable');
  if (state.saved) return;
  if (state.creating) return state.creating;
  const epoch = accountEpoch; state.createAbort = new AbortController();
  if (id === activeConversationId) { state.createError = false; menu.setCreating(true); }
  state.creating = (async () => {
    const data = await request('conversations', { conversationId: id }, state.createAbort.signal);
    if (epoch !== accountEpoch || ended) return;
    if (!validConversation(data.conversation) || data.conversation.id !== id) throw new Error('Invalid conversation response');
    state.saved = true; state.createError = false; rememberConversation(data.conversation);
  })().catch(error => { if (epoch === accountEpoch) state.createError = true; throw error; }).finally(() => {
    state.creating = null; state.createAbort = null;
    if (epoch === accountEpoch && id === activeConversationId) { menu.setCreating(false); updateControls(); }
  });
  return state.creating;
}
async function newConversation() {
  if (ended || !accountId) return;
  leaveThread(); showThread(null); const id = allocateConversation(); ready = true; render(); updateControls(); menu.close(false); input.focus();
  try { await ensureConversation(id); }
  catch (error) {
    if (id !== activeConversationId || ended || validateIdentity(error)) return;
    notice('Не удалось создать чат. Повторите попытку — новый чат не потерян.'); updateControls();
  }
}
async function loadConversations(more = false) {
  if (ended || !accountId || (more && (listBusy || !listHasMore))) return false;
  const version = ++listRevision, epoch = accountEpoch; listController?.abort(); listController = new AbortController();
  listBusy = true; menu.setBusy(true); menu.notice('Загружаем чаты…');
  try {
    const data = await request(more ? 'conversations/read' : 'conversations', more ? { before: listNext } : undefined, listController.signal);
    if (version !== listRevision || epoch !== accountEpoch || ended) return false;
    if (!Array.isArray(data.conversations) || !data.conversations.every(validConversation) || typeof data.hasMore !== 'boolean'
      || (data.hasMore && (typeof data.nextBefore !== 'string' || !data.nextBefore))) throw new Error('Invalid conversation list');
    // Merge by UUID so delayed directory snapshots cannot replace newer message metadata.
    for (const row of data.conversations) { const state = threadStates.get(row.id) || {}; state.saved = true; threadStates.set(row.id, state); rememberConversation(row); }
    listHasMore = data.hasMore; listNext = typeof data.nextBefore === 'string' ? data.nextBefore : null;
    menu.notice(conversations.length ? '' : 'Сохранённых чатов пока нет.'); renderConversations(); return true;
  } catch (error) {
    if (version !== listRevision || epoch !== accountEpoch || ended || validateIdentity(error)) return false;
    menu.notice('Не удалось загрузить чаты. Проверьте интернет и повторите попытку.', true); return false;
  } finally { if (version === listRevision && epoch === accountEpoch) { listBusy = false; menu.setBusy(false); } }
}
async function initializeConversations() {
  const epoch = accountEpoch;
  if (!await loadConversations() || epoch !== accountEpoch || ended) { if (!activeConversationId && !ended) { notice('Не удалось загрузить чаты. Повторите попытку.'); updateControls(); } return; }
  if (activeConversationId) return;
  if (conversations.length) { await selectConversation(conversations[0].id); return; }
  const current = revision; busy = true; updateControls();
  try {
    const data = await request('quota'); if (current !== revision || ended) return;
    quota(data.quota); ready = true; render(); notice('');
  } catch (error) { if (current === revision && !validateIdentity(error)) notice(errorMessage(error)); }
  finally { if (current === revision) { busy = false; updateControls(); } }
}
function welcomeMessage() {
  const account = window.webprilAccount;
  const week = account?.user?.id === accountId && account.profile?.stage === 'pregnancy' ? account.week : null;
  const introduction = 'Привет! Я Лара из школы «Лёгкие роды». Рада знакомству 🤍';
  const timing = Number.isInteger(week) && week > 0 ? `У тебя сейчас ${week}-я неделя беременности. ` : '';
  return messageNode({
    id: 'welcome',
    role: 'assistant',
    content: `${introduction}

${timing}Как твои дела, как настроение? С чем пришла, о чём хочется поговорить или спросить?`,
  });
}

function resizeChat() { document.documentElement.style.setProperty('--chat-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', resizeChat);
window.addEventListener('resize', resizeChat);
resizeChat();
function notice(message, isLimit = false) { status.textContent = message; status.hidden = !message; limitNotice = isLimit && !!message; }
function updateControls() {
  const locked = !ready || busy || !!pending || remaining === 0;
  input.disabled = locked || !!voice;
  const recording = voice?.stage === 'recording';
  const microphone = !input.value.trim() && !selectedAttachment;
  send.disabled = voice ? !recording : locked;
  send.setAttribute('aria-label', recording ? 'Остановить запись' : microphone ? 'Записать голосом' : 'Отправить сообщение');
  send.classList.toggle('voice-action', recording || microphone);
  send.classList.toggle('voice-stop', recording);
  send.querySelector('use').setAttribute('href', recording ? '#stop' : microphone ? '#mic' : '#send');
  voiceControls.hidden = !voice;
  voiceRetry.hidden = voice?.stage !== 'retry';
  attachmentButton.disabled = analysesButton.disabled = removeAttachment.disabled = input.disabled;
  const state = threadStates.get(activeConversationId);
  menu.setCreating(!!state?.creating);
  retry.hidden = busy || (!pending && ready && !state?.createError);
  retry.textContent = state?.createError ? 'Повторить создание чата' : pending ? 'Проверить результат' : 'Повторить загрузку';
  menu.setEnabled(!!accountId && !ended);
}
function clearPrivate() {
  revision++; clearQuotaRefresh(); cancelVoice(); controller?.abort(); controller = null;
  accountEpoch++; listRevision++; listController?.abort(); listController = null; listBusy = false;
  for (const state of threadStates.values()) state.createAbort?.abort();
  threadStates.clear(); conversations = []; activeConversationId = null; listHasMore = false; listNext = null; menu.reset();
  conversationTitle.textContent = 'Новый чат'; document.querySelector('#ai-profile-summary').textContent = 'Личные данные пока не заполнены'; accountId = null; ready = false; busy = false; pending = null;
  messages = []; hasMore = false; nextBefore = null; remaining = null; currentLimit = null;
  replyWaiting = false; selectAttachment(null);
  expandedSources.clear();
  input.value = ''; conversation.replaceChildren();
  historyMore.hidden = true; quotaLabel.textContent = '';
  notice(''); updateControls();
}
function sessionEnded() { ended = true; clearPrivate(); }
window.addEventListener('webpril:session-ended', sessionEnded);
window.addEventListener('pagehide', sessionEnded);
window.addEventListener('pageshow', event => { if (event.persisted) { ended = false; waitForSession(); } });
window.addEventListener('account:change', event => {
  const id = event.detail?.user?.id;
  if (accountId && id && id !== accountId) { sessionEnded(); window.webprilSessionGate?.end('session_replaced'); }
  else if (!ended && id && !accountId) start(id);
  if (!ended) {
    profileSummary(event.detail);
    if (ready && !messages.length && !pending) render();
  }
});

function profileSummary(detail) {
  const summary = document.querySelector('#ai-profile-summary');
  if (detail?.user?.id && summary) summary.textContent = detail.week ? `${detail.week}-я неделя беременности` : detail.profile?.stage === 'mother' ? 'Материалы для мамы' : 'Личные данные пока не заполнены';
}
async function request(path, body, signal, timeoutMs) {
  const identity = accountId;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs ?? (body?.text ? 75_000 : 20_000));
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch('/api/auth/ai/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Webpril-Account': identity, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(data?.message || 'Чат временно недоступен.'), { code: data?.error, status: response.status, ...(data?.error === 'ai_daily_limit' ? { quota: data.quota } : {}) });
    if (!data || data.accountId !== identity || identity !== accountId) throw Object.assign(new Error('Аккаунт изменился.'), { code: 'account_changed' });
    if (body?.conversationId && ['history/read', 'messages', 'messages/status'].includes(path) && data.conversationId !== body.conversationId) throw Object.assign(new Error('Не удалось подтвердить беседу.'), { code: 'invalid_conversation_response' });
    return data;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function errorMessage(error, sending = false) {
  if (error.code === 'ai_conversation_not_found') return 'Этот чат больше недоступен. Выберите другой или начните новый.';
  if (error.code === 'invalid_conversation_response') return 'Не удалось подтвердить беседу. Повторите загрузку.';
  if (error.code === 'ai_purchase_required') return 'AI врач доступен после покупки курса. Посмотрите доступные курсы.';
  if (error.code === 'ai_daily_limit') return currentLimit === null ? 'На сегодня вопросы закончились. Новые вопросы будут доступны завтра.' : `На сегодня использованы все ${currentLimit} вопросов. Новые вопросы будут доступны завтра.`;
  if (error.code === 'ai_unavailable') return 'AI врач временно недоступен. Попробуйте позже.';
  if (error.code === 'invalid_ai_attachment') return 'Не удалось отправить файл. Проверьте, что это PDF, JPG или PNG до 10 МБ, и попробуйте снова.';
  if (error.code === 'ai_upload_busy') return 'Обработка файлов сейчас занята. Файл и вопрос сохранены здесь — попробуйте ещё раз чуть позже.';
  if (error.code === 'invalid_ai_message') return 'Проверьте текст вопроса и отправьте снова.';
  if (error.code === 'ai_access_changed') return 'Доступ к AI врачу изменился. Обновите страницу.';
  return sending ? 'Ответ пока не подтверждён. Проверьте результат этой отправки; повторного вопроса не будет.' : 'Не удалось загрузить переписку. Проверьте интернет и повторите попытку.';
}
function validateIdentity(error) {
  if (error.status === 401 || error.code === 'account_changed') { sessionEnded(); window.webprilSessionGate?.end(); return true; }
  if (error.status === 403 && error.code !== 'ai_purchase_required' || error.code === 'ai_access_changed') { clearPrivate(); notice(errorMessage(error)); return true; }
  return false;
}
function quotaStamp(value) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof value?.serverTime !== 'string' || typeof value?.resetsAt !== 'string' || !iso.test(value.serverTime) || !iso.test(value.resetsAt)) return null;
  const server = Date.parse(value.serverTime), reset = Date.parse(value.resetsAt);
  return Number.isFinite(server) && Number.isFinite(reset) && reset > server ? { server, reset } : null;
}
function olderQuota(stamp) {
  return quotaSnapshot && (!stamp || stamp.reset < quotaSnapshot.reset || stamp.server < quotaSnapshot.server);
}
function quota(value) {
  if (!value || !Number.isInteger(value.remaining) || !Number.isInteger(value.limit) || value.limit <= 0 || value.remaining < 0 || value.remaining > value.limit) return false;
  const stamp = quotaStamp(value);
  if (olderQuota(stamp)) return false;
  remaining = value.remaining; currentLimit = value.limit;
  quotaLabel.textContent = `Осталось вопросов сегодня: ${value.remaining} из ${value.limit}`;
  if (stamp) {
    quotaSnapshot = stamp; quotaDeadline = performance.now() + stamp.reset - stamp.server; quotaRetryAt = 0;
    quotaClock = { wall: Date.now(), monotonic: performance.now() };
    scheduleQuotaRefresh();
  }
  if (remaining > 0 && limitNotice) notice('');
  return true;
}
function dailyLimitError(error) {
  const obsolete = error.quota && olderQuota(quotaStamp(error.quota));
  const fresh = quota(error.quota);
  if ((fresh || obsolete) && remaining > 0) return 'Лимит обновился. Попробуйте отправить вопрос ещё раз.';
  if (!obsolete) remaining = 0;
  quotaLabel.textContent = currentLimit === null ? 'На сегодня вопросы закончились.' : `Осталось вопросов сегодня: ${remaining} из ${currentLimit}`;
  return errorMessage(error);
}
function quotaPanelVisible() { return !document.hidden && !voicePanel?.hidden; }
function clearQuotaRefresh() {
  clearTimeout(quotaTimer); quotaTimer = undefined;
  quotaFlight?.abort.abort(); quotaFlight = null;
  quotaDeadline = null; quotaRetryAt = 0; quotaSnapshot = null; quotaClock = null; limitNotice = false;
}
function scheduleQuotaRefresh() {
  clearTimeout(quotaTimer); quotaTimer = undefined;
  if (ended || !accountId || quotaDeadline === null || !quotaPanelVisible()) return;
  const delay = Math.max(0, quotaDeadline - performance.now(), quotaRetryAt - performance.now());
  quotaTimer = setTimeout(refreshQuotaIfDue, Math.min(delay, 2_147_483_647));
}
async function refreshQuotaIfDue() {
  if (ended || !ready || !accountId || quotaFlight || quotaDeadline === null || !quotaPanelVisible()) return;
  if (performance.now() < Math.max(quotaDeadline, quotaRetryAt)) { scheduleQuotaRefresh(); return; }
  const flight = { abort: new AbortController(), revision }; quotaFlight = flight;
  try {
    const data = await request('quota', undefined, flight.abort.signal);
    if (flight.revision !== revision || ended) return;
    quota(data.quota); updateControls();
  } catch (error) {
    if (flight.revision !== revision || validateIdentity(error)) return;
    // Keep the server-confirmed count and all drafts while the connection recovers.
  } finally {
    if (quotaFlight === flight) {
      quotaFlight = null;
      if (quotaDeadline !== null && performance.now() >= quotaDeadline) quotaRetryAt = performance.now() + 30_000;
      scheduleQuotaRefresh();
    }
  }
}
function resumeQuotaRefresh() {
  if (!quotaPanelVisible()) { clearTimeout(quotaTimer); quotaTimer = undefined; return; }
  // Some mobile browsers pause the monotonic clock during OS sleep. A wall-clock
  // discontinuity requests a server check; it never grants questions locally.
  if (quotaClock && Math.abs(Date.now() - quotaClock.wall - (performance.now() - quotaClock.monotonic)) > 1000) {
    quotaDeadline = Math.min(quotaDeadline, performance.now());
  }
  if (quotaDeadline !== null && performance.now() >= Math.max(quotaDeadline, quotaRetryAt)) refreshQuotaIfDue();
  else scheduleQuotaRefresh();
}
window.addEventListener('focus', resumeQuotaRefresh);
window.addEventListener('pageshow', resumeQuotaRefresh);
document.addEventListener('visibilitychange', resumeQuotaRefresh);
function sourceLink(source) {
  if (typeof source?.url !== 'string' || typeof source?.title !== 'string') return null;
  if (source.url.startsWith('//') || !source.url.startsWith('/') && !source.url.startsWith('https://')) return null;
  let url; try { url = new URL(source.url, location.origin); } catch { return null; }
  if (url.origin !== 'https://app.legkie-rody.ru' || url.hash || url.username || url.password) return null;
  const expected = url.pathname === '/article.html' ? ['courseLesson', 'course', 'section']
    : url.pathname === '/my-courses.html' ? (url.searchParams.has('section') ? ['course', 'section'] : ['course']) : null;
  if (!expected) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== expected.length || new Set(keys).size !== expected.length || !expected.every(key => keys.includes(key) && /^[1-9][0-9]*$/.test(url.searchParams.get(key)) && Number.isSafeInteger(Number(url.searchParams.get(key))))) return null;
  const link = document.createElement('a'); link.href = url.href; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function failedMessage(message) {
  return typeof message?.failureMessage === 'string' && message.failureMessage.trim() && message.failureMessage.length <= 500 ? message.failureMessage.trim() : 'Ответ не получен.';
}
function messageNode(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
  const article = document.createElement('article'); article.className = `message ${message.role}-message`; article.dataset.id = String(message.id || '');
  if (message.waiting) article.classList.add('waiting-message');
  if (message.role === 'assistant') { const avatar = document.createElement('span'); avatar.className = 'bot-avatar'; avatar.setAttribute('aria-hidden', 'true'); article.append(avatar); }
  const content = document.createElement('div'); content.className = 'message-content';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.content; content.append(bubble);
  if (message.role === 'user' && message.status === 'failed') {
    const failed = document.createElement('small'); failed.className = 'message-failed'; failed.textContent = failedMessage(message); content.append(failed);
  }
  const date = Date.parse(message.createdAt);
  if (Number.isFinite(date)) { const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = timeFormat.format(date); content.append(time); }
  if (message.role === 'assistant' && Array.isArray(message.sources)) {
    const sources = document.createElement('div'); sources.className = 'message-sources';
    for (const source of message.sources) { const link = sourceLink(source); if (link) sources.append(link); }
    if (sources.childElementCount) {
      const key = String(message.id);
      sources.id = `ai-materials-${key}`; sources.hidden = !expandedSources.has(key);
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'materials-toggle';
      toggle.textContent = 'Ссылки на материалы';
      toggle.setAttribute('aria-controls', sources.id); toggle.setAttribute('aria-expanded', String(!sources.hidden));
      toggle.addEventListener('click', () => {
        sources.hidden = !sources.hidden; toggle.setAttribute('aria-expanded', String(!sources.hidden));
        if (sources.hidden) expandedSources.delete(key); else expandedSources.add(key);
      });
      const materials = document.createElement('div'); materials.className = 'message-materials';
      materials.append(toggle, sources); content.append(materials);
    }
  }
  article.append(content); return article;
}
function render() {
  const nodes = ready ? messages.map(messageNode).filter(Boolean) : [];
  if (ready && replyWaiting && pending && !messages.some(message => message.role === 'assistant' && message.requestId === pending.requestId)) {
    nodes.push(messageNode({ id: `waiting:${pending.requestId}`, role: 'assistant', content: 'Лара готовит ответ…', waiting: true }));
  }
  if (ready && !nodes.length) nodes.push(welcomeMessage());
  conversation.replaceChildren(...nodes); historyMore.hidden = !ready || !hasMore;
}

function merge(incoming, older = false) {
  incoming = Array.isArray(incoming) ? incoming : [];
  const confirmed = new Set(incoming.filter(item => item?.role === 'user' && item.id != null).map(item => item.requestId));
  messages = messages.filter(item => item.id !== sendingId(item.requestId) || !confirmed.has(item.requestId));
  const known = new Map(messages.map((item, index) => [String(item.id), index]));
  const additions = [];
  for (const item of incoming) {
    if (!item || item.id == null) continue;
    const index = known.get(String(item.id));
    if (index === undefined) additions.push(item);
    else messages[index] = item;
  }
  messages = older ? [...additions, ...messages] : [...messages, ...additions]; render();
  if (!older) conversation.scrollTop = conversation.scrollHeight;
}
function restorePending() {
  if (pending) {
    const terminal = messages.find(item => item.role === 'user' && item.requestId === pending.requestId && ['completed', 'failed'].includes(item.status));
    if (!terminal) { replyWaiting = messages.some(item => item.role === 'user' && item.requestId === pending.requestId && item.status === 'pending'); notice('Нажмите «Проверить результат».'); render(); return; }
    pending = null; replyWaiting = false;
  }
  const unmatched = [...messages].reverse().find(item => item.role === 'user' && item.status === 'pending' && item.requestId);
  if (unmatched) {
    pending = { requestId: unmatched.requestId, conversationId: activeConversationId, text: unmatched.content, statusOnly: true };
    replyWaiting = true; render(); conversation.scrollTop = conversation.scrollHeight;
    notice('Нажмите «Проверить результат».');
  } else if ([...messages].reverse().find(item => item.role === 'user')?.status === 'failed') {
    notice(`${failedMessage([...messages].reverse().find(item => item.role === 'user'))} Вопрос учтён в дневном лимите; можно задать новый.`);
  }
}
async function loadHistory(older = false) {
  if (busy || ended || !accountId || !activeConversationId || older && !hasMore) return;
  busy = true; updateControls(); const current = revision; controller = new AbortController();
  if (!older) notice('Загружаем переписку…');
  try {
    const data = await request('history/read', { conversationId: activeConversationId, ...(older ? { before: nextBefore } : {}) }, controller.signal);
    if (current !== revision) return;
    quota(data.quota); hasMore = data.hasMore === true; nextBefore = typeof data.nextBefore === 'string' ? data.nextBefore : null;
    const scrollHeight = conversation.scrollHeight, scrollTop = conversation.scrollTop;
    if (!older) messages = messages.filter(item => pending && item.requestId === pending.requestId && item.id === sendingId(pending.requestId));
    ready = true; acceptConversation(data); merge(data.messages, older);
    if (older) conversation.scrollTop = scrollTop + conversation.scrollHeight - scrollHeight;
    notice('');
    if (!older) restorePending();
  } catch (error) {
    if (current !== revision || validateIdentity(error)) return;
    if (error.status === 404 || error.code === 'ai_purchase_required') { ready = false; messages = []; pending = null; selectAttachment(null); replyWaiting = false; render(); if (error.status === 404) { threadStates.delete(activeConversationId); conversations = conversations.filter(row => row.id !== activeConversationId); renderConversations(); } }
    notice(errorMessage(error));
  } finally { if (current === revision) { busy = false; controller = null; if (threadStates.has(activeConversationId)) saveThread(); updateControls(); } }
}
async function start(id) { if (ended || accountId || typeof id !== 'string') return; accountId = id; if (window.webprilAccount?.user?.id === id) profileSummary(window.webprilAccount); menu.setEnabled(true); await initializeConversations(); }
async function waitForSession() {
  for (let i = 0; i < 150 && !ended && !accountId; i++) {
    if (window.webprilSessionAccountId) { start(window.webprilSessionAccountId); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function submit() {
  if (busy || !ready || ended || !accountId || !pending && remaining === 0) return;
  if (!activeConversationId) allocateConversation();
  const threadId = activeConversationId;
  const wasRetry = !!pending;
  const text = pending?.text || input.value.trim() || (selectedAttachment ? 'Помоги разобраться с результатами анализов.' : ''); if (!text) return;
  replyWaiting = true;
  if (!pending) {
    pending = { requestId: crypto.randomUUID(), conversationId: threadId, text, attachment: selectedAttachment };
    input.value = ''; selectAttachment(null);
    const content = pending.attachment ? `${text}\n\nФайл анализа: ${pending.attachment.name}` : text;
    merge([{ id: sendingId(pending.requestId), role: 'user', content,
      requestId: pending.requestId, status: 'sending', createdAt: new Date().toISOString() }]);
  } else render();
  conversation.scrollTop = conversation.scrollHeight;
  const attempt = pending; busy = true; updateControls(); notice('');
  const current = revision; controller = new AbortController();
  try {
    await ensureConversation(threadId); if (current !== revision) return;
    let data;
    if (attempt.statusOnly || attempt.checkStatus) {
      try { data = await request('messages/status', { requestId: attempt.requestId, conversationId: attempt.conversationId }, controller.signal, attempt.attachment ? 180_000 : 75_000); }
      catch (error) {
        if (error.code !== 'ai_request_not_found') throw error;
        if (attempt.statusOnly) {
          notice('Этот запрос не найден. Обновите страницу, чтобы проверить переписку.');
          replyWaiting = false; render(); return;
        }
      }
    }
    if (!data) {
      const body = { conversationId: attempt.conversationId, requestId: attempt.requestId, text: attempt.text };
      if (attempt.attachment) {
        body.attachment = { name: attempt.attachment.name, mimeType: attempt.attachment.type,
          data: await fileData(attempt.attachment) };
        if (current !== revision) return;
      }
      attempt.checkStatus = true;
      data = await request('messages', body, controller.signal, attempt.attachment ? 180_000 : 75_000);
    }
    if (current !== revision) return;
    replyWaiting = data.status === 'pending';
    quota(data.quota); acceptConversation(data); merge(data.messages);
    if (data.status === 'completed') { pending = null; input.value = ''; notice(''); }
    else if (data.status === 'failed') {
      pending = null; input.value = '';
      const failure = failedMessage(data.messages?.find(item => item.role === 'user' && item.status === 'failed') || data);
      notice(`${failure} Вопрос учтён в дневном лимите; можно задать новый.`);
    } else notice('Нажмите «Проверить результат» через несколько секунд.');
  } catch (error) {
    if (current !== revision || validateIdentity(error)) return;
    replyWaiting = false; render();
    if (!threadStates.get(threadId)?.saved) { notice('Не удалось создать чат. Повторите попытку — вопрос пока не отправлен.'); return; }
    if (error.code === 'ai_purchase_required') { clearPrivate(); notice(errorMessage(error)); return; }
    if (error.code === 'ai_conversation_not_found') { messages = []; pending = null; replyWaiting = false; ready = false; input.value = ''; selectAttachment(null); threadStates.delete(threadId); conversations = conversations.filter(row => row.id !== threadId); renderConversations(); render(); notice(errorMessage(error)); return; }
    const dailyNotice = error.code === 'ai_daily_limit' ? dailyLimitError(error) : null;
    // A busy resend does not disprove acceptance of the original, uncertain upload.
    const uncertainBusy = wasRetry && (attempt.attachment || attempt.statusOnly) && ['ai_busy', 'ai_upload_busy'].includes(error.code);
    if (!uncertainBusy && ['ai_busy', 'ai_upload_busy', 'ai_daily_limit', 'request_id_conflict', 'invalid_ai_message', 'invalid_ai_attachment'].includes(error.code)) {
      messages = messages.filter(item => item.id !== sendingId(attempt.requestId)); render();
      input.value = attempt.text; pending = null; selectAttachment(attempt.attachment || null);
    }
    if (error.code === 'ai_busy') notice('Предыдущий вопрос ещё обрабатывается. Проверьте историю через несколько секунд.');
    if (error.code !== 'ai_busy') notice(dailyNotice || errorMessage(error, !!pending), !!dailyNotice);
  } finally { if (current === revision) { busy = false; controller = null; if (threadStates.has(activeConversationId)) saveThread(); updateControls(); } }
}
function currentVoice(attempt) { return voice === attempt && !attempt.cancelled && !ended && attempt.revision === revision; }
function stopTracks(attempt) { attempt.stream?.getTracks().forEach(track => track.stop()); attempt.stream = null; }
function cancelVoice(message = '') {
  const attempt = voice; voice = null;
  if (attempt) {
    attempt.cancelled = true; attempt.abort?.abort();
    clearInterval(attempt.tick); clearTimeout(attempt.limit);
    if (attempt.recorder?.state === 'recording') { try { attempt.recorder.stop(); } catch {} }
    stopTracks(attempt); attempt.chunks = []; attempt.audio = null;
  }
  voiceStatus.textContent = ''; updateControls();
  if (message) notice(message);
}
function voiceError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Разрешите доступ к микрофону в настройках браузера или напишите вопрос текстом.';
  if (error.name === 'NotFoundError' || error.name === 'NotReadableError') return 'Микрофон недоступен. Проверьте подключение или напишите вопрос текстом.';
  if (['audio_too_long', 'ai_audio_too_long'].includes(error.code)) return 'Запись слишком длинная. Запишите до двух минут и не более 5 МБ.';
  if (['audio_unrecognized', 'ai_audio_unrecognized'].includes(error.code)) return 'Не удалось разобрать речь. Попробуйте записать ещё раз или напишите вопрос текстом.';
  if (['voice_rate_limited', 'voice_daily_limit', 'daily_limit', 'rate_limited', 'ai_daily_limit'].includes(error.code)) return 'Лимит голосового ввода временно исчерпан. Напишите вопрос текстом или попробуйте позже.';
  if (error.code === 'ai_voice_busy') return 'Распознавание сейчас занято. Попробуйте ещё раз чуть позже.';
  if (['invalid_ai_voice', 'invalid_ai_audio'].includes(error.code)) return 'Не удалось прочитать запись. Попробуйте записать ещё раз или напишите вопрос текстом.';
  return 'Голосовой ввод сейчас недоступен. Попробуйте позже или напишите вопрос текстом.';
}
async function startVoice() {
  if (voice || input.disabled || input.value.trim() || selectedAttachment) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    notice('Этот браузер не поддерживает запись голоса. Напишите вопрос текстом.'); return;
  }
  const attempt = { requestId: crypto.randomUUID(), revision, stage: 'permission', chunks: [], size: 0 };
  voice = attempt; voiceStatus.textContent = 'Разрешите доступ к микрофону…'; notice(''); updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!currentVoice(attempt)) { stream.getTracks().forEach(track => track.stop()); return; }
    attempt.stream = stream;
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('unsupported_voice_format');
    const recorder = new MediaRecorder(stream, { mimeType }); attempt.recorder = recorder;
    recorder.ondataavailable = event => {
      if (!currentVoice(attempt) || !event.data?.size) return;
      attempt.chunks.push(event.data); attempt.size += event.data.size;
      if (attempt.size > 5 * 1024 * 1024) cancelVoice(voiceError({ code: 'audio_too_long' }));
    };
    recorder.onerror = () => { if (currentVoice(attempt)) cancelVoice(voiceError({})); };
    recorder.onstop = () => {
      stopTracks(attempt); clearInterval(attempt.tick); clearTimeout(attempt.limit);
      if (!currentVoice(attempt)) return;
      const audio = new Blob(attempt.chunks, { type: recorder.mimeType || mimeType }); attempt.chunks = [];
      if (!audio.size || audio.size > 5 * 1024 * 1024) { cancelVoice(voiceError({ code: audio.size ? 'audio_too_long' : 'audio_unrecognized' })); return; }
      attempt.audio = audio; transcribeVoice(attempt);
    };
    recorder.start(250); attempt.stage = 'recording'; attempt.started = Date.now();
    const timer = () => { if (currentVoice(attempt)) {
      const seconds = Math.min(120, Math.floor((Date.now() - attempt.started) / 1000));
      voiceStatus.textContent = `Запись ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / 2:00`;
    } };
    timer(); attempt.tick = setInterval(timer, 1000); attempt.limit = setTimeout(stopVoice, 119_000); updateControls();
  } catch (error) { if (currentVoice(attempt)) cancelVoice(voiceError(error)); }
}
function stopVoice() {
  const attempt = voice; if (attempt?.stage !== 'recording') return;
  attempt.stage = 'stopping'; clearInterval(attempt.tick); clearTimeout(attempt.limit);
  voiceStatus.textContent = 'Подготавливаем запись…'; updateControls();
  try { attempt.recorder.stop(); stopTracks(attempt); }
  catch (error) { if (currentVoice(attempt)) cancelVoice(voiceError(error)); }
}
async function transcribeVoice(attempt) {
  if (!currentVoice(attempt) || !attempt.audio) return;
  if (attempt.sentAt && Date.now() - attempt.sentAt > 110_000) { cancelVoice('Не удалось подтвердить распознавание. Запишите вопрос ещё раз или напишите текстом.'); return; }
  attempt.stage = 'transcribing'; attempt.abort = new AbortController();
  voiceStatus.textContent = 'Распознаём речь…'; notice(''); updateControls();
  try {
    const data = await fileData(attempt.audio);
    if (!currentVoice(attempt)) return;
    attempt.sentAt ||= Date.now();
    const result = await request('voice', { requestId: attempt.requestId, audio: { mimeType: attempt.audio.type.split(';')[0], data } }, attempt.abort.signal, 180_000);
    if (!currentVoice(attempt)) return;
    if (result.requestId !== attempt.requestId || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4000) throw Object.assign(new Error('invalid transcript'), { code: 'invalid_ai_voice' });
    const text = result.text.trim(); cancelVoice(); input.value = text; updateControls(); input.focus();
    notice('Проверьте текст и нажмите «Отправить».');
  } catch (error) {
    if (!currentVoice(attempt) || validateIdentity(error)) return;
    if (error.code === 'ai_purchase_required') { clearPrivate(); notice(errorMessage(error)); return; }
    if (error.code === 'ai_daily_limit') { const message = dailyLimitError(error); cancelVoice(); notice(message, true); return; }
    const definitive = ['ai_voice_unavailable', 'invalid_ai_voice', 'invalid_ai_audio', 'audio_too_long', 'ai_audio_too_long', 'audio_unrecognized', 'ai_audio_unrecognized', 'voice_rate_limited', 'voice_daily_limit', 'daily_limit', 'rate_limited', 'ai_daily_limit', 'request_id_conflict'].includes(error.code);
    if (definitive) cancelVoice(voiceError(error));
    else { attempt.stage = 'retry'; voiceStatus.textContent = 'Речь пока не распознана'; notice(voiceError(error)); updateControls(); }
  }
}
voiceCancel.addEventListener('click', () => cancelVoice('Запись отменена.'));
voiceRetry.addEventListener('click', () => { if (voice?.stage === 'retry') transcribeVoice(voice); });
document.addEventListener('visibilitychange', () => { if (document.hidden && voice) cancelVoice(); });
// Preserved application panels can be hidden without a document visibility event.
const voicePanel = window.frameElement || document.querySelector('.app');
if (voicePanel) new MutationObserver(() => {
  if (voicePanel.hidden && voice) cancelVoice();
  resumeQuotaRefresh();
}).observe(voicePanel, { attributes: true, attributeFilter: ['hidden'] });
input.addEventListener('input', updateControls);
form.addEventListener('submit', event => {
  event.preventDefault();
  if (voice?.stage === 'recording') stopVoice();
  else if (!voice && !input.value.trim() && !selectedAttachment) startVoice();
  else if (!voice) submit();
});
retry.addEventListener('click', async () => {
  if (pending) { submit(); return; }
  const state = threadStates.get(activeConversationId);
  if (state?.createError) { const id = activeConversationId; try { await ensureConversation(id); if (id === activeConversationId) notice(''); } catch (error) { if (id === activeConversationId && !validateIdentity(error)) notice('Не удалось создать чат. Повторите попытку.'); } return; }
  if (activeConversationId) loadHistory(); else initializeConversations();
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { if (input.disabled) return; input.value = button.dataset.prompt; updateControls(); input.focus(); }));
function openFilePicker() { if (!input.disabled) fileInput.click(); }
attachmentButton.addEventListener('click', openFilePicker);
analysesButton.addEventListener('click', openFilePicker);
removeAttachment.addEventListener('click', () => { if (!input.disabled) { selectAttachment(null); notice(''); } });
fileInput.addEventListener('change', () => {
  let file = fileInput.files?.[0];
  if (!file || input.disabled) { fileInput.value = ''; return; }
  if (!file.type || file.type === 'application/octet-stream') {
    const extension = file.name.split('.').pop().toLowerCase();
    const inferred = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[extension];
    if (inferred) file = new File([file], file.name, { type: inferred, lastModified: file.lastModified });
  }
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || !/\.(pdf|jpe?g|png)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) {
    fileInput.value = ''; notice('Выберите один PDF, JPG или PNG до 10 МБ.'); return;
  }
  selectAttachment(file); notice('');
});
historyMore.addEventListener('click', () => loadHistory(true));
updateControls(); waitForSession();
