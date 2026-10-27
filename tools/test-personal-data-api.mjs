import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../Фронт/personal-data-api.js', import.meta.url), 'utf8');
const accountId = '11111111-1111-4111-8111-111111111111';
const snapshot = () => ({ accountId, weights: [], pressure: [], wellbeing: [], baby: {}, movements: [], readArticles: [], favorites: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(respond, legacy = {}) {
  const calls = [], events = new Map(), documentEvents = new Map(), closed = [];
  let channel;
  const local = new Map(Object.entries(legacy));
  const localStorage = {
    get length() { return local.size; }, key(index) { return [...local.keys()][index] ?? null; },
    getItem(key) { return local.get(key) ?? null; }, setItem(key, value) { local.set(key, value); },
    removeItem(key) { local.delete(key); },
  };
  const sessionStorage = { getItem() { return null; }, setItem() {} };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = new Map(); this.style = {}; }
    append(...items) { this.children.push(...items); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    click() { return this.handlers.get('click')?.(); }
    close() { this.open = false; closed.push(this); }
    remove() { this.removed = true; }
    showModal() { this.open = true; }
    setAttribute() {}
  }
  const body = new Element('body');
  const document = { readyState: 'loading', body,
    addEventListener(name, fn) { documentEvents.set(name, fn); },
    createElement(tag) { return new Element(tag); }, querySelector() { return null; } };
  const window = { top: null, addEventListener(name, fn) { events.set(name, [...(events.get(name) || []), fn]); },
    webprilSessionGate: { end() { window.ended = true; } } };
  window.top = window;
  class BroadcastChannel {
    constructor() { channel = this; }
    addEventListener(_name, fn) { this.listener = fn; }
    postMessage() {}
    receive(value) { this.listener?.({ data: value }); }
  }
  const context = { window, top: window, document, localStorage, sessionStorage, AbortSignal, Promise, setTimeout() {},
    fetch(url, options) { calls.push(options); return respond(url, options, calls.length); }, BroadcastChannel };
  vm.runInNewContext(source, context, { filename: 'personal-data-api.js' });
  return { api: window.personalDataApi, window, calls, local, body, closed, channel,
    fireDocument(name) { return documentEvents.get(name)?.(); }, fireWindow(name) { for (const fn of events.get(name) || []) fn(); } };
}

test('server ownership header is required and account change clears the view', async () => {
  let changed = false;
  const app = harness(async (_url, options) => changed && options.method === 'POST'
    ? { ok: false, status: 409, json: async () => ({ error: 'account_changed' }) }
    : { ok: true, status: 200, json: async () => snapshot() });
  await app.api.load();
  await app.api.write({ operation: 'setFavorite', id: 'breathing', favorite: true });
  assert.equal(app.calls[1].headers['X-Webpril-Account'], accountId);
  changed = true;
  await assert.rejects(app.api.write({ operation: 'setFavorite', id: 'breathing', favorite: false }));
  assert.equal(app.api.isLoaded(), false);
  assert.equal(app.window.ended, true);
  await assert.rejects(app.api.write({ operation: 'setFavorite', id: 'breathing', favorite: true }));
});

test('an out-of-order acknowledgement cannot claim a confirmed current view', async () => {
  const waitPost = deferred();
  const app = harness((_url, options) => options.method === 'POST' ? waitPost.promise :
    Promise.resolve({ ok: true, status: 200, json: async () => snapshot() }));
  await app.api.load();
  const write = app.api.write({ operation: 'setFavorite', id: 'breathing', favorite: true });
  await flush();
  await app.api.load(true);
  waitPost.resolve({ ok: true, status: 200, json: async () => snapshot() });
  await assert.rejects(write, /изменилось/);
});

test('another tab refresh waits for the local write acknowledgement', async () => {
  const waitPost = deferred();
  const app = harness((_url, options) => options.method === 'POST' ? waitPost.promise :
    Promise.resolve({ ok: true, status: 200, json: async () => snapshot() }));
  await app.api.load();
  const write = app.api.write({ operation: 'setFavorite', id: 'breathing', favorite: true });
  await flush();
  app.channel.receive('refresh');
  await flush();
  assert.equal(app.calls.length, 2, 'refresh must wait while POST is in flight');
  waitPost.resolve({ ok: true, status: 200, json: async () => snapshot() });
  await write;
  await flush();
  assert.equal(app.calls.length, 3, 'refresh fetches the latest server snapshot after POST');
  assert.equal(app.api.isLoaded(), true);
});

test('legacy data requires an explicit click; deletion checks the captured bytes', async () => {
  const waitPost = deferred();
  const key = 'webpril:mom-data:v1';
  const old = JSON.stringify({ weights: [{ value: 63, recordedAt: '2026-10-27T10:00:00.000Z' }] });
  const app = harness((_url, options) => options.method === 'POST' ? waitPost.promise :
    Promise.resolve({ ok: true, status: 200, json: async () => snapshot() }), { [key]: old });
  app.fireDocument('DOMContentLoaded');
  await flush();
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  const dialog = app.body.children[0];
  const confirm = dialog.children[4];
  const confirmed = confirm.click();
  await flush();
  const request = app.calls.find(call => call.method === 'POST');
  assert.equal(JSON.parse(request.body).confirmed, true);
  app.local.set(key, JSON.stringify({ weights: [] }));
  waitPost.resolve({ ok: true, status: 200, json: async () => snapshot() });
  await confirmed;
  assert.equal(app.local.has(key), true);
});

test('ending the session before import acknowledgement retains legacy records', async () => {
  const waitPost = deferred();
  const key = 'webpril:movements:v1';
  const app = harness((_url, options) => options.method === 'POST' ? waitPost.promise :
    Promise.resolve({ ok: true, status: 200, json: async () => snapshot() }), { [key]: '[1700000000000]' });
  app.fireDocument('DOMContentLoaded');
  await flush();
  const confirm = app.body.children[0].children[4];
  const confirmed = confirm.click();
  await flush();
  app.fireWindow('webpril:session-ended');
  waitPost.resolve({ ok: true, status: 200, json: async () => snapshot() });
  await confirmed;
  assert.equal(app.local.has(key), true);
  assert.equal(app.api.isLoaded(), false);
});
