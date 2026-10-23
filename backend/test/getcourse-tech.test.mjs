import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGetCourseTech, GetCourseTechError } from '../getcourse-tech.mjs';

const config = {
  schoolOrigin: 'https://legkierody.ru',
  developerKey: 'developer-test',
  schoolKey: 'school-test',
};

function ok(data) {
  return Response.json({ status: true, data });
}

function client(fetchImpl, other = {}) {
  return createGetCourseTech({ ...config, fetchImpl, ...other });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof GetCourseTechError);
    assert.equal(error.code, code);
    return true;
  });
}

test('uses exact read-only paths, queries, and combined Bearer header', async () => {
  const requests = [];
  const api = client(async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok(url.pathname.endsWith('/get-fields') ? { id: 42, email: 'student+test@example.org' } : []);
  });
  assert.deepEqual(await api.getTrainings(), []);
  assert.deepEqual(await api.getUserFields({ userId: 42 }), { id: 42, email: 'student+test@example.org' });
  assert.deepEqual(await api.getUserFields({ email: 'student+test@example.org' }), { id: 42, email: 'student+test@example.org' });
  assert.deepEqual(await api.getPurchases(42), []);
  assert.deepEqual(await api.getUserTrainings(42), []);
  assert.deepEqual(await api.getLessonStatuses(42), []);
  assert.deepEqual(requests.map(({ url }) => `${url.pathname}${url.search}`), [
    '/pl/api/v1/common/get-trainings',
    '/pl/api/v1/user/get-fields?userId=42',
    '/pl/api/v1/user/get-fields?email=student%2Btest%40example.org',
    '/pl/api/v1/user/get-purchases?userId=42',
    '/pl/api/v1/user/get-trainings?userId=42',
    '/pl/api/v1/user/get-lesson-answers?userId=42',
  ]);
  for (const { url, options } of requests) {
    assert.equal(url.origin, config.schoolOrigin);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer developer-test_school-test');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('lesson answers return only mission status evidence and discard response text', async () => {
  const raw = [
    { id: 7, user_id: 42, lesson_id: 101, type: 'mission_answer', status: 'accepted',
      updated_at: '2026-10-23 12:00:00', answer_text: 'private student text',
      user_name: 'private name', files: ['private file'] },
    { id: 8, user_id: 42, lesson_id: 101, type: 'free_comment', status: 'accepted',
      comment: 'private comment' },
    { id: 9, user_id: 42, lesson_id: 102, type: 'mission_answer', status: 'viewed',
      updated_at: null, created_at: '2026-10-22 10:00:00' },
    { id: 10, user_id: 42, lesson_id: 103, type: 'mission_answer', status: 'new',
      updated_at: null, created_at: null },
    { id: 11, user_id: 42, lesson_id: 104, type: 'unknown_type', status: 'accepted' },
  ];
  const result = await client(async () => ok(raw)).getLessonStatuses(42);
  assert.deepEqual(result, [
    { lessonId: 101, status: 'accepted', updatedAt: '2026-10-23 12:00:00' },
    { lessonId: 102, status: 'viewed', updatedAt: '2026-10-22 10:00:00' },
    { lessonId: 103, status: 'new', updatedAt: null },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|free_comment|unknown_type|"id":/);
});

test('malformed mission status or mismatched user fails without exposing raw answers', async () => {
  const answer = { user_id: 42, lesson_id: 101, type: 'mission_answer', status: 'accepted',
    answer_text: 'private student text' };
  for (const data of [
    {}, [null], [{ ...answer, user_id: 43 }], [{ ...answer, lesson_id: null }],
    [{ ...answer, status: 'unknown' }], [{ ...answer, status: null }],
    [{ ...answer, type: 'free_comment', user_id: 43 }],
  ]) {
    await assert.rejects(client(async () => ok(data)).getLessonStatuses(42), error => {
      assert.equal(error.code, 'invalid_response');
      assert.doesNotMatch(String(error), /private|answer_text|42|43/);
      return true;
    });
  }
});

test('accepts documented user object or array and rejects unexpected data shapes', async () => {
  assert.deepEqual(await client(async () => ok([{ id: 1 }])).getUserFields({ userId: 1 }), [{ id: 1 }]);
  await rejectsCode(client(async () => ok({ id: 1 })).getPurchases(1), 'invalid_response');
  await rejectsCode(client(async () => ok([null])).getTrainings(), 'invalid_response');
  await rejectsCode(client(async () => ok('wrong')).getUserTrainings(1), 'invalid_response');
  await rejectsCode(client(async () => ok(null)).getUserFields({ userId: 1 }), 'invalid_response');
});

test('rejects malformed success, API rejection, HTTP error, and redirect', async () => {
  await rejectsCode(client(async () => new Response('{', { status: 200 })).getTrainings(), 'invalid_response');
  await rejectsCode(client(async () => Response.json({ status: 'true', data: [] })).getTrainings(), 'api_rejected');
  await rejectsCode(client(async () => Response.json({ status: false, message: 'private', data: [] })).getTrainings(), 'api_rejected');
  await rejectsCode(client(async () => new Response('private', { status: 403 })).getTrainings(), 'http_error');
  await rejectsCode(client(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } })).getTrainings(), 'redirect');
});

