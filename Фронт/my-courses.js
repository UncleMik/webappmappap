import { createCourseView, courseErrorText, positiveId } from './course-views.js';

const list = document.querySelector('.owned-list');
const heading = document.querySelector('.owned-header h1');
const back = document.querySelector('.owned-main > .course-back');
const productId = new URLSearchParams(location.search).get('course');
const selected = productId !== null;
const validId = !selected || positiveId(productId);

function paragraph(text) {
  const p = document.createElement('p');
  p.className = 'account-empty';
  p.textContent = text;
  return p;
}

function showError(error, retry) {
  const box = document.createElement('div');
  box.className = 'course-state';
  box.append(paragraph(courseErrorText(error)));
  if (error?.status === 401) {
    const login = document.createElement('a');
    login.href = 'login.html';
    login.textContent = 'Войти';
    box.append(login);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Повторить проверку';
  button.addEventListener('click', retry);
  box.append(button);
  list.replaceChildren(box);
}

function renderProducts(data) {
  if (!Array.isArray(data.courses)) throw new Error('invalid_response');
  const fragment = document.createDocumentFragment();
  for (const course of data.courses) {
    if (!positiveId(course.productId) || typeof course.title !== 'string' || !course.title.trim() ||
        !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0) throw new Error('invalid_response');
    const card = document.createElement('a');
    card.className = 'owned-course course-card';
    card.href = `my-courses.html?course=${encodeURIComponent(course.productId)}`;
    const copy = document.createElement('div');
    copy.className = 'owned-copy';
    const label = document.createElement('span');
    label.className = 'course-label';
    label.textContent = 'Доступен';
    const title = document.createElement('h2');
    title.textContent = course.title;
    copy.append(label, title);
    const count = document.createElement('p');
    const last = course.lessonCount % 10, lastTwo = course.lessonCount % 100;
    const noun = lastTwo >= 11 && lastTwo <= 14 ? 'уроков' : last === 1 ? 'урок' : last >= 2 && last <= 4 ? 'урока' : 'уроков';
    count.textContent = `${course.lessonCount} ${noun}`;
    copy.append(count);
    card.append(copy);
    fragment.append(card);
  }
  if (!data.courses.length) {
    fragment.append(paragraph('У вас пока нет доступных курсов.'));
    const tariffs = document.createElement('a');
    tariffs.className = 'journey-primary';
    tariffs.href = 'courses.html';
    tariffs.textContent = 'Посмотреть тарифы';
    fragment.append(tariffs);
  }
  list.replaceChildren(fragment);
}

function renderCourse(data) {
  const course = data.course;
  if (!course || !positiveId(course.productId) || String(course.productId) !== String(productId) ||
      typeof course.title !== 'string' || !Array.isArray(course.sections)) throw new Error('invalid_response');
  const fragment = document.createDocumentFragment();
  for (const section of course.sections) {
    if (typeof section.title !== 'string' || !Array.isArray(section.lessons)) throw new Error('invalid_response');
    const group = document.createElement('section');
    group.className = 'course-section';
    const title = document.createElement('h2');
    title.textContent = section.title;
    group.append(title);
    for (const lesson of section.lessons) {
      if (!positiveId(lesson.lessonId) || typeof lesson.title !== 'string' ||
          typeof lesson.hasVideo !== 'boolean' || typeof lesson.hasText !== 'boolean') throw new Error('invalid_response');
      const link = document.createElement('a');
      link.className = 'course-lesson-link';
      link.href = `article.html?courseLesson=${encodeURIComponent(lesson.lessonId)}&course=${encodeURIComponent(productId)}`;
      const name = document.createElement('strong');
      name.textContent = lesson.title;
      link.append(name);
      const note = document.createElement('span');
      note.textContent = lesson.hasVideo && !lesson.hasText ? 'Видео пока недоступно'
        : lesson.hasVideo ? 'Текст урока · видео пока недоступно' : lesson.hasText ? 'Текст урока' : 'Материалы урока';
      link.append(note);
      group.append(link);
    }
    fragment.append(group);
  }
  if (!course.sections.length) fragment.append(paragraph('Доступных уроков сейчас нет.'));
  heading.textContent = course.title;
  document.title = course.title;
  list.replaceChildren(fragment);
}

if (selected) {
  back.href = 'my-courses.html';
  back.setAttribute('aria-label', 'Вернуться к моим курсам');
}
if (!validId) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  const view = createCourseView({
    url: selected ? `/api/auth/courses/${productId}` : '/api/auth/courses',
    clear: () => { list.replaceChildren(); document.title = 'Мои курсы'; if (selected) heading.textContent = 'Мои курсы'; },
    loading: () => list.replaceChildren(paragraph('Проверяем доступ к курсам…')),
    render: selected ? renderCourse : renderProducts,
    error: showError,
  });
  view.start();
}
