import { createCourseView, courseErrorText, positiveId } from './course-views.js';

const params = new URLSearchParams(location.search);
const productId = params.get('course');
const lessonId = params.get('courseLesson');
const scroller = document.querySelector('.reader-scroll');
const toolbar = document.querySelector('.reader-toolbar > span');
const back = document.querySelector('[data-reader-return]');
const progress = document.querySelector('.reader-progress');
document.querySelector('.reader-page').classList.add('course-lesson-mode');
progress.hidden = true;
toolbar.textContent = 'Урок';
scroller.setAttribute('aria-label', 'Текст урока');
back.href = positiveId(productId) ? `my-courses.html?course=${encodeURIComponent(productId)}` : 'my-courses.html';
back.setAttribute('aria-label', 'Вернуться к курсу');
document.querySelectorAll('.nav-item').forEach(link => {
  const selected = link.getAttribute('href') === 'journey.html';
  link.classList.toggle('active', selected);
  if (selected) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
});

function sectionWithMessage(message, title = 'Урок') {
  const section = document.createElement('section');
  section.className = 'reader-section reader-intro';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = message;
  section.append(heading, text);
  return section;
}

function showError(error, retry) {
  const section = sectionWithMessage(courseErrorText(error), 'Материал закрыт');
  if (error?.status === 401) {
    const login = document.createElement('a');
    login.className = 'reader-button';
    login.href = 'login.html';
    login.textContent = 'Войти';
    section.append(login);
  }
  const button = document.createElement('button');
  button.className = 'reader-button';
  button.type = 'button';
  button.textContent = 'Повторить проверку';
  button.addEventListener('click', retry);
  section.append(button);
  scroller.replaceChildren(section);
  scroller.removeAttribute('aria-busy');
}

const allowedTags = new Set('div span p h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th caption colgroup col br hr strong b em i u s del blockquote pre code details summary sup sub'.split(' '));
function safeFragment(html) {
  if (typeof html !== 'string') return null;
  for (const tag of html.matchAll(/<([^>]*)>/g)) {
    const match = tag[1].match(/^\/?([a-z][a-z0-9]*)\s*\/?$/i);
    if (!match || !allowedTags.has(match[1].toLowerCase())) return null;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  if ([...template.content.querySelectorAll('*')].some(element => !allowedTags.has(element.localName) || element.attributes.length)) return null;
  return template.content;
}

function renderLesson(data) {
  const lesson = data.lesson;
  if (!lesson || !positiveId(lesson.lessonId) || String(lesson.lessonId) !== String(lessonId) ||
      !positiveId(lesson.productId) || String(lesson.productId) !== String(productId) ||
      typeof lesson.title !== 'string' || !Array.isArray(lesson.blocks) ||
      lesson.videoAvailable !== false || typeof lesson.contentCopyDisabled !== 'boolean' ||
      typeof lesson.hasAssignment !== 'boolean' || lesson.assignmentAvailable !== false) throw new Error('invalid_response');
  const fragment = document.createDocumentFragment();
  const intro = document.createElement('section');
  intro.className = 'reader-section reader-intro';
  const heading = document.createElement('h1');
  heading.textContent = lesson.title;
  intro.append(heading);
  fragment.append(intro);
  for (const block of lesson.blocks) {
    if (!block || typeof block.type !== 'string' || typeof block.text !== 'string') throw new Error('invalid_response');
    const section = document.createElement('section');
    section.className = 'reader-section course-content-block';
    if (['text', 'list', 'table'].includes(block.type)) {
      const rich = safeFragment(block.html);
      if (rich) section.append(rich);
      else {
        const text = document.createElement('p');
        text.textContent = block.text;
        section.append(text);
      }
    } else if (block.type === 'video') {
      const text = document.createElement('p');
      text.className = 'course-media-note';
      text.textContent = 'Видео пока недоступно.';
      section.append(text);
    } else if (block.type === 'image' || block.type === 'attachment') {
      const text = document.createElement('p');
      text.className = 'course-media-note';
      text.textContent = block.text || (block.type === 'image' ? 'Изображение пока недоступно.' : 'Вложение пока недоступно.');
      section.append(text);
      if (block.text) {
        const status = document.createElement('p');
        status.className = 'course-media-note';
        status.textContent = block.type === 'image' ? 'Изображение пока недоступно.' : 'Вложение пока недоступно.';
        section.append(status);
      }
    } else if (block.text) {
      const text = document.createElement('p');
      text.textContent = block.text;
      section.append(text);
    }
    if (section.childNodes.length) fragment.append(section);
  }
  if (!lesson.blocks.length) {
    const section = document.createElement('section');
    section.className = 'reader-section';
    const message = document.createElement('p');
    message.textContent = 'Текстовых материалов в этом уроке нет. Видео пока недоступно.';
    section.append(message);
    fragment.append(section);
  }
  if (lesson.hasAssignment && !lesson.assignmentAvailable) {
    const section = document.createElement('section');
    section.className = 'reader-section';
    const message = document.createElement('p');
    message.className = 'course-media-note';
    message.textContent = 'В этом уроке есть задание. Выполнение задания в приложении пока недоступно.';
    section.append(message);
    fragment.append(section);
  }
  scroller.replaceChildren(fragment);
  scroller.removeAttribute('aria-busy');
  scroller.classList.toggle('course-copy-disabled', lesson.contentCopyDisabled);
  toolbar.textContent = 'Урок';
  document.title = lesson.title;
}

if (!positiveId(productId) || !positiveId(lessonId)) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  const view = createCourseView({
    url: `/api/auth/courses/${productId}/lessons/${lessonId}`,
    clear: () => { scroller.replaceChildren(); scroller.classList.remove('course-copy-disabled'); scroller.setAttribute('aria-busy', 'true'); document.title = 'Урок'; },
    loading: () => scroller.replaceChildren(sectionWithMessage('Проверяем доступ к уроку…')),
    render: renderLesson,
    error: showError,
  });
  view.start();
}