test('rejects incomplete or unrelated records and preserves ambiguous flags without granting rights', async () => {
  const purchase = { id: 51, product_id: 123, user_id: 42, is_actual: 1, is_payed: 0,
    period_type: 'limited', start_at: '2026-10-23 11:00:00', finish_at: '2027-01-23 11:00:00', state: null };
  assert.deepEqual(await client(async () => ok([purchase])).getPurchases(42), [purchase]);
  await rejectsCode(client(async () => ok([{}])).getPurchases(42), 'invalid_response');
  await rejectsCode(client(async () => ok([{ ...purchase, user_id: 43 }])).getPurchases(42), 'invalid_response');
  await rejectsCode(client(async () => ok([{ ...purchase, finish_at: undefined }])).getPurchases(42), 'invalid_response');
  await rejectsCode(client(async () => ok({})).getUserFields({ userId: 42 }), 'invalid_response');
  await rejectsCode(client(async () => ok({ id: 43 })).getUserFields({ userId: 42 }), 'invalid_response');
  await rejectsCode(client(async () => ok({ id: 42, email: 'another@example.org' })).getUserFields({ email: 'student@example.org' }), 'invalid_response');
  await rejectsCode(client(async () => ok([{}])).getTrainings(), 'invalid_response');
  assert.deepEqual(await client(async () => ok([{ id: '12', title: 'Course' }])).getUserTrainings(42), [{ id: '12', title: 'Course' }]);
});

test('bounds a hung request and never retries it', async () => {
  let calls = 0;
  let signal;
  const api = client((_url, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 10 });
  await rejectsCode(api.getTrainings(), 'timeout');
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  const aborting = client((_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('secret network details')));
  }), { timeoutMs: 10 });
  await rejectsCode(aborting.getTrainings(), 'timeout');
});

test('errors do not expose keys, email, request URL, or API body', async () => {
  const privateText = 'student@example.org developer-test school-test private-body';
  const cases = [
    client(async () => { throw new Error(privateText); }).getUserFields({ email: 'student@example.org' }),
    client(async () => { throw new GetCourseTechError(privateText); }).getTrainings(),
    client(async () => Response.json({ status: false, message: privateText, data: [] })).getTrainings(),
    client(async () => new Response(privateText, { status: 403 })).getPurchases(42),
  ];
  for (const request of cases) {
    await assert.rejects(request, error => {
      const message = String(error);
      for (const secret of ['student@example.org', 'developer-test', 'school-test', 'private-body', '/pl/api/v1']) {
        assert.equal(message.includes(secret), false);
      }
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  }
});

test('rejects non-school origins and invalid selectors before any request', async () => {
  assert.throws(() => createGetCourseTech({ ...config, schoolOrigin: 'https://other.example' }), /Invalid school origin/);
  assert.throws(() => createGetCourseTech({ ...config, schoolOrigin: 'http://legkierody.ru' }), /Invalid school origin/);
  assert.throws(() => createGetCourseTech({ ...config, schoolOrigin: 'https://legkierody.ru/other' }), /Invalid school origin/);
  assert.throws(() => createGetCourseTech({ ...config, schoolKey: 'key\nInjected: yes' }), /Invalid Tech API key/);
  const api = client(async () => { throw new Error('must not call'); });
  assert.throws(() => api.getUserFields({ userId: 1, email: 'student@example.org' }), /exactly one/);
  assert.throws(() => api.getUserFields({ email: 'invalid' }), /valid userId or email/);
  assert.throws(() => api.getPurchases(0), /positive integer/);
  assert.throws(() => api.getUserTrainings('1'), /positive integer/);
  assert.throws(() => api.getLessonStatuses('1'), /positive integer/);
});
