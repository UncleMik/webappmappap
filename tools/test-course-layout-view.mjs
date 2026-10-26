import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../Фронт/course-views.js', import.meta.url), 'utf8').replaceAll('export ', '');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = (ttl, extra = {}) => ({ ok: true, json: async () => ({ serverTime: '2026-10-26T00:00:00Z',
  expiresAt: new Date(Date.parse('2026-10-26T00:00:00Z') + ttl).toISOString(),
  validUntil: new Date(Date.parse('2026-10-26T00:00:00Z') + ttl).toISOString(), ...extra }) });
function harness(replies) {
  const calls = [], timers = new Map(), states = [], events = {};
  let id = 0;
  const context = vm.createContext({ Date, performance: { now: () => 0 }, AbortController,
    document: { visibilityState: 'visible', addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener() {} },
    fetch: async (url, options) => { calls.push({ url, options }); const response = replies.shift(); return typeof response === 'function' ? response() : response; },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: n => timers.delete(n),
    states,
  });
  vm.runInContext(source + `\nglobalThis.view = createCourseView({url:'/lesson', relatedUrl:'/course',
    clear: reason => states.push(['clear',reason]), loading:()=>states.push(['loading']),
    render:data=>states.push(['render',data]), error:e=>states.push(['error',e.status || e.message])}); view.start();`, context);
  return { calls, timers, states, context, events };
}

test('lesson and navigation share the earliest deadline and no-store credentials', async () => {
  const h = harness([reply(80000, { lesson: { lessonId: 1 } }), reply(15000, { course: { title: 'Course' } })]);
  await flush();
  assert.ok(h.timers.size === 1 && [...h.timers.values()][0].ms === 15000);
  assert.equal(h.states.find(s => s[0] === 'render')[1].navigation.title, 'Course');
  assert.ok(h.calls.every(c => c.options.cache === 'no-store' && c.options.credentials === 'same-origin'));
  assert.equal(h.calls[0].options.signal, h.calls[1].options.signal);
});
test('lesson never appears while its navigation response is pending', async () => {
  let finish;
  const h = harness([reply(80000), () => new Promise(resolve => { finish = resolve; })]);
  await flush();
  assert.ok(!h.states.some(s => s[0] === 'render'));
  finish(reply(80000)); await flush();
  assert.equal(h.states.filter(s => s[0] === 'render').length, 1);
});
for (const status of [401, 403, 503]) test(`navigation ${status} closes a valid lesson`, async () => {
  const h = harness([reply(80000), { ok: false, status }]); await flush();
  assert.ok(!h.states.some(s => s[0] === 'render'));
  assert.equal(h.states.at(-1)[1], status);
});
test('late navigation cannot reveal a lesson after page is hidden', async () => {
  let finish;
  const h = harness([reply(80000), () => new Promise(resolve => { finish = resolve; })]); await flush();
  h.context.document.visibilityState = 'hidden'; h.events.visibilitychange();
  finish(reply(80000)); await flush();
  assert.ok(!h.states.some(s => s[0] === 'render'));
  assert.equal(h.calls[0].options.signal.aborted, true);
});
