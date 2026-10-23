import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../Фронт/auth-gate.js', import.meta.url), 'utf8');
const valid = { authenticated: true, user: { id: 'user-1', email: 'one@example.ru' } };
const replaced = { authenticated: false, user: null, reason: 'session_replaced' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function gate({ iframe = false, replies = [valid], href = 'https://app.legkie-rody.ru/journey.html?_app=old&week=25#day',
  media = [], frames = [] } = {}) {
  const windowEvents = new Map(), documentEvents = new Map(), timers = new Map(), requests = [], redirects = [];
  let nextTimer = 1;
  const lock = { sheet: { disabled: false } };
  const location = {
    href, hostname: new URL(href).hostname,
    replace(value) { redirects.push(value); this.href = value; },
  };
  const owner = iframe ? {
    location: { href, replace(value) { redirects.push(value); } },
    webprilSessionGate: { end(reason) { redirects.push({ ownerEnd: reason }); } },
  } : null;
  const window = { location, addEventListener(name, listener) { windowEvents.set(name, listener); } };
  window.top = owner ?? window;
  const document = {
    hidden: false,
    querySelector(selector) { assert.equal(selector, '#account-lock'); return lock; },
    querySelectorAll(selector) {
      if (selector === 'video, audio') return media;
      if (selector === 'iframe') return frames;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    addEventListener(name, listener) { documentEvents.set(name, listener); },
  };
  const context = {
    window, document, location, URL, AbortSignal,
    setInterval(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    fetch(path, options) {
      requests.push({ path, options });
      const reply = replies.shift();
      if (reply === undefined) throw new Error('Unexpected fetch');
      if (reply instanceof Error) return Promise.reject(reply);
      if (reply?.promise) return reply.promise;
      return Promise.resolve({ ok: true, json: async () => reply });
    },
  };
  vm.runInNewContext(source, context, { filename: 'auth-gate.js' });
  return {
    lock, document, window, requests, redirects, timers,
    fireWindow(name, event = {}) { windowEvents.get(name)?.(event); },
    fireDocument(name, event = {}) { documentEvents.get(name)?.(event); },
    tick() { for (const { callback } of [...timers.values()]) callback(); },
  };
}

test('top window polls every 30 seconds without concealing a verified page', async () => {
  const next = deferred();
  const app = gate({ replies: [valid, next] });
  await flush();
  assert.equal(app.lock.sheet.disabled, true);
  assert.equal(app.timers.size, 1);
  assert.equal([...app.timers.values()][0].delay, 30_000);
  app.tick();
  assert.equal(app.lock.sheet.disabled, true, 'background poll must keep the page visible');
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].path, '/api/auth/session');
  assert.equal(app.requests[1].options.cache, 'no-store');
  next.resolve({ ok: true, json: async () => valid });
  await flush();
  assert.equal(app.lock.sheet.disabled, true);
});

test('iframe delegates replacement to its top window and has no heartbeat', async () => {
  const app = gate({ iframe: true, replies: [replaced] });
  await flush();
  assert.equal(app.timers.size, 0);
  assert.equal(app.lock.sheet.disabled, false);
  assert.deepEqual(app.redirects, [{ ownerEnd: 'session_replaced' }]);
});

test('replacement clears media and preserved frames, then redirects with reason and safe next', async () => {
  const actions = [];
  const media = [{
    pause() { actions.push('pause'); },
    removeAttribute(name) { actions.push(`remove ${name}`); },
    querySelectorAll() { return [{ remove() { actions.push('remove source'); } }]; },
    load() { actions.push('load'); },
  }];
  const frames = [{ remove() { actions.push('remove frame'); } }];
  const app = gate({ replies: [valid, replaced], media, frames });
  await flush();
  app.tick();
  await flush();
  assert.equal(app.lock.sheet.disabled, false);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(actions, ['pause', 'remove src', 'remove source', 'load', 'remove frame']);
  assert.equal(app.redirects.length, 1);
  const url = new URL(app.redirects[0]);
  assert.equal(url.origin, 'https://app.legkie-rody.ru');
  assert.equal(url.pathname, '/login.html');
  assert.equal(url.searchParams.get('reason'), 'session_replaced');
  assert.equal(url.searchParams.get('next'), '/journey.html?week=25#day');
});

test('unauthenticated response and network error both close the page', async () => {
  for (const reply of [{ authenticated: false, user: null }, new Error('offline')]) {
    const app = gate({ replies: [reply] });
    await flush();
    assert.equal(app.lock.sheet.disabled, false);
    assert.equal(app.timers.size, 0);
    assert.equal(new URL(app.redirects[0]).pathname, '/login.html');
  }
});

test('late response cannot reveal a page hidden during pagehide or visibility change', async () => {
  for (const event of ['pagehide', 'visibilitychange']) {
    const pending = deferred();
    const app = gate({ replies: [pending] });
    if (event === 'visibilitychange') {
      app.document.hidden = true;
      app.fireDocument(event);
    } else app.fireWindow(event);
    pending.resolve({ ok: true, json: async () => valid });
    await flush();
    assert.equal(app.lock.sheet.disabled, false, event);
  }
});

test('restoring a page starts exactly one timer', async () => {
  const app = gate({ replies: [valid, valid] });
  await flush();
  app.fireWindow('pagehide');
  assert.equal(app.timers.size, 0);
  app.fireWindow('pageshow', { persisted: true });
  app.fireWindow('pageshow', { persisted: false });
  assert.equal(app.timers.size, 1);
  await flush();
  assert.equal(app.lock.sheet.disabled, true);
});
