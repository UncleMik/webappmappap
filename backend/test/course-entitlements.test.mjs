import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCourseProducts, parseGetCourseDate } from '../course-entitlements.mjs';

const now = Date.parse('2026-10-23T12:00:00.000Z');
const iso = value => new Date(value).toISOString();
const products = [
  { productId: 10, trainingId: 100, type: 'training', accessDays: 1095 },
  { productId: 20, trainingId: 200, type: 'training', accessDays: 183 },
  { productId: 30, groupId: 300, type: 'groups', accessDays: 60 },
];
const purchase = (overrides = {}) => ({
  id: 1, product_id: 10, user_id: 42, is_actual: 1, is_payed: 0,
  state: null, period_type: 'limited',
  start_at: '2026-10-23 14:00:00', finish_at: '2026-10-23 16:00:00',
  ...overrides,
});
const check = (overrides = {}) => ({
  checkedAt: iso(now - 60_000), expiresAt: iso(now + 240_000),
  snapshot: { purchases: [purchase()], trainingIds: [100, 200] },
  ...overrides,
});

test('GetCourse naive dates use Moscow time and reject calendar rollover', () => {
  assert.equal(parseGetCourseDate('2026-10-23 15:00:00'), now);
  assert.equal(parseGetCourseDate('2024-02-29 03:00:00'), Date.parse('2024-02-29T00:00:00Z'));
  for (const value of ['2023-02-29 03:00:00', '2026-02-30 03:00:00',
    '2026-13-01 03:00:00', '2026-10-23 24:00:00', '2026-10-23 12:60:00',
    '2026-10-23 12:00:60', '2026-10-23T15:00:00', ' ', '', null, 42]) {
    assert.equal(parseGetCourseDate(value), null, String(value));
  }
});

test('explicit ISO offsets are parsed strictly', () => {
  assert.equal(parseGetCourseDate('2026-10-23T15:00:00+03:00'), now);
  assert.equal(parseGetCourseDate('2026-10-23T12:00:00.000Z'), now);
  assert.equal(parseGetCourseDate('2026-10-23T07:30:00-04:30'), now);
  assert.equal(parseGetCourseDate('2026-10-23T12:00:00.5Z'), now + 500);
  for (const value of ['2026-02-30T12:00:00Z', '2026-10-23T12:00:00+24:00',
    '2026-10-23T12:00:00+03:60', '2026-10-23T12:00:00.1234Z']) {
    assert.equal(parseGetCourseDate(value), null, value);
  }
});

test('requires this specific product purchase and listed training, without requiring is_payed', () => {
  assert.deepEqual(activeCourseProducts(products, check(), now),
    [{ productId: 10, validUntil: now + 240_000 }]);
  assert.deepEqual(activeCourseProducts(products, check({ snapshot: {
    purchases: [purchase()], trainingIds: [200],
  } }), now), []);
  assert.deepEqual(activeCourseProducts(products, check({ snapshot: {
    purchases: [], trainingIds: [100, 200],
  } }), now), []);
  assert.deepEqual(activeCourseProducts(products, check({ snapshot: {
    purchases: [purchase({ product_id: 30 })], trainingIds: [100, 200],
  } }), now), []);
});

test('limited start is inclusive and finish is exclusive; offer accessDays does not extend a purchase', () => {
  const start = parseGetCourseDate('2026-10-23 14:00:00');
  const finish = parseGetCourseDate('2026-10-23 16:00:00');
  const beforeStart = check({ checkedAt: iso(start - 60_000), expiresAt: iso(start + 240_000) });
  assert.deepEqual(activeCourseProducts(products, beforeStart, start - 1), []);
  const activeAtStart = check({ checkedAt: iso(start), expiresAt: iso(start + 300_000) });
  assert.deepEqual(activeCourseProducts(products, activeAtStart, start),
    [{ productId: 10, validUntil: start + 300_000 }]);
  const atFinish = check({ checkedAt: iso(finish - 60_000), expiresAt: iso(finish + 240_000) });
  assert.deepEqual(activeCourseProducts(products, atFinish, finish), []);
  const nearFinish = check({ checkedAt: iso(finish - 120_000), expiresAt: iso(finish + 180_000) });
  assert.deepEqual(activeCourseProducts(products, nearFinish, finish - 1),
    [{ productId: 10, validUntil: finish }]);
});

