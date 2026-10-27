import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseVideoTopic } from '../Фронт/course-video-topics.js';
const video = text => ({ type: 'video', text });

test('a source heading before an uncaptioned video supplies its topic', () => {
  assert.equal(courseVideoTopic([{ type: 'text', text: 'Первый триместр' }, video('')], 1, 'Триместры беременности'), 'Первый триместр');
});
test('explicit video captions take precedence without appending a video number', () => {
  assert.equal(courseVideoTopic([{ type: 'text', text: 'Предыдущая подпись' }, video('Дыхание')], 1, 'Урок'), 'Дыхание');
});
test('player labels and missing headings use the actual lesson title', () => {
  assert.equal(courseVideoTopic([{ type: 'text', text: 'Плеер №2 Youtube' }, video('')], 1, 'Йога для беременных'), 'Йога для беременных');
  assert.equal(courseVideoTopic([video('Видео 2')], 0, 'Подготовка к родам'), 'Подготовка к родам');
});
test('descriptive paragraphs and previous video headings do not become topics', () => {
  assert.equal(courseVideoTopic([{ type: 'text', text: 'Описание\n\nПодробности' }, video('')], 1, 'Урок'), 'Урок');
  assert.equal(courseVideoTopic([{ type: 'text', text: 'Первая тема' }, video(''), video('')], 2, 'Урок'), 'Урок');
});
