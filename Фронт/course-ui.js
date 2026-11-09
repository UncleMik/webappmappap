import { positiveId } from './course-views.js?v=20261026-course-layout';
import { applyCourseBanner } from './course-banners.js?v=20261027';

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function cover(topic, productId) {
  const photo = node('span', 'course-cover');
  photo.dataset.coverTopic = topic;
  photo.setAttribute('aria-hidden', 'true');
  if (productId !== undefined) applyCourseBanner(photo, productId);
  return photo;
}

export const courseProgram = value => value === 'express' || value === 'full' ? value : null;
const programSuffix = program => courseProgram(program) ? `&program=${program}` : '';

export const courseListUrl = program => courseProgram(program) ? `my-courses.html?program=${program}` : 'my-courses.html';
export const courseUrl = (productId, sectionId, program) => `my-courses.html?course=${encodeURIComponent(productId)}`
  + (sectionId === undefined ? '' : `&section=${encodeURIComponent(sectionId)}`)
  + programSuffix(program);

export const isFreeCourseLesson = (productId, lessonId) =>
  (String(productId) === '4302509' && String(lessonId) === '347472707')
  || (String(productId) === '4309095' && String(lessonId) === '347531402');

export const lessonUrl = (productId, lessonId, sectionId, program) =>
  `article.html?courseLesson=${encodeURIComponent(lessonId)}&course=${encodeURIComponent(productId)}&section=${encodeURIComponent(sectionId)}`
  + programSuffix(program)
  + (isFreeCourseLesson(productId, lessonId) ? '&from=course' : '');

export function validateCourse(course, productId) {
  if (!course || !positiveId(course.productId) || String(course.productId) !== String(productId)
    || typeof course.title !== 'string' || !course.title.trim() || !Array.isArray(course.sections)) throw new Error('invalid_response');
  const hasTree = course.rootStreamId !== undefined;
  if (hasTree && !positiveId(course.rootStreamId)) throw new Error('invalid_response');
  const sections = new Set(), lessons = new Set();
  for (const section of course.sections) {
    if (!section || !positiveId(section.streamId) || sections.has(String(section.streamId)) || typeof section.title !== 'string'
      || !Array.isArray(section.lessons)) throw new Error('invalid_response');
    if (hasTree && (String(section.streamId) === String(course.rootStreamId)
      ? section.parentStreamId !== null
      : !sections.has(String(section.parentStreamId)))) throw new Error('invalid_response');
    sections.add(String(section.streamId));
    for (const lesson of section.lessons) {
      if (!lesson || !positiveId(lesson.lessonId) || lessons.has(String(lesson.lessonId)) || typeof lesson.title !== 'string'
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