test('repeated active purchases use the latest actual finish, then cap it by cache expiry', () => {
  const purchases = [
    purchase({ id: 1, finish_at: '2026-10-23 15:01:00' }),
    purchase({ id: 2, finish_at: '2026-10-23 15:03:00' }),
    purchase({ id: 3, finish_at: '2026-10-23 14:59:00' }),
  ];
  assert.deepEqual(activeCourseProducts(products, check({ snapshot: {
    purchases, trainingIds: [100],
  } }), now), [{ productId: 10, validUntil: now + 180_000 }]);
  purchases.push(purchase({ id: 4, finish_at: '2026-10-23 16:00:00' }));
  assert.deepEqual(activeCourseProducts(products, check({ snapshot: {
    purchases, trainingIds: [100],
  } }), now), [{ productId: 10, validUntil: now + 240_000 }]);
});

test('unlimited purchases support absent bounds, but respect any present start or finish', () => {
  const unlimited = overrides => check({ snapshot: {
    purchases: [purchase({ period_type: 'unlimited', start_at: null, finish_at: '', ...overrides })],
    trainingIds: [100],
  } });
  assert.deepEqual(activeCourseProducts(products, unlimited(), now),
    [{ productId: 10, validUntil: now + 240_000 }]);
  assert.deepEqual(activeCourseProducts(products, unlimited({ finish_at: '2026-10-23 15:02:00' }), now),
    [{ productId: 10, validUntil: now + 120_000 }]);
  assert.deepEqual(activeCourseProducts(products, unlimited({ start_at: '2026-10-23 15:01:00' }), now), []);
  assert.deepEqual(activeCourseProducts(products, unlimited({ finish_at: '2026-10-23 15:00:00' }), now), []);
  assert.deepEqual(activeCourseProducts(products, unlimited({ start_at: 'invalid' }), now), []);
});

test('stale, future, oversized, or malformed verification never produces access', () => {
  for (const checked of [
    check({ checkedAt: iso(now + 1) }),
    check({ expiresAt: iso(now) }),
    check({ checkedAt: iso(now - 300_001), expiresAt: iso(now + 1) }),
    check({ checkedAt: 'not a date' }),
    check({ snapshot: { purchases: [purchase()], trainingIds: ['wrong'] } }),
    check({ snapshot: { purchases: null, trainingIds: [100] } }),
  ]) assert.deepEqual(activeCourseProducts(products, checked, now), []);
});

test('unknown state, inactive purchase, bad dates, and unknown period fail closed', () => {
  for (const overrides of [
    { is_actual: 0 }, { is_actual: '1' }, { state: 'active' },
    { state: undefined }, { id: null }, { user_id: 0 },
    { start_at: '2026-02-30 14:00:00' },
    { finish_at: 'not a date' }, { period_type: 'other' },
    { period_type: 'limited', start_at: null },
  ]) {
    const snapshot = { purchases: [purchase(overrides)], trainingIds: [100] };
    assert.deepEqual(activeCourseProducts(products, check({ snapshot }), now), [], JSON.stringify(overrides));
  }
});

test('ignores malformed and group products and never upgrades a whole offer', () => {
  const catalog = [...products, { productId: 40, trainingId: 0, type: 'training' },
    { productId: 10, trainingId: 999, type: 'training' }];
  const snapshot = { purchases: [purchase()], trainingIds: [100, 200, 999] };
  assert.deepEqual(activeCourseProducts(catalog, check({ snapshot }), now), []);
  assert.deepEqual(activeCourseProducts(products, check({ snapshot }), now),
    [{ productId: 10, validUntil: now + 240_000 }]);
});
