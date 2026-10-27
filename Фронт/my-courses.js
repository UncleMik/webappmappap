import { createCourseView, courseErrorText, positiveId } from './course-views.js?v=20261026-course-layout';
import { node, cover, courseUrl, lessonUrl, validateCourse, primaryLink } from './course-ui.js?v=20261027-banners';

const list = document.querySelector('.owned-list');
const heading = document.querySelector('.owned-header h1');
const back = document.querySelector('.owned-main > .course-back');
const params = new URLSearchParams(location.search);
const productId = params.get('course');
const sectionId = params.get('section');
const selected = productId !== null;
const validId = (!selected || positiveId(productId)) && (sectionId === null || (selected && positiveId(sectionId)));

function setBack(href, text) {
  back.href = href;
  back.setAttribute('aria-label', text);
  back.replaceChildren(node('span', 'course-back-arrow', '‹'), node('span', 'course-back-label', text));
}

function paragraph(text) { return node('p', 'account-empty', text); }

function showError(error, retry) {
  const box = node('div', 'course-state');
  box.append(paragraph(courseErrorText(error)));
  if (error?.status === 401) box.append(primaryLink('Войти', 'login.html'));
  const button = node('button', '', 'Повторить проверку');
  button.type = 'button';
  button.addEventListener('click', retry);
  box.append(button);
  list.replaceChildren(box);
  list.setAttribute('aria-busy', 'false');
}

function lessonCount(count) {
  const last = count % 10, lastTwo = count % 100;
  const noun = lastTwo >= 11 && lastTwo <= 14 ? 'уроков' : last === 1 ? 'урок' : last >= 2 && last <= 4 ? 'урока' : 'уроков';
  return `${count} ${noun}`;
}

function renderProducts(data) {
  if (!Array.isArray(data.courses)) throw new Error('invalid_response');
  const fragment = document.createDocumentFragment();
  for (const course of data.courses) {
    if (!positiveId(course.productId) || typeof course.title !== 'string' || !course.title.trim()
      || !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0) throw new Error('invalid_response');
    const card = node('a', 'owned-course course-product-card');
    card.href = courseUrl(course.productId);
    const copy = node('div', 'owned-copy');
    copy.append(node('span', 'course-label', 'Доступен'), node('h2', '', course.title), node('p', '', lessonCount(course.lessonCount)));
    card.append(cover(course.title, course.productId), copy);
    fragment.append(card);
  }
  if (!data.courses.length) fragment.append(paragraph('У вас пока нет доступных курсов.'), primaryLink('Посмотреть тарифы', 'courses.html'));
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

function renderCourse(data) {
  const course = validateCourse(data.course, productId);
  const fragment = document.createDocumentFragment();
  if (sectionId !== null) {
    const section = course.sections.find(item => String(item.streamId) === sectionId);
    if (!section) throw Object.assign(new Error('section_not_found'), { status: 404 });
    setBack(courseUrl(productId), 'К программе курса');
    heading.textContent = section.title;
    document.title = section.title;
    fragment.append(node('h2', 'course-list-title', 'Уроки раздела'));
    for (const lesson of section.lessons) {
      const link = node('a', 'course-lesson-link');
      link.href = lessonUrl(productId, lesson.lessonId, section.streamId);
      const copy = node('div', 'course-lesson-copy');
      copy.append(node('strong', '', lesson.title), node('span', '', lesson.hasVideo ? 'Видеоурок' : lesson.hasText ? 'Текст урока' : 'Материалы урока'));
      link.append(cover(lesson.title), copy);
      fragment.append(link);
    }
    const first = section.lessons[0];
    if (first) fragment.append(primaryLink('Открыть первый урок', lessonUrl(productId, first.lessonId, section.streamId)));
    else fragment.append(paragraph('Доступных уроков сейчас нет.'));
  } else {
    setBack('my-courses.html', 'Мои курсы');
    heading.textContent = course.title;
    document.title = course.title;
    fragment.append(node('span', 'course-open-badge', 'Курс доступен'), node('h2', 'course-list-title', 'Программа курса'));
    for (const section of course.sections) {
      const card = node('a', 'course-module-card');
      card.href = courseUrl(productId, section.streamId);
      const copy = node('div', 'course-module-copy');
      copy.append(node('h3', '', section.title), node('span', '', lessonCount(section.lessons.length)));
      card.append(cover(section.title, section.streamId, 'training'), copy);
      fragment.append(card);
    }
    const firstSection = course.sections.find(item => item.lessons.length);
    if (firstSection) fragment.append(primaryLink('Начать обучение', lessonUrl(productId, firstSection.lessons[0].lessonId, firstSection.streamId)));
    else fragment.append(paragraph('Доступных уроков сейчас нет.'));
  }
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

setBack(selected ? 'my-courses.html' : 'journey.html', selected ? 'Мои курсы' : 'Мой путь');
if (!validId) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  createCourseView({
    url: selected ? `/api/auth/courses/${productId}` : '/api/auth/courses',
    clear: () => { list.replaceChildren(); list.setAttribute('aria-busy', 'true'); document.title = 'Мои курсы'; heading.textContent = selected ? 'Курс' : 'Мои курсы'; },
    loading: () => list.replaceChildren(paragraph('Проверяем доступ к курсам…')),
    render: selected ? renderCourse : renderProducts,
    error: showError,
  }).start();
}
