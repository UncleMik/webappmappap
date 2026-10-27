// Browser scenario without a local preview server. Set PROFILE_QA_LIVE to a
// private JSON fixture {id,token} to run against a disposable server account.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { normalizeProfileEdit } from '../backend/auth/profile.mjs';
const require = createRequire(process.env.PLAYWRIGHT_MODULE_ROOT + '/package.json');
const { chromium } = require('playwright');
const live = process.env.PROFILE_QA_LIVE ? JSON.parse(await readFile(process.env.PROFILE_QA_LIVE, 'utf8')) : null;
const origin = 'https://app.legkie-rody.ru';
const directory = resolve('output/playwright/profile-edit'); await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const errors = []; let forceFail = false, photoData;
let user = { id: '11111111-1111-4111-8111-111111111111', email: 'qa-profile@example.invalid', profile: {
  name: 'Анна', stage: 'pregnancy', dueDate: '2027-02-01', goals: [0], method: 'due', completedAt: '2026-10-27T12:00:00Z',
} };
if (live) await context.addCookies([{ name: '__Host-school_session', value: live.token, domain: 'app.legkie-rody.ru', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
else await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (url.pathname.startsWith('/api/auth/')) {
    if (url.pathname.endsWith('/session')) return json({ authenticated: true, user });
    if (url.pathname.endsWith('/profile-edit')) {
      const data = route.request().postDataJSON();
      if (forceFail) return json({ error: 'unavailable', message: 'Проверка ошибки сохранения.' }, 503);
      try { user.profile = normalizeProfileEdit(user.profile, data.changes, data.confirmMother); return json({ authenticated: true, user }); }
      catch (error) { return json({ error: error.code, message: error.message }, error.status || 400); }
    }
    if (url.pathname.endsWith('/profile-photo')) {
      if (route.request().method() === 'POST') {
        photoData = route.request().postDataJSON().photo;
        if (photoData) user.profile.photoVersion = crypto.randomUUID(); else delete user.profile.photoVersion;
        return json({ authenticated: true, user });
      }
      return photoData ? route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(photoData, 'base64') }) : json({}, 404);
    }
    return json({});
  }
  if (url.pathname.startsWith('/api/')) return json({ articles: [], weeks: [] });
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = resolve('Фронт', '.' + pathname);
  if (!file.startsWith(resolve('Фронт') + '\\')) return route.abort();
  try {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.woff': 'font/woff' };
    await route.fulfill({ contentType: types[extname(file)] || 'application/octet-stream', body: await readFile(file) });
  } catch { await route.fulfill({ status: 404, body: '' }); }
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
async function checkClose() {
  const geometry = await page.locator('.profile-editor .editor-close').evaluate(button => {
    const icon = button.querySelector('svg'), b = button.getBoundingClientRect(), s = icon.getBoundingClientRect();
    return { common: button.classList.contains('close-button') && icon.classList.contains('close-icon'),
      dx: Math.abs(b.x + b.width / 2 - s.x - s.width / 2), dy: Math.abs(b.y + b.height / 2 - s.y - s.height / 2), width: s.width, height: s.height };
  });
  assert.equal(geometry.common, true); assert.ok(geometry.dx < .6 && geometry.dy < .6, JSON.stringify(geometry));
  assert.equal(geometry.width, 22); assert.equal(geometry.height, 22);
}
const open = async kind => {
  await page.locator(`[data-edit="${kind}"]`).first().click();
  await page.locator('.profile-editor').waitFor({ state: 'visible' });
  await checkClose();
};
const save = async () => { await page.locator('.profile-editor [type=submit]').click(); await page.locator('.profile-editor').waitFor({ state: 'hidden' }); };
const cancel = async () => { await page.locator('.profile-editor [data-cancel]').click(); await page.locator('.profile-editor').waitFor({ state: 'hidden' }); };
const session = () => page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).user);
let checks = 0;
try {
  await page.goto(origin + '/personal-data.html');
  await page.locator('[data-profile-name]').filter({ hasText: 'Анна' }).waitFor();
  for (const [key, value] of Object.entries({ name: 'Мария', surname: 'Петрова', birthday: '1992-02-29', city: 'Казань', phone: '+79991234567' })) {
    await open(key); await page.locator(`[name=${key}]`).fill(value); await save();
    assert.equal((await session()).profile[key], value); checks++;
  }
  await open('name'); await page.locator('[name=name]').fill('Не сохранять'); await cancel();
  assert.equal((await session()).profile.name, 'Мария'); checks++;
  await open('city'); await page.locator('[name=city]').fill(''); await save();
  assert.equal((await session()).profile.city, ''); checks++;
  await open('phone'); await page.locator('[name=phone]').fill('123');
  await page.locator('.profile-editor [type=submit]').click();
  await page.locator('.editor-error:not([hidden])').waitFor();
  assert.equal(await page.locator('[name=phone]').inputValue(), '123'); checks++;
  await cancel();
  if (!live) {
    forceFail = true; await open('surname'); await page.locator('[name=surname]').fill('Черновик');
    await page.locator('.profile-editor [type=submit]').click(); await page.locator('.editor-error:not([hidden])').waitFor();
    assert.equal(await page.locator('[name=surname]').inputValue(), 'Черновик'); forceFail = false; await cancel(); checks++;
  }
  await open('stage');
  await page.locator('[name=method]').selectOption('conception'); await page.locator('[name=conception]').fill('2026-08-01'); await save();
  assert.equal((await session()).profile.dueDate, '2027-04-24'); checks++;
  await open('stage');
  await page.locator('[name=method]').selectOption('weeks'); await page.locator('[name=weeks]').fill('20'); await page.locator('[name=days]').fill('3');
  await save(); const due = (await session()).profile.dueDate; assert.ok(due); checks++;
  await open('stage'); await page.locator('[name=stage]').selectOption('mother');
  await page.locator('[name=birthDate]').fill('2026-10-01');
  await page.locator('[name=goal]').first().check();
  await page.locator('.profile-editor [type=submit]').click();
  assert.equal((await session()).profile.stage, 'pregnancy'); checks++;
  await page.locator('[name=confirmMother]').check();
  await page.screenshot({ path: resolve(directory, live ? 'live-stage.png' : 'stage.png') });
  await save(); assert.equal((await session()).profile.stage, 'mother'); checks++;
  await open('goals'); await page.locator('[name=goal]').nth(2).check(); await save();
  assert.deepEqual((await session()).profile.goals, [0, 2]); checks++;
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 700;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#794aff'; ctx.fillRect(0, 0, 700, 700);
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(350, 350, 200, 0, 2 * Math.PI); ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  for (let i = 0; i < 2; i++) {
    await open('photo'); await page.locator('[name=photo]').setInputFiles({ name: 'qa.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.waitForFunction(() => !document.querySelector('.profile-editor [type=submit]').disabled);
    await save(); assert.ok((await session()).profile.photoVersion); checks++;
  }
  await page.reload(); await page.locator('[data-profile-name]').filter({ hasText: 'Мария' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-account-photo] img')?.naturalWidth > 0); checks++;
  for (const [width, height] of [[320, 740], [375, 812], [390, 844], [844, 390], [1440, 900]]) {
    await page.setViewportSize({ width, height }); await open('name');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('.profile-editor').evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: resolve(directory, `${live ? 'live-' : ''}edit-${width}.png`) });
    await cancel(); checks++;
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open('photo'); await page.locator('[data-remove-photo]').click(); await save();
  assert.ok(!(await session()).profile.photoVersion); checks++;
  await open('email'); assert.match(await page.locator('.editor-body').textContent(), /поддержку/); await cancel(); checks++;
  await page.goto(origin + '/profile.html'); await page.locator('[data-account-name]').filter({ hasText: 'Мария' }).waitFor();
  await open('settings'); assert.match(await page.locator('.editor-body').textContent(), /Москва \(UTC\+3\)/);
  await page.screenshot({ path: resolve(directory, live ? 'live-settings.png' : 'settings.png') });
  await page.locator('[data-settings-goals]').click();
  await page.locator('#profile-editor-title').filter({ hasText: 'Цели и интересы' }).waitFor(); await cancel(); checks++;
  // An already opened profile on another tab must reflect a save immediately.
  const other = await context.newPage(); await other.goto(origin + '/personal-data.html');
  await other.locator('[data-edit=name]').click(); await other.locator('[name=name]').fill('Анна');
  await other.locator('.profile-editor [type=submit]').click();
  await page.locator('[data-account-name]').filter({ hasText: 'Анна' }).waitFor(); await other.close(); checks++;
  if (!live) {
    await page.goto(origin + '/personal-data.html'); await open('photo');
    await page.evaluate(() => {
      const original = window.createImageBitmap;
      window.createImageBitmap = async (...args) => { const bitmap = await original(...args); await new Promise(resolve => { window.finishQaBitmap = resolve; }); return bitmap; };
    });
    await page.locator('[name=photo]').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.waitForFunction(() => typeof window.finishQaBitmap === 'function');
    await page.evaluate(() => window.dispatchEvent(new Event('webpril:session-ended')));
    await page.locator('.profile-editor').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.finishQaBitmap()); await page.waitForTimeout(100); checks++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ mode: live ? 'live' : 'isolated-routes', checks, pageErrors: errors.length }));
} finally { await browser.close(); }
