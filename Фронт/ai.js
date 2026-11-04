const conversation = document.querySelector('#conversation');
const input = document.querySelector('#chat-input');
const form = document.querySelector('#chat-form');
const send = form.querySelector('.send-button');
const status = document.querySelector('#chat-status');
const quotaLabel = document.querySelector('#chat-quota');
const historyDialog = document.querySelector('#history-dialog');
const historyList = document.querySelector('#history-list');
const historyMore = document.querySelector('#history-more');
const retry = document.querySelector('#chat-retry');
let accountId, revision = 0, controller, ended = false, ready = false;
let messages = [], hasMore = false, nextBefore = null, busy = false, pending = null;
let remaining = null;
const expandedSources = new Set();
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const sendingId = requestId => `sending:${requestId}`;

function resizeChat() { document.documentElement.style.setProperty('--chat-viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', resizeChat);
window.addEventListener('resize', resizeChat);
resizeChat();
function notice(message) { status.textContent = message; status.hidden = !message; }
function updateControls() {
  input.disabled = !ready || busy || !!pending || remaining === 0;
  send.disabled = input.disabled || !input.value.trim();
  retry.hidden = busy || (!pending && ready);
  retry.textContent = pending ? 'Проверить результат' : 'Повторить загрузку';
}
function clearPrivate() {
  revision++; controller?.abort(); controller = null;
  accountId = null; ready = false; busy = false; pending = null;
  messages = []; hasMore = false; nextBefore = null; remaining = null;
  expandedSources.clear();
  input.value = ''; conversation.replaceChildren(); historyList.replaceChildren();
  historyMore.hidden = true; quotaLabel.textContent = '';
  if (historyDialog.open) historyDialog.close();
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
  const summary = document.querySelector('#ai-profile-summary');
  if (id && summary) summary.textContent = event.detail?.week ? `${event.detail.week}-я неделя беременности` : event.detail?.profile?.stage === 'mother' ? 'Материалы для мамы' : 'Личные данные пока не заполнены';
});

async function request(path, body, signal) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), body?.text ? 75_000 : 20_000);
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch('/api/auth/ai/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Webpril-Account': accountId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(data?.message || 'Чат временно недоступен.'), { code: data?.error, status: response.status });
    if (!data || data.accountId !== accountId) throw Object.assign(new Error('Аккаунт изменился.'), { code: 'account_changed' });
    return data;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
