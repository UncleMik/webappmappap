// Real browser + isolated intercepted routes. No HTTP listener, production account, model or API.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { validateAnalyticsBatch } from '../backend/auth/analytics.mjs';
const require = createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const source = await readFile('Фронт/analytics.js', 'utf8');
const navigationSource = await readFile('Фронт/app-navigation.js', 'utf8');
const origin = 'https://analytics-tracker-fixture.invalid';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext();
let requests = [], fail = false, hold = false, held, navigation = false;
const errors = [];
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin);
  if (url.pathname === '/analytics.js') return route.fulfill({ contentType: 'text/javascript', body: source });
  if (url.pathname === '/app-navigation.js') return route.fulfill({ contentType: 'text/javascript', body: navigationSource });
  if (url.pathname.endsWith('.js')) return route.fulfill({contentType:'text/javascript',body:''});
  if (url.pathname === '/api/auth/analytics/events') {
    const request = route.request();
    const batch = request.postDataJSON();
    validateAnalyticsBatch(batch);
    requests.push({ account: request.headers()['x-webpril-account'], events: batch.events });
    if (hold) await new Promise(resolve => { held = resolve; });
    return route.fulfill({ status: fail ? 503 : 200, json: {} }).catch(() => {});
  }
  const nav=navigation?'<nav class="bottom-navigation">'+['index','journey','ai','club','profile'].map(name=>`<a href="${name}.html">${name}</a>`).join('')+'</nav>':'';
  return route.fulfill({ contentType: 'text/html', body: `<!doctype html><div class="app" data-initial-section="index.html"><div id="reader" style="height:100px;overflow:auto"><div style="height:1000px">Synthetic content</div></div><video style="height:50px"></video></div>${nav}<script>window.webprilSessionAccountId='account-a';window.webprilAccount={user:{id:'account-a',profile:{completedAt:'fixture'}}};</script><script src="/analytics.js"></script>${navigation?'<script src="/app-navigation.js?v=fixture"></script>':''}` });
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
await page.clock.install({time:new Date('2026-11-14T00:00:00Z')});
await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'));
const settle = async () => { await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve))); await new Promise(resolve => setTimeout(resolve, 30)); };
const advance = async ms => { while (ms > 0) { const slice=Math.min(15000,ms);await page.clock.runFor(slice);await settle();ms-=slice; } };
const events = () => requests.flatMap(request => request.events);
const active = () => events().filter(event => event.type === 'active_time').reduce((sum, event) => sum + event.activeMs, 0);
const hide = hidden => page.evaluate(hidden => { document.querySelector('.app').hidden = hidden; }, hidden).then(settle);
try {
  await page.goto(origin + '/index.html?email=PRIVATE_SENTINEL');
  await advance(90000);
  assert.ok(active() >= 59000 && active() <= 60000, 'idle stops after 60 seconds');
  const idleTime = active();
  assert.equal(events().filter(event => event.type === 'active_time').length, 1, 'one time event per active minute');
  await page.evaluate(() => document.dispatchEvent(new Event('pointerdown')));
  await advance(7000); await hide(true);
  assert.ok(active() - idleTime >= 6900 && active() - idleTime <= 7100, 'hiding flushes actual partial time');
  const partialTime = active();
  await advance(60000);
  assert.equal(active(), partialTime, 'hidden initial shell receives no time');
  await hide(false);
  await page.evaluate(() => {
    webprilAnalytics.trackArticle(document.querySelector('#reader'), 'trusted-article');
    document.querySelector('#reader').scrollTop = 900;
    document.querySelector('#reader').dispatchEvent(new Event('scroll'));
    webprilAnalytics.track('action', { action: 'favorite_add', resourceType: 'article', resourceId: 'trusted-article', title: 'PRIVATE_SENTINEL', text: 'PRIVATE_SENTINEL' });
  });
  await advance(15000); await hide(true);
  assert.ok(events().some(event => event.type === 'content_open' && event.resourceId === 'trusted-article'));
  const articleVisit=events().find(event=>event.type==='content_open'&&event.resourceId==='trusted-article').visitId;
  assert.equal(events().filter(event=>event.type==='page_view'&&event.visitId===articleVisit).length,1,'first trusted resource does not duplicate initial view');
  assert.ok(events().some(event => event.type === 'article_progress' && event.progress === 100));
  const before = events().length;
  await page.evaluate(() => { document.querySelector('.app').hidden = false; window.dispatchEvent(new Event('webpril:session-ended')); webprilAnalytics.track('action', { action: 'points_open' }); });
  await advance(60000);
  assert.equal(events().length, before, 'ended session has no new events');

  // Account swap cancels in-flight work and clears prior material identity.
  await page.goto(origin + '/article.html'); await advance(1000);
  await page.evaluate(() => webprilAnalytics.trackArticle(document.querySelector('#reader'), 'account-a-only'));
  hold = true;
  await advance(30000);
  assert.ok(held, 'request held for account cancellation');
  await page.evaluate(() => { webprilSessionAccountId='account-b';webprilAccount={user:{id:'account-b',profile:{completedAt:'fixture'}}};dispatchEvent(new Event('account:change')); });
  hold = false; held(); await settle();
  await advance(30000);
  assert.ok(requests.some(request => request.account === 'account-b'));
  assert.ok(requests.filter(request => request.account === 'account-b').every(request => request.events.every(event => event.resourceId !== 'account-a-only')));

  // Same-origin preserved iframe: its document is visible even when its frame is hidden.
  await page.goto(origin + '/index.html');
  await page.evaluate(origin => { const frame=document.createElement('iframe');frame.id='panel';frame.hidden=true;frame.src=origin+'/ai.html';document.body.append(frame); }, origin);
  await page.waitForFunction(() => document.querySelector('#panel').contentWindow.webprilAnalytics);
  const count = () => events().filter(event => event.page === 'ai.html').length;
  await advance(30000); assert.equal(count(), 0, 'hidden frame emits no page view');
  await page.evaluate(() => { document.querySelector('.app').hidden=true;document.querySelector('#panel').hidden=false; });
  await settle(); await advance(30000);
  assert.ok(count() >= 2, 'visible frame creates page view + AI open');
  const ai = page.frames().find(frame => frame.url().endsWith('/ai.html'));
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>!!window.fixtureHidden});window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange')); });
  await settle();const hiddenParentCount=count();await advance(45000);assert.equal(count(),hiddenParentCount,'parent document hides visible child frame');
  await page.evaluate(() => { window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange')); });await settle();
  await ai.evaluate(() => {
    webprilAnalytics.track('ai_request', { format:'file',outcome:'accepted',text:'PRIVATE_SENTINEL' });
    webprilAnalytics.track('ai_result', { format:'file',outcome:'completed' });
    webprilAnalytics.track('error', { action:'ai_limit',format:'text',outcome:'limit' });
  });
  await page.evaluate(() => { document.querySelector('#panel').hidden=true; }); await settle();
  assert.ok(events().some(event => event.type==='ai_request' && event.format==='file'));
  const aiCount=count();await advance(60000);assert.equal(count(),aiCount,'hidden preserved AI frame remains idle');

  // Real video element with synthetic media clock; seek/background never fabricate watching.
  await page.goto(origin + '/video.html');
  await page.evaluate(() => {
    const video=document.querySelector('video');window.fixtureMedia={time:0,paused:false,ended:false,seeking:false};
    for(const key of ['paused','ended','seeking'])Object.defineProperty(video,key,{get:()=>fixtureMedia[key]});
    Object.defineProperty(video,'duration',{get:()=>100});Object.defineProperty(video,'currentTime',{get:()=>fixtureMedia.time});
    webprilAnalytics.trackVideo(video,'trusted-video');video.dispatchEvent(new Event('playing'));
  });
  for (let i=1;i<=50;i++) { await advance(1000);await page.evaluate(i=>{fixtureMedia.time=i;document.querySelector('video').dispatchEvent(new Event('timeupdate'));},i); }
  await page.evaluate(() => { fixtureMedia.time=99;document.querySelector('video').dispatchEvent(new Event('timeupdate')); });
  await advance(30000);
  assert.ok(events().some(event=>event.type==='video_start'&&event.resourceId==='trusted-video'));
  assert.ok(events().some(event=>event.type==='video_progress'&&event.progress===50));
  assert.ok(!events().some(event=>event.type==='video_completed'), 'seek does not complete video');
  await page.evaluate(()=>{fixtureMedia.time=50;document.querySelector('video').dispatchEvent(new Event('timeupdate'));});
  for(let i=51;i<=100;i++){await advance(1000);await page.evaluate(i=>{fixtureMedia.time=i;document.querySelector('video').dispatchEvent(new Event('timeupdate'));},i);}
  await page.evaluate(()=>{fixtureMedia.ended=true;fixtureMedia.paused=true;document.querySelector('video').dispatchEvent(new Event('ended'));});
  await hide(true); const videoTime=active(); await advance(60000);assert.equal(active(),videoTime,'playing hidden video receives no active time');
  assert.ok(events().some(event=>event.type==='video_completed'&&event.resourceId==='trusted-video'),'actual observed playback can complete');
  const videoActive=events().filter(event=>event.page==='video.html'&&event.type==='active_time').reduce((sum,event)=>sum+event.activeMs,0);
  assert.ok(videoActive>=129000&&videoActive<=131000,'visible video remains active past idle and uneven samples retain all 130 seconds');

  await page.goto(origin+'/my-courses.html');
  await page.evaluate(()=>{webprilAnalytics.setResource('course','4302509');webprilAnalytics.track('action',{action:'NOT_ALLOWED',title:'PRIVATE_SENTINEL'});});
  await advance(7000);
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await settle();
  const beforeCache=events().length;await advance(45000);assert.equal(events().length,beforeCache,'bfcache suspension records no time');
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await advance(30000);
  assert.equal(events().filter(event=>event.type==='content_open'&&event.resourceType==='course').length,2,'bfcache restoration starts fresh visible visit');

  // Retry the original IDs after a transport failure; no recursive analytics error events.
  fail=true;await page.goto(origin+'/profile.html');await advance(30000);
  const failed=requests.at(-1);fail=false;await advance(30000);
  const retry=requests.at(-1);assert.equal(retry.events[0].eventId,failed.events[0].eventId);
  navigation=true;await page.goto(origin+'/index.html');
  for(const file of ['journey.html','ai.html','index.html']) {
    await page.locator(`body > .bottom-navigation a[href="${file}"]`).click();
    await page.waitForURL(url=>url.pathname.endsWith('/'+file));await settle();
  }
  await advance(30000);
  assert.deepEqual(events().filter(event=>event.type==='transition').map(event=>[event.fromPage,event.page]),[
    ['index.html','journey.html'],['journey.html','ai.html'],['ai.html','index.html']
  ],'real persistent iframe navigation records each actual transition once');
  const serialized=JSON.stringify(requests);assert.ok(!serialized.includes('PRIVATE_SENTINEL'));
  assert.ok(requests.every(request=>request.events.length<=30));
  assert.ok(events().every(event=>event.activeMs===undefined||event.activeMs>=1&&event.activeMs<=60000));
  assert.deepEqual(errors,[]);
  console.log('PASS browser tracker: visibility/root/iframe, idle/partial time, account cancellation/isolation, end, article, native media seek, AI allowlist, bounded retry IDs/privacy');
} finally { held?.();await browser.close(); }
