import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../Фронт/school-video-routes.js', import.meta.url), 'utf8');
const { resolveSchoolVideo, schoolVideoRoutes, schoolVideoReturn } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const course = (productId, lessonId) => ({ course: { productId, sections: [{ streamId: 123,
  lessons: [{ lessonId, hasVideo: true }] }] } });

test('lessons return to supported entry screens and keep a valid journey week', () => {
  const targets = {
    index: 'index.html', 'index-breathing': 'index.html', mom: 'mom.html#mom-tools-title',
    baby: 'baby.html', journey: 'journey.html?week=12#videos-title', 'my-courses': 'my-courses.html',
    club: 'club.html#events', articles: 'articles.html', favorites: 'favorites.html',
  };
  for (const [from, href] of Object.entries(targets)) {
    assert.equal(schoolVideoReturn(new URLSearchParams({ from, week: '12' })).href, href);
  }
  assert.equal(schoolVideoReturn(new URLSearchParams('from=index-breathing')).tab, null);
  assert.equal(schoolVideoReturn(new URLSearchParams('from=journey&week=43')).href, 'journey.html');
  for (const from of ['course', '__proto__', 'https://example.test']) {
    assert.equal(schoolVideoReturn(new URLSearchParams({ from })), null);
  }
});

test('each matched topic opens the exact purchased lesson, with both course versions supported', async () => {
  // Product provenance checked against the live private inventory on 27 October.
  const candidates = [[347472590,4302509,4302552],[347529530,4309095],
    [347472707,4302509],[347531402,4309095],[347472356,4302509],[347529855,4309095],
    [347472656,4302509],[347472380,4302509],[347529451,4309095],
    [347472434,4302509],[347529601,4309095,4307012],[347472363,4302509],
    [347529862,4309095],[348997994,4302509]];
  for (const [id, route] of Object.entries(schoolVideoRoutes)) {
    if (id === 'breathing') continue;
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
  for (const id of Object.keys(schoolVideoRoutes).filter(id => id !== 'breathing')) {
    const result = await resolveSchoolVideo(id, async () => ({ courses: [] }));
    assert.ok(['locked', 'missing'].includes(result.state));
    assert.equal(result.href, undefined);
  }
});

test('breathing opens the free lesson without requesting purchased courses', async () => {
  const result = await resolveSchoolVideo('breathing', () => { throw new Error('purchase check must not run'); });
  assert.equal(result.href, 'article.html?courseLesson=347472707&course=4302509');
});

test('paid topics keep failed access checks closed', async () => {
  for (const status of [401, 503]) await assert.rejects(resolveSchoolVideo('back-practice', async () => {
    throw Object.assign(new Error('failed'), { status });
  }), { status });
});

test('missing and unknown topics never fall back to an unrelated video', async () => {
  for (const id of ['practice-article', 'unknown', null, '__proto__']) {
    assert.equal((await resolveSchoolVideo(id, () => { throw new Error('must not request'); })).state, 'missing');
  }
});