function errorMessage(error, sending = false) {
  if (error.code === 'ai_purchase_required') return 'AI врач доступен после покупки курса. Посмотрите доступные курсы.';
  if (error.code === 'ai_daily_limit') return 'На сегодня использованы все 30 вопросов. Новые вопросы будут доступны завтра.';
  if (error.code === 'ai_unavailable') return 'AI врач временно недоступен. Попробуйте позже.';
  if (error.code === 'invalid_ai_message') return 'Проверьте текст вопроса и отправьте снова.';
  if (error.code === 'ai_access_changed') return 'Доступ к AI врачу изменился. Обновите страницу.';
  return sending ? 'Ответ пока не подтверждён. Проверьте результат этой отправки; повторного вопроса не будет.' : 'Не удалось загрузить переписку. Проверьте интернет и повторите попытку.';
}
function validateIdentity(error) {
  if (error.status === 401 || error.code === 'account_changed') { sessionEnded(); window.webprilSessionGate?.end(); return true; }
  if (error.status === 403 && error.code !== 'ai_purchase_required' || error.code === 'ai_access_changed') { clearPrivate(); notice(errorMessage(error)); return true; }
  return false;
}
function quota(value) {
  if (value && Number.isInteger(value.remaining) && Number.isInteger(value.limit)) {
    remaining = value.remaining;
    quotaLabel.textContent = `Осталось вопросов сегодня: ${value.remaining} из ${value.limit}`;
  }
}
function sourceLink(source) {
  if (typeof source?.url !== 'string' || typeof source?.title !== 'string') return null;
  if (source.url.startsWith('//') || !source.url.startsWith('/') && !source.url.startsWith('https://')) return null;
  let url; try { url = new URL(source.url, location.origin); } catch { return null; }
  if (url.origin !== 'https://app.legkie-rody.ru' || url.hash || url.username || url.password) return null;
  const expected = url.pathname === '/article.html' ? ['courseLesson', 'course', 'section']
    : url.pathname === '/my-courses.html' ? ['course'] : null;
  if (!expected) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== expected.length || new Set(keys).size !== expected.length || !expected.every(key => keys.includes(key) && /^[1-9][0-9]*$/.test(url.searchParams.get(key)) && Number.isSafeInteger(Number(url.searchParams.get(key))))) return null;
  const link = document.createElement('a'); link.href = url.href; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
}
function messageNode(message) {
  if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
  const article = document.createElement('article'); article.className = `message ${message.role}-message`; article.dataset.id = String(message.id || '');
  if (message.role === 'assistant') { const avatar = document.createElement('span'); avatar.className = 'bot-avatar'; avatar.setAttribute('aria-hidden', 'true'); article.append(avatar); }
  const content = document.createElement('div'); content.className = 'message-content';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.content; content.append(bubble);
  if (message.role === 'user' && message.status === 'failed') {
    const failed = document.createElement('small'); failed.className = 'message-failed'; failed.textContent = 'Ответ не получен'; content.append(failed);
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
      toggle.textContent = 'Ссылка на материалы';
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
  conversation.replaceChildren(...messages.map(messageNode).filter(Boolean));
  historyList.replaceChildren(...messages.map(message => {
    const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${message.role === 'user' ? 'Вы' : 'Лара'}: ${typeof message.content === 'string' ? message.content.slice(0, 90) : ''}`;
    button.addEventListener('click', () => { historyDialog.close(); conversation.querySelectorAll('.message')[messages.indexOf(message)]?.scrollIntoView({ block: 'center' }); });
    item.append(button); return item;
  }));
  historyMore.hidden = !hasMore; document.querySelector('#history-empty').hidden = messages.length > 0;
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
  if (pending) return;
  const unmatched = [...messages].reverse().find(item => item.role === 'user' && item.status === 'pending' && item.requestId);
  if (unmatched) {
    pending = { requestId: unmatched.requestId, text: unmatched.content };
    notice('Этот вопрос ещё обрабатывается. Нажмите «Проверить результат».');
  } else if ([...messages].reverse().find(item => item.role === 'user')?.status === 'failed') {
    notice('Ответ не получен. Вопрос учтён в дневном лимите; можно задать новый.');
  }
}
async function loadHistory(older = false) {
  if (busy || ended || !accountId || older && !hasMore) return;
  busy = true; updateControls(); const current = revision; controller = new AbortController();
  if (!older) notice('Загружаем переписку…');
  try {
    const data = await request(older ? 'history/read' : 'history', older ? { before: nextBefore } : undefined, controller.signal);
    if (current !== revision) return;
    quota(data.quota); hasMore = data.hasMore === true; nextBefore = typeof data.nextBefore === 'string' ? data.nextBefore : null;
    merge(data.messages, older); ready = true;
    notice(older ? '' : messages.length ? '' : 'Задайте Ларе вопрос. Переписка хранится 90 дней.');
    if (!older) restorePending();
  } catch (error) {
    if (current !== revision || validateIdentity(error)) return;
    if (error.code === 'ai_purchase_required') { ready = false; messages = []; render(); }
    notice(errorMessage(error));
  } finally { if (current === revision) { busy = false; controller = null; updateControls(); } }
}
async function start(id) { if (ended || accountId || typeof id !== 'string') return; accountId = id; await loadHistory(); }
async function waitForSession() {
  for (let i = 0; i < 150 && !ended && !accountId; i++) {
    if (window.webprilSessionAccountId) { start(window.webprilSessionAccountId); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function submit() {
  if (busy || !ready || ended || !accountId || !pending && remaining === 0) return;
  const text = pending?.text || input.value.trim(); if (!text) return;
  if (!pending) {
    pending = { requestId: crypto.randomUUID(), text };
    input.value = '';
    merge([{ id: sendingId(pending.requestId), role: 'user', content: text,
      requestId: pending.requestId, status: 'sending', createdAt: new Date().toISOString() }]);
  }
  const attempt = pending; busy = true; updateControls(); notice('Лара готовит ответ…');
  const current = revision; controller = new AbortController();
  try {
    const data = await request('messages', attempt, controller.signal);
    if (current !== revision) return;
    quota(data.quota); merge(data.messages);
    if (data.status === 'completed') { pending = null; input.value = ''; notice(''); }
    else if (data.status === 'failed') {
      pending = null; input.value = '';
      notice('Ответ не получен. Вопрос учтён в дневном лимите; можно задать новый.');
    } else notice('Вопрос принят. Ответ ещё готовится. Нажмите «Проверить результат» через несколько секунд.');
  } catch (error) {
    if (current !== revision || validateIdentity(error)) return;
    if (error.code === 'ai_purchase_required') { clearPrivate(); notice(errorMessage(error)); return; }
    if (error.code === 'ai_daily_limit') { remaining = 0; quotaLabel.textContent = 'Осталось вопросов сегодня: 0 из 30'; }
    if (['ai_busy', 'ai_daily_limit', 'request_id_conflict', 'invalid_ai_message'].includes(error.code)) {
      messages = messages.filter(item => item.id !== sendingId(attempt.requestId)); render();
      input.value = attempt.text; pending = null;
    }
    if (error.code === 'ai_busy') notice('Предыдущий вопрос ещё обрабатывается. Проверьте историю через несколько секунд.');
    if (error.code !== 'ai_busy') notice(errorMessage(error, !!pending));
  } finally { if (current === revision) { busy = false; controller = null; updateControls(); } }
}
input.addEventListener('input', updateControls);
form.addEventListener('submit', event => { event.preventDefault(); submit(); });
retry.addEventListener('click', () => pending ? submit() : loadHistory());
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { if (input.disabled) return; input.value = button.dataset.prompt; updateControls(); input.focus(); }));
document.querySelector('#attachment').addEventListener('click', () => notice('Вложения пока недоступны. Напишите вопрос текстом.'));
document.querySelector('#history-open').addEventListener('click', () => historyDialog.showModal());
historyMore.addEventListener('click', () => loadHistory(true));
document.querySelector('#history-close').addEventListener('click', () => historyDialog.close());
document.querySelector('#return-chat').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', event => {
  if (event.target !== historyDialog) return;
  const bounds = historyDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) historyDialog.close();
});
updateControls(); waitForSession();
