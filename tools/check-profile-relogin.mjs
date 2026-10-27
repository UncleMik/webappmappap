// Uses a disposable server fixture with a pre-verified challenge. Sends no email.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_MODULE_ROOT + '/package.json');
const { chromium, devices } = require('playwright');
const fixture = JSON.parse(await readFile(process.env.PROFILE_QA_LIVE, 'utf8'));
const origin = 'https://app.legkie-rody.ru';
const browsers = [], errors = [];
const directory = resolve('output/playwright/profile-edit'); await mkdir(directory, { recursive: true });
const expected = { name: 'Анна', surname: 'Проверка', birthday: '1991-04-15', city: 'Санкт-Петербург', phone: '+79991234567',
  stage: 'mother', birthDate: '2026-10-01', goals: [1, 3] };
const photo = await readFile(new URL('../backend/test/fixtures/profile-edit-noise.jpg', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function newBrowser(options) {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }); browsers.push(browser);
  const context = await browser.newContext(options);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}
async function checkUi(page) {
  await page.goto(origin + '/personal-data.html');
  await page.locator('[data-profile-name]').filter({ hasText: expected.name }).waitFor();
  for (const key of ['surname', 'city', 'phone']) assert.equal(await page.locator(`[data-profile-field=${key}]`).textContent(), expected[key]);
  assert.match(await page.locator('[data-profile-field=birthday]').textContent(), /15 апреля 1991/);
  assert.match(await page.locator('[data-account-summary]').textContent(), /1 октября 2026/);
  assert.match(await page.locator('[data-profile-goals]').textContent(), /Наладить грудное вскармливание.*Наладить сон малыша/);
  await page.waitForFunction(() => document.querySelector('[data-account-photo] img')?.naturalWidth === 512);
}
try {
  const first = await newBrowser({ viewport: { width: 390, height: 844 } });
  await first.context.addCookies([{ name: '__Host-school_session', value: fixture.token, domain: 'app.legkie-rody.ru', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  let response = await first.context.request.post(origin + '/api/auth/profile-edit', { headers: { Origin: origin }, data: { accountId: fixture.id, changes: expected, confirmMother: true } });
  assert.equal(response.status(), 200);
  response = await first.context.request.post(origin + '/api/auth/profile-photo', { headers: { Origin: origin }, data: { accountId: fixture.id, photo: photo.toString('base64') } });
  assert.equal(response.status(), 200);
  const snapshot = (await response.json()).user.profile;
  await checkUi(first.page); await first.page.reload(); await checkUi(first.page);
  const second = await newBrowser({ ...devices['Pixel 7'] });
  assert.deepEqual(await second.context.cookies(), []);
  // A normal completion request issues a new session in an entirely separate
  // browser process; only OTP verification itself is replaced by the fixture.
  response = await second.context.request.post(origin + '/api/auth/complete', { headers: { Origin: origin }, data: { challenge: fixture.challenge } });
  assert.equal(response.status(), 200);
  assert.deepEqual((await response.json()).user.profile, snapshot);
  await checkUi(second.page);
  const reread = await second.context.request.get(origin + '/api/auth/profile-photo?v=' + snapshot.photoVersion);
  assert.equal(reread.status(), 200); assert.equal(hash(await reread.body()), hash(photo));
  assert.equal((await first.context.request.get(origin + '/api/auth/profile-photo')).status(), 401);
  const old = await (await first.context.request.get(origin + '/api/auth/session')).json();
  assert.equal(old.authenticated, false); assert.equal(old.reason, 'session_replaced');
  await first.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await first.page.waitForURL(/login\.html/);
  await second.page.screenshot({ path: resolve(directory, 'live-independent-mobile-profile.png'), fullPage: true });
  // Verify another-device editing still works after the new login.
  await second.page.locator('[data-edit=city]').click(); await second.page.locator('[name=city]').fill('Казань');
  await second.page.locator('.profile-editor [type=submit]').click(); await second.page.locator('.profile-editor').waitFor({ state: 'hidden' });
  await second.page.reload(); await second.page.locator('[data-profile-field=city]').filter({ hasText: 'Казань' }).waitFor();
  await second.page.goto(origin + '/profile.html');
  await second.page.locator('[data-edit=settings]').click(); await second.page.locator('.profile-editor').waitFor({ state: 'visible' });
  const centered = await second.page.locator('.editor-close').evaluate(button => {
    const icon = button.querySelector('svg'), b = button.getBoundingClientRect(), s = icon.getBoundingClientRect();
    return Math.abs(b.x + b.width / 2 - s.x - s.width / 2) < .6 && Math.abs(b.y + b.height / 2 - s.y - s.height / 2) < .6;
  });
  assert.equal(centered, true); await second.page.locator('.editor-close').click(); await second.page.locator('.profile-editor').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ independentBrowserProcesses: 2, mobileEmulation: 'Pixel 7', profileAndPhotoPersisted: true, oldSessionRevoked: true, pageErrors: errors.length }));
} finally { for (const browser of browsers) await browser.close(); }
