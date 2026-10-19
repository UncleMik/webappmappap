import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnPage } from '../Фронт/auth-return.js';
const base = 'https://app.legkie-rody.ru/login.html';
test('return to every application section preserving its query and anchor', () => {
  for (const page of ['index', 'journey', 'ai', 'club', 'club-chat', 'profile', 'personal-data',
    'articles', 'article', 'baby', 'mom', 'courses', 'my-courses', 'video']) {
    assert.equal(returnPage(`${page}.html?week=27&id=x#details`, base),
      `https://app.legkie-rody.ru/${page}.html?week=27&id=x#details`);
  }
  assert.equal(returnPage('/journey.html?week=27&_app=old', base), 'https://app.legkie-rody.ru/journey.html?week=27');
});
test('return path never permits another origin, files, login loops, or malformed input', () => {
  for (const raw of ['https://evil.example', '//evil.example/article.html', 'javascript:alert(1)',
    '/login.html', '/onboarding.html', '/assets/private.png', '/api/auth/session', '/nested/article.html',
    '\\evil.example', '/%2e%2e/login.html', '/journey.html\n', 'https://%invalid', null]) {
    assert.equal(returnPage(raw, base), 'https://app.legkie-rody.ru/index.html', String(raw));
  }
});
