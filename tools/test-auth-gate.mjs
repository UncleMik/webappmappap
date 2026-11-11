import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../Фронт/auth-gate.js', import.meta.url), 'utf8');
const session = { authenticated: true, user: { id: 'account-1', email: 'test@example.test' } };
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const window = new EventTarget(), document = new EventTarget();
  const requests = [], redirects = [], sheet = { disabled: false };
  document.hidden = false;
  document.querySelector = () => ({ sheet });
  document.querySelectorAll = () => [];
  window.top = window;
  window.location = { href: 'https://app.legkie-rody.ru/club.html?poll=1#events',
    hostname: 'app.legkie-rody.ru', replace: url => redirects.push(url) };
  runInNewContext(source, { window, document, location: window.location, Event, URL, AbortSignal,
    setInterval: () => 1, clearInterval() {}, fetch: () => new Promise((resolve, reject) => requests.push({
      resolve: value => resolve({ ok: true, json: async () => value }), reject
    })) });
  return { window, document, requests, redirects, sheet };
}

test('an interrupted session check cannot replace navigation to the poll chat with login', async () => {
  const env = setup();
  env.window.dispatchEvent(new Event('pagehide'));
  env.requests[0].reject(new Error('navigation cancelled fetch'));
  await settle();
  assert.deepEqual(env.redirects, []);
  assert.equal(env.sheet.disabled, false);
});

test('returning to the page checks again and ignores a late response from before leaving', async () => {
  const env = setup();
  env.document.hidden = true;
  env.document.dispatchEvent(new Event('visibilitychange'));
  env.document.hidden = false;
  env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.requests.length, 2);
  env.requests[1].resolve(session);
  await settle();
  assert.equal(env.sheet.disabled, true);
  env.requests[0].resolve({ authenticated: false });
  await settle();
  assert.deepEqual(env.redirects, []);
  assert.equal(env.sheet.disabled, true);
});

test('a current failed session check still closes access', async () => {
  const env = setup();
  env.requests[0].reject(new Error('offline'));
  await settle();
  assert.equal(env.redirects.length, 1);
  assert.equal(env.sheet.disabled, false);
});

test('a revoked session on return still closes access', async () => {
  const env = setup();
  env.requests[0].resolve(session);
  await settle();
  env.window.dispatchEvent(new Event('pagehide'));
  const event = new Event('pageshow');
  event.persisted = true;
  env.window.dispatchEvent(event);
  assert.equal(env.sheet.disabled, false);
  env.requests[1].resolve({ authenticated: false, reason: 'session_replaced' });
  await settle();
  assert.equal(env.redirects.length, 1);
  assert.match(env.redirects[0], /reason=session_replaced/);
});
