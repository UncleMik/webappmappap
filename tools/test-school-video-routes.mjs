import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../Фронт/school-video-routes.js', import.meta.url), 'utf8');
const { resolveSchoolVideo, schoolVideoRoutes } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const course = (productId, lessonId) => ({ course: { productId, sections: [{ streamId: 123,
  lessons: [{ lessonId, hasVideo: true }] }] } });

test('each matched topic opens the exact purchased lesson, with both course versions supported', async () => {
  // Product provenance checked against the live private inventory on 27 October.
  const candidates = [[347472590,4302509,4302552],[347529530,4309095],
    [347472707,4302509],[347531402,4309095],[347472356,4302509],[347529855,4309095],
    [347472656,4302509],[347472380,4302509],[347529451,4309095],
    [347472434,4302509],[347529601,4309095,4307012],[347472363,4302509],
    [347529862,4309095],[348997994,4302509]];
  for (const [id, route] of Object.entries(schoolVideoRoutes)) {
    for (const lessonId of route.lessons) {
      const candidate = candidates.find(row => row[0] === lessonId);
      assert.ok(candidate);
      for (const productId of candidate.slice(1)) {
        const result = await resolveSchoolVideo(id, async path => path === '/api/auth/courses'
          ? { courses: [{ productId }] } : course(productId, lessonId));
        assert.equal(result.state, 'available');
        assert.equal(result.href, `article.html?courseLesson=${lessonId}&course=${productId}&section=123`);
      }
    }
  }
});

test('unpaid user gets no lesson or video URL', async () => {
  for (const id of Object.keys(schoolVideoRoutes)) {
    const result = await resolveSchoolVideo(id, async () => ({ courses: [] }));
    assert.ok(['locked', 'missing'].includes(result.state));
    assert.equal(result.href, undefined);
  }
});

test('a purchase without an opened lesson cannot resolve a destination', async () => {
  assert.equal((await resolveSchoolVideo('breathing', async path => path === '/api/auth/courses'
    ? { courses: [{ productId: 4302509 }] } : { course: { productId: 4302509, sections: [] } })).state, 'locked');
});

test('a denied full course can fall back to the purchased express version', async () => {
  const result = await resolveSchoolVideo('breathing', async path => {
    if (path === '/api/auth/courses') return { courses: [{ productId: 4302509 }, { productId: 4309095 }] };
    if (path.endsWith('/4302509')) throw Object.assign(new Error('denied'), { status: 403 });
    return course(4309095, 347531402);
  });
  assert.match(result.href, /courseLesson=347531402&course=4309095/);
});

test('failed access checks do not choose a lesson', async () => {
  for (const status of [401, 503]) await assert.rejects(resolveSchoolVideo('breathing', async () => {
    throw Object.assign(new Error('failed'), { status });
  }), { status });
});

test('missing and unknown topics never fall back to an unrelated video', async () => {
  for (const id of ['practice-article', 'unknown', null, '__proto__']) {
    assert.equal((await resolveSchoolVideo(id, () => { throw new Error('must not request'); })).state, 'missing');
  }
});
