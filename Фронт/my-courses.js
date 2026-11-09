import { createCourseView, courseErrorText, positiveId } from './course-views.js?v=20261026-course-layout';
import { node, cover, courseProgram, courseListUrl, courseUrl, lessonUrl, validateCourse, primaryLink } from './course-ui.js?v=20261109-programs';

import { applySchoolCourseBanner, schoolCourseBanners } from './course-banners.js?v=20261109-school-covers';

const list = document.querySelector('.owned-list');
const heading = document.querySelector('.owned-header h1');
const back = document.querySelector('.owned-main > .course-back');
const programNav = document.querySelector('.course-program-nav');
const params = new URLSearchParams(location.search);
const productId = params.get('course');
const sectionId = params.get('section');
const program = courseProgram(params.get('program'));
const selected = productId !== null;
const validId = (!selected || positiveId(productId)) && (sectionId === null || (selected && positiveId(sectionId)));
const baseTitle = selected ? 'Курс' : program ? 'Курсы школы' : 'Мои курсы';
const programOffers = { express: [8835218], full: [8835266, 8835331] };
let programProducts = null;

function setBack(href, text) {
  back.href = href;
  back.setAttribute('aria-label', text);
  back.replaceChildren(node('span', 'course-back-arrow', '‹'), node('span', 'course-back-label', text));
}

function paragraph(text) { return node('p', 'account-empty', text); }

