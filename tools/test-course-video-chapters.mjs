import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseChapters } from '../Фронт/course-video-chapters.js';

// The lesson stores sanitized table HTML. This small DOM fixture supplies its
// source rows to the parser without adding a browser dependency to Node tests.
function cell(tag, markup) {
  return { localName: tag, textContent: markup.replace(/<[^>]*>/g, '').replaceAll('&nbsp;', ' ') };
}
globalThis.document = {
  createElement(name) {
    assert.equal(name, 'template');
    return {
      set innerHTML(markup) { this.source = markup; },
      content: {
        querySelectorAll() { throw new Error('Use template querySelectorAll'); },
      },
      get source() { return this._source; },
      set source(markup) { this._source = markup; this.content.querySelectorAll = selector => {
        assert.equal(selector, 'table');
        return [...markup.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(([, body]) => ({
          querySelectorAll(rowSelector) {
            assert.equal(rowSelector, 'tr');
            return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => ({
              children: [...row.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)]
                .map(([, tag, content]) => cell(tag.toLowerCase(), content)),
            }));
          },
        }));
      }; },
    };
  },
};

const sourceTable = '<table><tbody><tr><td>Дыхание свечкой</td><td>02:36</td></tr>'
  + '<tr><td>Дыхание лошадкой</td><td>04:20</td></tr></tbody></table>';
const video = () => ({ type: 'video', videos: [{ provider: 'getcourse', url: 'https://example.test/video.mp4' }] });

test('source chapters belong to the preceding playable video, including after an explanatory paragraph', () => {
  const blocks = [video(), { type: 'text', text: 'Для удобства указаны таймкоды.' },
    { type: 'table', html: sourceTable }, video(),
    { type: 'table', html: '<table><tr><th>Время</th><th>Тема</th></tr><tr><td>0:00</td><td>Начало</td></tr></table>' }];
  assert.deepEqual([...courseChapters(blocks).byVideo], [[0, [{ seconds: 156, label: 'Дыхание свечкой' },
    { seconds: 260, label: 'Дыхание лошадкой' }]], [3, [{ seconds: 0, label: 'Начало' }]]]);
  assert.deepEqual([...courseChapters(blocks).tableIndexes], [2,4]);
  assert.equal(blocks[2].html, sourceTable);
});

test('deleted video text and another video stop chapter association', () => {
  const blocks = [video(), { type: 'text', text: 'Видео было удалено, загрузите видео повторно' },
    { type: 'table', html: sourceTable }, video(),
    { type: 'video', videos: [{ provider: 'unknown', url: null }] },
    { type: 'table', html: sourceTable }];
  assert.equal(courseChapters(blocks).byVideo.size, 0);
});

test('ambiguous multi-source and malformed timestamp tables are not turned into chapter buttons', () => {
  const blocks = [{ type: 'video', videos: [video().videos[0], { provider: 'youtube', url: 'https://example.test/embed' }] },
    { type: 'table', html: sourceTable }, video(),
    { type: 'table', html: '<table><tr><td>Тема</td><td>01:75</td></tr></table>' },
    { type: 'text', text: 'Занятие начинается в 10:30' }];
  assert.equal(courseChapters(blocks).byVideo.size, 0);
});
