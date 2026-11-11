import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTopicLessons } from '../Фронт/course-topics.js';

test('an accessible copy of a shared lesson wins over a locked copy', () => {
  const course = (productId, available) => ({ productId, rootStreamId: 1, sections: [{
    streamId: 1, parentStreamId: null, title: 'Подготовка к родам',
    lessons: [{ lessonId: 347472729, title: 'Как подготовиться к родам', available,
      hasVideo: true, hasText: false }],
  }] });
  const entries = groupTopicLessons([course(4309095, false), course(4302509, true)])
    .get('birth/preparation');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].productId, 4302509);
  assert.equal(entries[0].available, true);
});
