import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../Фронт/account-access.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\r?\n/, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
function element(text = '') {
  return { textContent: text, hidden: false, disabled: false, events: {},
    addEventListener(name, fn) { this.events[name] = fn; } };
}
function fixture(authRequest) {
  const email = element('—'), message = element(), link = element(), logout = element();
  const region = element();
  region.querySelector = selector => ({p: message, a: link, button: logout})[selector];
  const events = {}, redirects = [];
  const context = {
    authRequest, URL, location: { hostname: 'app.legkie-rody.ru', href: 'https://app.legkie-rody.ru/profile.html' },
    document: {
      querySelector: selector => selector === '#account-access' ? region : null,
      querySelectorAll: selector => ({'[data-account-email]': [email], '[data-account-logout]': [logout]})[selector] || [],
    },
    window: { addEventListener: (name, fn) => { events[name] = fn; },
      top: { location: { assign: url => { redirects.push(url); } } } },
  };
  vm.runInNewContext(source, context);
  return { email, message, link, logout, events, redirects };
}
const session = (id, email) => ({authenticated: true, user: {id, email}});

test('identity comes from the confirmed server session', async () => {
  const ui = fixture(async () => session('user-a', 'first@example.ru'));
  await flush();
  assert.equal(ui.email.textContent, 'first@example.ru');
  assert.equal(ui.link.hidden, true);
  assert.equal(ui.logout.hidden, false);
});

test('anonymous visitors see sign-in rather than an assumed account', async () => {
  const ui = fixture(async () => ({authenticated: false, user: null}));
  await flush();
  assert.equal(ui.email.textContent, '—');
  assert.equal(ui.link.hidden, false);
  assert.equal(ui.logout.hidden, true);
});

test('new email and an existing email each display their own account', async () => {
  for (const email of ['existing@example.ru', 'new@example.ru']) {
    const ui = fixture(async () => session(email, email));
    await flush();
    assert.equal(ui.email.textContent, email);
  }
});

test('failed recheck does not retain the previous account email', async () => {
  let fails = false;
  const ui = fixture(async () => { if (fails) throw new Error('offline'); return session('a', 'first@example.ru'); });
  await flush();
  fails = true;
  ui.events.focus();
  await flush();
  assert.equal(ui.email.textContent, '—');
  assert.equal(ui.link.hidden, false);
  assert.equal(ui.logout.hidden, true);
});

test('logout reaches the server then discards the cached application panels', async () => {
  const calls = [];
  const ui = fixture(async (path, body) => { calls.push([path, body]); return session('a', 'first@example.ru'); });
  await flush();
  await ui.logout.events.click();
  assert.deepEqual(calls.map(x => x[0]), ['session', 'logout']);
  assert.equal(ui.redirects[0], 'https://app.legkie-rody.ru/login.html');
});

test('a failed logout keeps the user informed and does not claim success', async () => {
  const ui = fixture(async path => { if (path === 'logout') throw new Error('offline'); return session('a', 'first@example.ru'); });
  await flush();
  await ui.logout.events.click();
  assert.equal(ui.redirects.length, 0);
  assert.equal(ui.logout.disabled, false);
  assert.match(ui.message.textContent, /Не удалось выйти/);
});

test('a delayed response cannot restore an older account after a newer check', async () => {
  let resolveFirst, call = 0;
  const ui = fixture(() => ++call === 1 ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve(session('b', 'second@example.ru')));
  ui.events.focus();
  await flush();
  resolveFirst(session('a', 'first@example.ru'));
  await flush();
  assert.equal(ui.email.textContent, 'second@example.ru');
});

test('legacy browser demo purchases cannot grant a real account any entitlement', async () => {
  const code = await readFile(new URL('../Фронт/course-access.js', import.meta.url), 'utf8');
  const context = { window: {}, localStorage: {getItem: () => '{"plan":"premium","demo":true}'} };
  vm.runInNewContext(code, context);
  assert.equal(context.window.courseAccess.get(), null);
  assert.equal(context.window.courseAccess.grant('premium'), false);
});
