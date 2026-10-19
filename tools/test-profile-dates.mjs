import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pregnancyDate, profileTiming, todayDate, isoDate, parseDate, returnPage } from '../Фронт/profile-dates.js';
import { normalizeProfile } from '../backend/auth/profile.mjs';

test('browser and server agree on all three date methods across the Moscow day boundary', () => {
  for (const now of [Date.parse('2026-10-19T20:59:59Z'), Date.parse('2026-10-19T21:00:00Z')]) {
    for (const fields of [{method:'weeks',weeks:'18',days:'4'}, {method:'due',due:'2027-01-01'}, {method:'conception',conception:'2026-08-01'}]) {
      const form = {name:'Анна',stage:'pregnancy',goals:[1],...fields};
      assert.equal(isoDate(pregnancyDate(form,now).due),normalizeProfile(form,now).dueDate);
    }
  }
  assert.equal(isoDate(todayDate(Date.parse('2026-10-19T21:00:00Z'))),'2026-10-20');
});
test('invalid dates stay invalid, pregnancy stays pregnancy after the due date', () => {
  assert.ok(Number.isNaN(parseDate('2026-02-30')));
  assert.equal(pregnancyDate({method:'weeks',weeks:'',days:'0'}),null);
  const info=profileTiming({completedAt:'2026-10-01T00:00:00Z',stage:'pregnancy',dueDate:'2026-10-18'},Date.parse('2026-10-19T12:00:00Z'));
  assert.equal(info.week,40);
  assert.equal(info.birthDate,undefined);
});
test('only approved internal lessons can be restored after registration', () => {
  const base='https://app.legkie-rody.ru/login.html';
  for (const next of ['https://evil.example','//evil.example','video.html?id=other&from=journey','video.html?id=contractions-lesson&from=other']) {
    assert.equal(returnPage(next,base),'https://app.legkie-rody.ru/index.html');
  }
  assert.equal(returnPage('video.html?id=contractions-lesson&from=journey&week=18',base),'https://app.legkie-rody.ru/video.html?id=contractions-lesson&from=journey&week=18');
});
