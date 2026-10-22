import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../database.mjs';
import { createArticleServer } from '../server.mjs';
import { importCourseOffers, readCourseOffers } from '../course-catalog.mjs';

const source = JSON.parse(readFileSync(new URL('../../docs/content/getcourse-offers-2026-10-22.json', import.meta.url), 'utf8'));

test('course snapshot imports idempotently, retains existing content, and rolls back failures', () => {
  const db = openDatabase(':memory:', false);
  try {
    db.prepare("INSERT INTO articles(id,number,week,title,minutes,blocks) VALUES('pregnancy-001',1,1,'Existing article',1,'[]')").run();
    db.prepare("INSERT INTO weekly_content(kind,week,data) VALUES('mom',1,'{\"title\":\"Existing\"}')").run();
    assert.equal(readCourseOffers(db), null);
    assert.deepEqual(importCourseOffers(db, source), { offers: 3, products: 30, items: 36 });
    const first = readCourseOffers(db);
    assert.deepEqual(first.offers.map(offer => [offer.offerId, offer.displayName, offer.price, offer.items.length]), [
      [8835218, 'Экспресс', 2800, 6],
      [8835266, 'Все включено', 4680, 6],
      [8835331, 'ПРОФИ', 7490, 24],
    ]);
    assert.deepEqual(first.offers.map(offer => [...new Set(offer.items.map(item => item.accessDays))].sort((a, b) => a - b)), [[183], [60, 365], [60, 1095]]);
    assert.equal(first.offers[1].items.find(item => item.productId === 3317400).type, 'groups');
    assert.equal(first.offers[2].items.find(item => item.productId === 3317398).type, 'groups');
    assert.deepEqual(importCourseOffers(db, source), { offers: 3, products: 30, items: 36 });
    assert.deepEqual(readCourseOffers(db), first);
    const bad = structuredClone(source);
    bad.offers[0].items[0].productId = 99999999;
    assert.throws(() => importCourseOffers(db, bad), /Invalid item/);
    assert.deepEqual(readCourseOffers(db), first);
    const changed = structuredClone(source);
    changed.offers[0].price = 2900;
    db.exec("CREATE TRIGGER fail_course_insert BEFORE INSERT ON course_offer_items BEGIN SELECT RAISE(ABORT, 'simulated import failure'); END");
    assert.throws(() => importCourseOffers(db, changed), /simulated import failure/);
    assert.deepEqual(readCourseOffers(db), first);
    assert.equal(db.prepare('SELECT title FROM articles WHERE id=?').get('pregnancy-001').title, 'Existing article');
    assert.equal(db.prepare("SELECT data FROM weekly_content WHERE kind='mom' AND week=1").get().data, '{"title":"Existing"}');
  } finally { db.close(); }
});

test('course import rejects duplicate IDs, bad commercial values, and dangling product references', () => {
  const db = openDatabase(':memory:', false);
  try {
    const cases = [
      draft => { draft.products.push(structuredClone(draft.products[0])); },
      draft => { draft.offers.push(structuredClone(draft.offers[0])); },
      draft => { draft.currency = 'USD'; },
      draft => { draft.offers[0].price = -1; },
      draft => { draft.offers[0].items.push(structuredClone(draft.offers[0].items[0])); },
      draft => { draft.offers[0].items[0].productId = 99999999; },
      draft => { draft.offers[0].items[0].accessDays = 0; },
    ];
    for (const change of cases) {
      const draft = structuredClone(source);
      change(draft);
      assert.throws(() => importCourseOffers(db, draft));
      assert.equal(readCourseOffers(db), null);
    }
  } finally { db.close(); }
});

test('course API serves only sale metadata, supports HEAD, and fails closed before import', async () => {
  const db = openDatabase(':memory:', false);
  const server = createArticleServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/course-offers`;
  try {
    const missing = await fetch(url);
    assert.equal(missing.status, 503);
    assert.deepEqual(await missing.json(), { error: 'courses_unavailable' });
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    importCourseOffers(db, source);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.offers.map(offer => offer.items.length), [6, 6, 24]);
    assert.deepEqual(Object.keys(body), ['offers']);
    assert.deepEqual(Object.keys(body.offers[0]), ['offerId', 'displayName', 'price', 'currency', 'items']);
    assert.deepEqual(Object.keys(body.offers[0].items[0]), ['productId', 'title', 'type', 'accessDays']);
    assert.equal(body.offers.every(offer => offer.currency === 'RUB'), true);
    assert.doesNotMatch(JSON.stringify(body), /https?:|trainingId|groupId|media|secret|admin|url|key/i);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('etag'), response.headers.get('etag'));
    assert.equal((await fetch(`${url}?productId=4309095`)).status, 400);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
