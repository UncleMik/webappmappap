import { createCourseView, courseErrorText, positiveId } from './course-views.js?v=20261109-thematic-lessons';
import { node, cover, courseProgram, courseListUrl, courseUrl, lessonUrl, validateCourse, primaryLink } from './course-ui.js?v=20261109-programs';

import { applySchoolCourseBanner, schoolCourseBanners } from './course-banners.js?v=20261109-school-covers';

import { topics, groupTopicLessons } from './course-topics.js?v=20261109-school-meetings';

const list = document.querySelector('.owned-list');
const heading = document.querySelector('.owned-header h1');
const back = document.querySelector('.owned-main > .course-back');
const programNav = document.querySelector('.course-program-nav');
const params = new URLSearchParams(location.search);
const productId = params.get('course');
const sectionId = params.get('section');
const program = courseProgram(params.get('program'));
const selected = productId !== null;
const topicId = params.get('topic');
const subsectionId = params.get('sub');

const validId = (!selected || positiveId(productId)) && (sectionId === null || (selected && positiveId(sectionId)));
const baseTitle = selected ? 'Курс' : program ? 'Курсы школы' : 'Мои курсы';
const programOffers = { express: [8835218], full: [8835266, 8835331] };
const fullCourseId = '4302509';
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

const topicUrl = (id, sub) => courseListUrl(program) + '&topic=' + encodeURIComponent(id)
  + (sub ? '&sub=' + encodeURIComponent(sub) : '');

async function loadTopicCourses(read) {
  const owned = await read('/api/auth/courses');
  if (!Array.isArray(owned.courses)) throw new Error('invalid_response');
  const candidates = owned.courses.filter(course => positiveId(course?.productId)
    && course.lessonCount > 0 && programProducts.has(String(course.productId)));
  const responses = [owned];
  // Bound concurrent reads and keep the program's order for duplicate lesson links.
  const available = new Set(candidates.map(course => String(course.productId)));
  const ids = [...programProducts.keys()].filter(id => available.has(id));
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = await Promise.all(ids.slice(offset, offset + 4).map(async id => {
      const result = await read('/api/auth/courses/' + id);
      validateCourse(result.course, id);
      return result;
    }));
    responses.push(...batch);
  }
  return responses;
}

function renderProgram(data, owned) {
  const fragment = document.createDocumentFragment();
  const topic = topics.find(item => item.id === topicId);
  if (topicId === null) {
    const grid = node('div', 'course-topic-grid');
    if (program === 'full' && programProducts.has(fullCourseId)) {
      const link = node('a', 'course-topic-tile course-program-tile');
      const available = owned.has(fullCourseId);
      link.href = available ? courseUrl(fullCourseId, undefined, program) : 'courses.html';
      const copy = node('span', 'course-program-tile-copy');
      copy.append(node('span', '', 'Полная программа курса'));
      if (!available) copy.append(node('small', '', 'Посмотреть условия доступа'));
      const arrow = node('span', 'course-program-tile-arrow', '›');
      arrow.setAttribute('aria-hidden', 'true');
      link.append(copy, arrow);
      grid.append(link);
    }
    for (const item of topics) {
      const link = node('a', 'course-topic-tile', item.title);
      link.dataset.topic = item.id;
      link.href = topicUrl(item.id);
      grid.append(link);
    }
    fragment.append(grid);
  } else if (!topic) {
    fragment.append(paragraph('Такой раздел не найден.'));
    setBack(courseListUrl(program), 'К курсам школы');
  } else {
    const lessons = groupTopicLessons(data.courseTrees ?? []);
    const available = topic.sections.filter(([id]) => lessons.has(topic.id + '/' + id));
    const subsection = topic.sections.find(([id]) => id === subsectionId);
    heading.textContent = subsection?.[1] ?? topic.title;
    document.title = heading.textContent;
    setBack(subsectionId === null ? courseListUrl(program) : topicUrl(topic.id),
      subsectionId === null ? 'К курсам школы' : topic.title);
    if (subsectionId === null) {
      for (const [id, title] of available.length ? available : topic.sections) {
        const count = lessons.get(topic.id + '/' + id)?.length ?? 0;
        const link = node('a', 'course-topic-product');
        link.href = topicUrl(topic.id, id);
        link.append(node('h2', '', title));
        if (count) link.append(node('span', 'course-label', lessonCount(count)));
        fragment.append(link);
      }
    } else if (!subsection) {
      fragment.append(paragraph('Такой подраздел не найден.'));
    } else {
      const entries = lessons.get(topic.id + '/' + subsectionId) ?? [];
      for (const lesson of entries) {
        const link = node('a', 'course-topic-product');
        link.href = lessonUrl(lesson.productId, lesson.lessonId, lesson.sectionId, program)
          + '&topic=' + encodeURIComponent(topic.id) + '&sub=' + encodeURIComponent(subsectionId);
        link.append(node('h2', '', lesson.title),
          node('span', 'course-label', lesson.hasVideo ? 'Видеоурок' : lesson.hasText ? 'Текст урока' : 'Материалы урока'));
        fragment.append(link);
      }
      if (!entries.length) {
        fragment.append(paragraph('В этом подразделе пока нет доступных вам уроков.'));
        if ([...programProducts.keys()].some(id => !owned.has(id))) fragment.append(primaryLink('Посмотреть программы', 'courses.html'));
      }
    }
  }
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
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
  if (programProducts) return renderProgram(data, owned);
  const products = owned;
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

function moduleCard(section, count, number) {
  const card = node('a', 'course-module-card');
  card.href = courseUrl(productId, section.streamId, program);
  const copy = node('div', 'course-module-copy');
  copy.append(node('h3', '', section.title), node('span', '', lessonCount(count)));
  const index = node('span', 'course-module-index', String(number));
  index.setAttribute('aria-hidden', 'true');
  card.append(index, copy);
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
    if (first) {
      const banner = node('a', 'course-start-banner');
      banner.href = lessonUrl(productId, first.lessons[0].lessonId, first.streamId, program);
      const caption = node('span', 'course-start-caption', 'Начать обучение');
      banner.append(cover(course.title, productId), caption);
      fragment.append(banner);
    }
  }
  if (modules.length) {
    fragment.append(node('h2', 'course-list-title', 'Разделы'));
    modules.forEach((child, index) => fragment.append(moduleCard(child, counts.get(String(child.streamId)), index + 1)));
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
    load: !selected && program && topics.some(topic => topic.id === topicId) ? loadTopicCourses : undefined,
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
  programNav.hidden = Boolean(program);
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
