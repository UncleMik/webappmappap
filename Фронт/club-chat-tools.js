const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messageId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= 9223372036854775807n;
const emptyDraft = () => ({ text: '', replyTo: null, pending: null });

// Build nodes rather than HTML; trailing prose punctuation stays outside links.
export function appendMessageText(target, text) {
  const value = String(text ?? ''), doc = target.ownerDocument;
  const urls = /https?:\/\/[^\s<>"'«»]+/gi;
  let offset = 0;
  target.style.whiteSpace = 'pre-wrap';
  for (const match of value.matchAll(urls)) {
    if (match.index && /[\w:/]/.test(value[match.index - 1])) continue;
    let url = match[0].replace(/[.,!?;:…]+$/u, '');
    let previous;
    do {
      previous = url;
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        if (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
      }
      url = url.replace(/[.,!?;:…]+$/u, '');
    } while (url !== previous);
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) continue;
    target.append(doc.createTextNode(value.slice(offset, match.index)));
    const link = doc.createElement('a');
    link.href = parsed.href; link.textContent = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    target.append(link); offset = match.index + url.length;
  }
  target.append(doc.createTextNode(value.slice(offset)));
}

function validPending(value) {
  const body = value?.body;
  if (!body || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000
    || body.text !== body.text.trim() || !(body.replyTo === null || messageId(body.replyTo))
    || value.signature !== JSON.stringify({ text: body.text, replyTo: body.replyTo })) return null;
  return { signature: value.signature, body: { requestId: body.requestId, text: body.text, replyTo: body.replyTo } };
}

function sanitizeDraft(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 2000) return emptyDraft();
  return { text: value.text, replyTo: messageId(value.replyTo) ? value.replyTo : null, pending: validPending(value.pending) };
}

/**
 * Bind only after server identity is confirmed. bind restores text and returns
 * {text,replyTo,pending}; replyTo contains only an ID, never a cached quotation.
 * save({replyTo,pending}) updates supplied context fields, preserving omitted ones.
 * Pending is independent of edited text: the caller decides when to clear it.
 * onChange runs on user input before save, so it may update context via save.
 * bind/save/clear never invoke onChange. clear clears both UI and stored draft;
 * unbind clears UI and memory, retaining storage unless purge:true is supplied.
 * setBusy makes the textarea read-only. No method sends messages.
 */
export function createDraftStore({ input, onChange, room }) {
  let accountId = null, state = emptyDraft();
  const fallback = new Map();
  const key = id => 'webpril:club-draft:v1:' + room + ':' + id;
  function read(id) {
    let value = fallback.get(id) ?? null;
    if (value === null) {
      try { value = localStorage.getItem(key(id)); } catch { /* Private mode or denied storage. */ }
    }
    try { return sanitizeDraft(JSON.parse(value)); } catch { return emptyDraft(); }
  }
  function remove(id) {
    fallback.delete(id);
    try { localStorage.removeItem(key(id)); } catch { /* Keep the chat usable without storage. */ }
  }
  function resize() {
    input.style.height = '44px';
    const height = Math.max(44, Math.min(120, input.scrollHeight));
    input.style.height = height + 'px';
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
  }
  function save(context = {}) {
    if (!accountId) return;
    state = sanitizeDraft({ text: input.value,
      replyTo: Object.hasOwn(context, 'replyTo') ? context.replyTo : state.replyTo,
      pending: Object.hasOwn(context, 'pending') ? context.pending : state.pending });
    if (!state.text.trim() && !state.pending) { state.replyTo = null; remove(accountId); return; }
    const value = JSON.stringify(state);
    fallback.set(accountId, value);
    try { localStorage.setItem(key(accountId), value); } catch { /* In-memory draft still works. */ }
  }
  input.addEventListener('input', () => { resize(); try { onChange?.(); } finally { save(); } });
  return {
    bind(id) {
      if (typeof id !== 'string' || !UUID.test(id)) {
        accountId = null; state = emptyDraft(); input.value = ''; resize(); return emptyDraft();
      }
      if (accountId !== id) { accountId = id; state = read(id); input.value = state.text; resize(); }
      return sanitizeDraft(state);
    },
    save,
    clear() { if (accountId) remove(accountId); state = emptyDraft(); input.value = ''; resize(); },
    unbind({ purge = false } = {}) {
      if (purge && accountId) remove(accountId);
      accountId = null; state = emptyDraft(); input.value = ''; input.readOnly = false; resize();
    },
    resize,
    setBusy(value) { input.readOnly = Boolean(value); },
  };
}

export async function copyMessageText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  } catch { /* Older browsers may still allow the selection-based fallback. */ }
  const active = document.activeElement, selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = active && typeof active.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const textarea = document.createElement('textarea');
  textarea.value = value; textarea.readOnly = true; textarea.tabIndex = -1;
  textarea.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true }); textarea.select(); textarea.setSelectionRange(0, value.length);
    if (!document.execCommand('copy')) throw new Error('copy_failed');
  } catch { throw new Error('Не удалось скопировать текст. Выделите сообщение и скопируйте вручную.'); }
  finally {
    textarea.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (inputSelection && active?.isConnected) active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
