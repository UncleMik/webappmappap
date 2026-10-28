import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseVideoDescription as describe } from '../Фронт/course-video-description.js';
const video = { type: 'video', text: '', videos: [] };
const text = value => ({ type: 'text', text: value });
const preview = (blocks, blockIndex = 0, extra = {}) => describe({ blocks, blockIndex, title: 'Первый триместр', lessonTitle: 'Триместры беременности', ...extra });

test('chapters take precedence and belong to the selected video', () => {
  const result = preview([video], 0, { chapters: [{ label: 'Подтверждение беременности' }, { label: 'Первый скрининг' }] });
  assert.match(result, /Подтверждение беременности; Первый скрининг/);
  assert.equal(result.split(/(?<=[.!?])\s+/u).length, 2);
});
test('source prose supplies at most two complete sentences', () => {
  const result = preview([video, text('В этом уроке обсуждаются изменения в первом триместре. Отдельная часть посвящена обследованиям во время беременности. Третье предложение остаётся в полном тексте.')]);
  assert.match(result, /Отдельная часть/);
  assert.doesNotMatch(result, /Третье предложение/);
});
test('a neighbouring video does not donate its description', () => {
  const blocks = [video, text('Первый триместр'), video, text('В этой записи обсуждаются обследования второго триместра беременности.')];
  assert.doesNotMatch(preview(blocks), /второго триместра/);
});
test('service messages, downloads and URLs do not become descriptions', () => {
  for (const value of ['Можете выбрать наиболее удобный сервис для просмотра видео Youtube или Rutube.', 'Скачать дополнительные материалы и инструкцию для самостоятельной работы.', 'Подробная ссылка https://example.com/private-video содержит адрес видео.']) {
    assert.match(preview([video, text(value)]), /Видео входит в урок/);
  }
});
test('missing source descriptions never invent medical outcomes', () => {
  const result = preview([video], 0, { title: 'Йога для беременных', lessonTitle: 'Йога для беременных' });
  assert.equal(result, 'Тема видео — «Йога для беременных». Подробный разбор темы представлен в записи урока.');
});
test('instructions and health claims are kept in the complete lesson', () => {
  const result = preview([video, text('Это упражнение помогает снизить давление и снять головную боль во время беременности. Его нельзя выполнять при противопоказаниях.')]);
  assert.doesNotMatch(result, /снизить давление/);
});
test('long sentences are not cut in the middle', () => {
  const result = preview([video, text('Длинный текст '.repeat(60))]);
  assert.ok(result.length < 250);
});