function showError(error, retry, message = courseErrorText(error)) {
  const box = node('div', 'course-state');
  box.append(paragraph(message));
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
  const owned = new Map();
  for (const course of data.courses) {
    if (!course || !positiveId(course.productId) || owned.has(String(course.productId))
      || typeof course.title !== 'string' || !course.title.trim()
      || !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0) throw new Error('invalid_response');
    owned.set(String(course.productId), course);
  }
  const products = programProducts ?? owned;
  const fragment = document.createDocumentFragment();
  const banners = schoolCourseBanners();
  for (const [id, course] of products) {
    const available = owned.get(id);
    const card = node('a', 'owned-course course-product-card');
    card.href = available ? courseUrl(course.productId, undefined, program) : 'courses.html';
    const copy = node('div', 'owned-copy');
    copy.append(node('span', available ? 'course-label' : 'course-label course-label-locked',
      available ? 'Доступен' : 'Открыть доступ'));
    if (available) copy.append(node('p', '', lessonCount(available.lessonCount)));
    const photo = node('div', 'course-cover');
    applySchoolCourseBanner(photo, banners.next().value, available?.title ?? course.title, 'h2');
    card.append(photo, copy);
    fragment.append(card);
  }
  if (!products.size) fragment.append(paragraph('У вас пока нет доступных курсов.'), primaryLink('Посмотреть тарифы', 'courses.html'));
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

function moduleCard(section, count) {
  const card = node('a', 'course-module-card');
  card.href = courseUrl(productId, section.streamId, program);
  const copy = node('div', 'course-module-copy');
  copy.append(node('h3', '', section.title), node('span', '', lessonCount(count)));
  card.append(cover(section.title, section.streamId, 'training'), copy);
  return card;
}

function lessonCard(lesson, streamId) {
  const link = node('a', 'course-lesson-link');
  link.href = lessonUrl(productId, lesson.lessonId, streamId, program);
  const copy = node('div', 'course-lesson-copy');
  copy.append(node('strong', '', lesson.title), node('span', '', lesson.hasVideo ? 'Видеоурок' : lesson.hasText ? 'Текст урока' : 'Материалы урока'));
  link.append(cover(lesson.title), copy);
  return link;
}

function renderCourse(data) {
  const course = validateCourse(data.course, productId);
  const hasTree = course.rootStreamId !== undefined;
  const currentId = sectionId ?? course.rootStreamId;
  const section = course.sections.find(item => String(item.streamId) === String(currentId));
  if (sectionId !== null && !section) throw Object.assign(new Error('section_not_found'), { status: 404 });
  const atRoot = sectionId === null || String(currentId) === String(course.rootStreamId);
  const parentId = section?.parentStreamId;
  const insideSection = !atRoot && positiveId(parentId) && String(parentId) !== String(course.rootStreamId);
  if (atRoot) setBack(courseListUrl(program), program ? 'К курсам школы' : 'Мои курсы');
  else setBack(courseUrl(productId, insideSection ? parentId : undefined, program),
    insideSection ? 'К разделу выше' : 'К программе курса');
  heading.textContent = atRoot ? course.title : section.title;
  document.title = heading.textContent;

  const modules = hasTree
    ? course.sections.filter(item => section && String(item.parentStreamId) === String(section.streamId))
    : atRoot ? course.sections : [];
  const directLessons = section?.lessons ?? [];
  const counts = new Map();
  // The server sends parents before children, so a reverse pass counts entire folders.
  for (let i = course.sections.length - 1; i >= 0; i--) {
    const item = course.sections[i];
    const id = String(item.streamId);
    const count = item.lessons.length + (counts.get(id) ?? 0);
    counts.set(id, count);
    if (positiveId(item.parentStreamId)) {
      const parent = String(item.parentStreamId);
      counts.set(parent, (counts.get(parent) ?? 0) + count);
    }
  }

  const fragment = document.createDocumentFragment();
  if (atRoot) {
    fragment.append(node('span', 'course-open-badge', 'Курс доступен'), node('h2', 'course-list-title', 'Программа курса'));
    const first = course.sections.find(item => item.lessons.length);
    if (first) fragment.append(primaryLink('Начать обучение', lessonUrl(productId, first.lessons[0].lessonId, first.streamId, program)));
  }
  if (modules.length) {
    fragment.append(node('h2', 'course-list-title', 'Разделы'));
    for (const child of modules) fragment.append(moduleCard(child, counts.get(String(child.streamId))));
  }
  if (directLessons.length) {
    fragment.append(node('h2', 'course-list-title', atRoot ? 'Уроки курса' : 'Уроки раздела'));
    for (const lesson of directLessons) fragment.append(lessonCard(lesson, section.streamId));
    if (!atRoot) fragment.append(primaryLink('Открыть первый урок', lessonUrl(productId, directLessons[0].lessonId, section.streamId, program)));
  }
  if (!modules.length && !directLessons.length) fragment.append(paragraph('Доступных уроков сейчас нет.'));
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

function clear() {
  list.replaceChildren();
  list.setAttribute('aria-busy', 'true');
  document.title = baseTitle;
  heading.textContent = baseTitle;
  setBack(selected ? courseListUrl(program) : 'journey.html', selected ? program ? 'К курсам школы' : 'Мои курсы' : 'Мой путь');
}

function loading() { list.replaceChildren(paragraph('Проверяем доступ к курсам…')); }

function startView() {
  createCourseView({
    url: selected ? `/api/auth/courses/${productId}` : '/api/auth/courses',
    clear,
    loading,
    render: selected ? renderCourse : renderProducts,
    error: showError,
  }).start();
}

async function loadProgram() {
  clear();
  loading();
  try {
    const response = await fetch('/api/course-offers', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('catalog_unavailable'), { status: response.status });
    const { offers } = await response.json();
    const products = new Map();
    if (!Array.isArray(offers)) throw new Error('invalid_catalog');
    for (const offerId of programOffers[program]) {
      const offer = offers.find(item => item?.offerId === offerId);
      if (!Array.isArray(offer?.items)) throw new Error('invalid_catalog');
      for (const item of offer.items) {
        if (!item || !positiveId(item.productId) || typeof item.title !== 'string' || !item.title.trim()
          || !['training', 'groups'].includes(item.type)) throw new Error('invalid_catalog');
        if (item.type === 'training') products.set(String(item.productId), item);
      }
    }
    if (!products.size) throw new Error('invalid_catalog');
    programProducts = products;
    startView();
  } catch (error) {
    showError(error, loadProgram, error?.status === 401 ? undefined : 'Не удалось загрузить программу. Попробуйте ещё раз.');
  }
}

if (!selected) {
  programNav.hidden = false;
  for (const link of programNav.querySelectorAll('a')) {
    if (courseProgram(link.dataset.program) === program) link.setAttribute('aria-current', 'page');
  }
  list.setAttribute('aria-label', program ? 'Курсы программы' : 'Ваши курсы');
} else list.setAttribute('aria-label', 'Разделы и уроки');

if (!validId) {
  clear();
  showError({ status: 404 }, () => location.assign(courseListUrl(program)));
} else if (!selected && program) void loadProgram();
else startView();
