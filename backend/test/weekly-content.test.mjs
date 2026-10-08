import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.mjs';
import { importWeeklyContent } from '../import-weekly-content.mjs';
import { createArticleServer } from '../server.mjs';

const source = new URL('../seed/weekly-content.json', import.meta.url);
const content = JSON.parse(readFileSync(source, 'utf8'));
const uploads = mkdtempSync(join(tmpdir(), 'weekly-content-test-'));
const bytes = Buffer.from('Deterministic image fixture for the importer');
const hash = createHash('sha256').update(bytes).digest('hex');
const image = `/uploads/weekly/${hash}.webp`;
mkdirSync(join(uploads, 'weekly'));
writeFileSync(join(uploads, 'weekly', `${hash}.webp`), bytes);
for (const entry of Object.values(content.baby)) {
  entry.illustration = image;
  if (entry.comparisonImage) entry.comparisonImage = image;
}
after(() => rmSync(uploads, { recursive: true, force: true }));

test('Weekly content imports all 42 weeks and API returns exact public data', async () => {
  const db = openDatabase(':memory:', false);
  assert.deepEqual(importWeeklyContent(db, content, uploads), { baby: 42, mom: 42, calendar: 42, calendarNotes: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM weekly_content').get().count, 129);
  const server = createArticleServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/weekly-content`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), content);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://unclemik.github.io');
    assert.equal((await fetch(`${base}/api/weekly-content`, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(`${base}/api/weekly-content`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/weekly-content`, { method: 'HEAD' })).status, 200);

    db.prepare("UPDATE weekly_content SET status='draft' WHERE kind='baby' AND week=1").run();
    db.prepare("UPDATE weekly_content SET access='restricted' WHERE kind='mom' AND week=2").run();
    const filtered = await (await fetch(`${base}/api/weekly-content`)).json();
    assert.equal(filtered.baby[1], undefined);
    assert.equal(filtered.mom[2], undefined);
    assert.deepEqual(filtered.calendar, content.calendar);
    assert.deepEqual(filtered.calendarNotes, content.calendarNotes);
    importWeeklyContent(db, content, uploads);
    assert.equal(db.prepare("SELECT status FROM weekly_content WHERE kind='baby' AND week=1").get().status, 'draft');
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('Invalid weeks and images are rejected; a failed import rolls back all changes', () => {
  const db = openDatabase(':memory:', false);
  try {
    importWeeklyContent(db, content, uploads);
    const before = db.prepare("SELECT data FROM weekly_content WHERE kind='baby' AND week=1").get().data;
    const invalidWeek = structuredClone(content);
    invalidWeek.baby[43] = invalidWeek.baby[42];
    assert.throws(() => importWeeklyContent(db, invalidWeek, uploads), /Expected weeks/);
    const invalidImage = structuredClone(content);
    invalidImage.baby[1].illustration = '/uploads/weekly/absent.webp';
    assert.throws(() => importWeeklyContent(db, invalidImage, uploads), /Missing or invalid/);
    assert.equal(db.prepare("SELECT data FROM weekly_content WHERE kind='baby' AND week=1").get().data, before);

    db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON weekly_content WHEN NEW.kind='mom' AND NEW.week=2 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const changed = structuredClone(content);
    changed.baby[1].description = 'Changed value';
    assert.throws(() => importWeeklyContent(db, changed, uploads), /simulated failure/);
    assert.equal(db.prepare("SELECT data FROM weekly_content WHERE kind='baby' AND week=1").get().data, before);
  } finally { db.close(); }
});
