import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const viewSource = readFileSync(new URL('../Фронт/course-views.js', import.meta.url), 'utf8').replaceAll('export ', '');
const source = readFileSync(new URL('../Фронт/journey-courses.js', import.meta.url), 'utf8')
  .replace(/^import [^\n]*\n/gm, '').replaceAll('export ', '');
const bannerSource = readFileSync(new URL('../Фронт/course-banners.js', import.meta.url), 'utf8').replaceAll('export ', '');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; }
  append(...nodes) { for (const n of nodes) this.children.push(...(n.tag === 'fragment' ? n.children : [n])); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
const offers = { offers: [{ items: [
  { productId: 10, type: 'training', title: 'Экспресс' },
  { productId: 20, type: 'training', title: 'Основной курс' },
  { productId: 30, type: 'groups', title: 'Встречи' },
] }, { items: [{ productId: 20, type: 'training', title: 'Основной курс' }] }] };
const owned = [{ productId: 20, title: 'Основной курс', lessonCount: 12 }];
function payload(courses = owned) {
  const now = Date.now();
  return { courses, serverTime: new Date(now).toISOString(), expiresAt: new Date(now + 4000).toISOString(), validUntil: new Date(now + 4000).toISOString() };
}
function response(data, status = 200) { return { ok: status === 200, status, json: async () => data }; }
function harness(replies = [response(offers), response(payload())]) {
  const list = new Element('list'), status = new Element('status'), retry = new Element('button');
  const arrows = [new Element('button'), new Element('button')];
  const docEvents = {}, windowEvents = {}, timers = new Map(), requests = [];
  const section = { querySelector: selector => ({ '.course-list': list, '.journey-courses-status': status, '.journey-courses-retry': retry })[selector], querySelectorAll: () => arrows };
  const document = { visibilityState: 'visible', querySelector: () => section,
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    addEventListener: (type, fn) => { docEvents[type] = fn; } };
  let timerId = 0;
  const context = vm.createContext({ document, window: { addEventListener: (type, fn) => { windowEvents[type] = fn; } },
    Date, performance: { now: () => 0 }, AbortController, AbortSignal, queueMicrotask,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); const r = replies.shift(); if (!r) throw new Error('missing response'); return typeof r === 'function' ? r() : r; } });
  vm.runInContext(viewSource + '\n' + bannerSource + '\n' + source, context);
  return { list, status, retry, arrows, document, docEvents, windowEvents, requests, replies, timers, context };
}
const buttonOf = card => card.children.find(n => n.tag === 'a');

test('no demo locks or owned links while the server check is pending', async () => {
  let finish;
  const h = harness([response(offers), () => new Promise(resolve => { finish = resolve; })]);
  await flush();
  assert.equal(h.list.children.length, 0);
  assert.match(h.status.textContent, /Проверяем/);
  finish(response(payload())); await flush();
  assert.equal(h.list.children.length, 2);
  assert.equal(h.list.children[0].dataset.productId, 20);
  assert.equal(h.list.children[0].dataset.access, 'available');
  assert.equal(buttonOf(h.list.children[0]).href, 'my-courses.html?course=20');
  assert.equal(h.list.children[0].children[0].children.length, 0);
  assert.equal(buttonOf(h.list.children[1]).href, 'courses.html');
  assert.equal(h.list.children[1].children[0].children[0].tag, 'svg');
  assert.ok(h.requests.every(r => r.options.cache === 'no-store' && r.options.credentials === 'same-origin'));
});

test('no purchases means locked real catalogue, deduplicated products, no group cards', async () => {
  const h = harness([response(offers), response(payload([]))]); await flush();
  assert.deepEqual(h.list.children.map(n => n.dataset.productId), [10, 20]);
  assert.ok(h.list.children.every(n => n.dataset.access === 'locked' && buttonOf(n).href === 'courses.html'));
});

for (const code of [401, 403, 503]) test(`access failure ${code} clears cards and offers retry`, async () => {
  const h = harness([response(offers), response({}, code), response(payload())]); await flush();
  assert.equal(h.list.children.length, 0); assert.equal(h.retry.hidden, false);
  await h.retry.onclick(); await flush();
  assert.equal(h.list.children[0].dataset.access, 'available');
});

test('expiry clears a previously available course before a failed renewal', async () => {
  const h = harness([response(offers), response(payload()), response({}, 503)]); await flush();
  const expiry = [...h.timers.values()].find(t => t.ms < 5000);
  assert.ok(expiry); await expiry.fn(); await flush();
  assert.equal(h.list.children.length, 0); assert.match(h.status.textContent, /недоступна/);
});

test('hide removes stale owned cards, return checks rights again and locks revoked products', async () => {
  const h = harness([response(offers), response(payload()), response(payload([]))]); await flush();
  h.document.visibilityState = 'hidden'; h.docEvents.visibilitychange();
  assert.equal(h.list.children.length, 0);
  h.document.visibilityState = 'visible'; h.docEvents.visibilitychange(); await flush();
  assert.ok(h.list.children.every(n => n.dataset.access === 'locked'));
});

test('damaged rights do not become a valid unpaid catalogue', async () => {
  const h = harness([response(offers), response(payload([{ productId: 20, title: 'Bad', lessonCount: -1 }]))]); await flush();
  assert.equal(h.list.children.length, 0); assert.equal(h.retry.hidden, false);
});

test('catalogue failure can be retried without creating duplicate views', async () => {
  const h = harness([response({}, 503), response(offers), response(payload())]); await flush();
  assert.equal(h.list.children.length, 0); assert.equal(h.retry.hidden, false);
  await h.retry.onclick(); await flush();
  assert.equal(h.list.children.length, 2);
  assert.equal(h.requests.filter(r => r.url === '/api/auth/courses').length, 1);
});

test('old purchased products outside current offers remain usable', async () => {
  const h = harness([response(offers), response(payload([{ productId: 99, title: '<Old course>', lessonCount: 1 }]))]); await flush();
  assert.equal(h.list.children[0].dataset.productId, 99);
  assert.equal(buttonOf(h.list.children[0]).href, 'my-courses.html?course=99');
  assert.equal(h.list.children[0].children[1].children[0].textContent, '<Old course>');
});

test('journey initial HTML has no fake course cards and all-courses opens owned list', () => {
  const html = readFileSync(new URL('../Фронт/journey.html', import.meta.url), 'utf8');
  const courses = html.split('aria-labelledby="courses-title"')[1].split('</section>')[0];
  assert.match(courses, /href="my-courses.html">Все курсы/);
  assert.doesNotMatch(courses, /Подготовка к родам|Здоровая спина|course-lock-icon/);
  assert.match(html, /type="module" src="journey-courses.js\?v=/);
});
