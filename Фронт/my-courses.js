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
const topicId = params.get('topic');
const topics = [
  { id: 'birth', title: 'Лёгкие роды', products: [4309095, 4302509, 4302543, 4302555] },
  { id: 'feeding', title: 'Всё о ГВ', products: [4516226, 4302526, 4302546, 4302588] },
  { id: 'recovery', title: 'После родов', products: [4302529, 4302535, 4302602] },
  { id: 'sleep', title: 'Сон малыша', products: [4302520] },
  { id: 'exercise', title: 'Упражнения', products: [4316498, 4302552, 4302557, 4302567, 4302570] },
  { id: 'baby-care', title: 'Уход и развитие малыша', products: [4307012, 4307003, 4516222, 4302575, 4302584, 4302523, 4302532, 4302549] },
  { id: 'health', title: 'Детское здоровье', products: [4302620, 4302598, 4302617] },
];
const otherTopic = { id: 'other', title: 'Другие курсы' };
const topicByProduct = new Map(topics.flatMap(topic => topic.products.map(id => [String(id), topic.id])));

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

function renderProgram(owned) {
  const groups = new Map([...topics, otherTopic].map(topic => [topic.id, { ...topic, courses: [] }]));
  for (const [id, course] of programProducts) {
    groups.get(topicByProduct.get(id) ?? otherTopic.id).courses.push(course);
  }
  const fragment = document.createDocumentFragment();
  const topic = groups.get(topicId);
  if (topicId !== null) {
    if (!topic?.courses.length) {
      fragment.append(paragraph('В этой программе такого раздела нет.'));
    } else {
      heading.textContent = topic.title;
      document.title = topic.title;
      for (const course of topic.courses) {
        const available = owned.get(String(course.productId));
        const link = node('a', 'course-topic-product');
        link.href = available ? courseUrl(course.productId, undefined, program) : 'courses.html';
        link.append(node('h2', '', available?.title ?? course.title),
          node('span', available ? 'course-label' : 'course-label course-label-locked',
            available ? lessonCount(available.lessonCount) : 'Открыть доступ'));
        fragment.append(link);
      }
    }
    setBack(courseListUrl(program), 'К курсам школы');
  } else {
    const grid = node('div', 'course-topic-grid');
    for (const group of groups.values()) {
      if (!group.courses.length) continue;
      const link = node('a', 'course-topic-tile', group.title);
      link.dataset.topic = group.id;
      link.href = courseListUrl(program) + '&topic=' + group.id;
      grid.append(link);
    }
    fragment.append(grid);
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
  if (programProducts) return renderProgram(owned);
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
