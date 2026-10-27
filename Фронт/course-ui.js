import { positiveId } from './course-views.js?v=20261026-course-layout';
import { applyCourseBanner } from './course-banners.js?v=20261027';

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function cover(title, id, kind = 'product') {
  const tone = /психолог|медитац|эмоци|страх|дыхани/i.test(title) ? 'calm'
    : /врач|медицин|тревог|кесар|КС|вакцин/i.test(title) ? 'care' : 'prepare';
  const photo = node('span', `course-cover course-cover-${tone}`);
  photo.setAttribute('aria-hidden', 'true');
  applyCourseBanner(photo, id, kind);
  return photo;
}

export const courseUrl = (productId, sectionId) => `my-courses.html?course=${encodeURIComponent(productId)}`
  + (sectionId === undefined ? '' : `&section=${encodeURIComponent(sectionId)}`);

export const lessonUrl = (productId, lessonId, sectionId) =>
  `article.html?courseLesson=${encodeURIComponent(lessonId)}&course=${encodeURIComponent(productId)}&section=${encodeURIComponent(sectionId)}`;

export function validateCourse(course, productId) {
  if (!course || !positiveId(course.productId) || String(course.productId) !== String(productId)
    || typeof course.title !== 'string' || !course.title.trim() || !Array.isArray(course.sections)) throw new Error('invalid_response');
  const sections = new Set(), lessons = new Set();
  for (const section of course.sections) {
    if (!positiveId(section.streamId) || sections.has(String(section.streamId)) || typeof section.title !== 'string'
      || !Array.isArray(section.lessons)) throw new Error('invalid_response');
    sections.add(String(section.streamId));
    for (const lesson of section.lessons) {
      if (!positiveId(lesson.lessonId) || lessons.has(String(lesson.lessonId)) || typeof lesson.title !== 'string'
        || typeof lesson.hasVideo !== 'boolean' || typeof lesson.hasText !== 'boolean') throw new Error('invalid_response');
      lessons.add(String(lesson.lessonId));
    }
  }
  return course;
}

export function primaryLink(text, href) {
  const link = node('a', 'course-primary', text);
  link.href = href;
  return link;
}
