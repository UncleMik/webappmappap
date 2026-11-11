import { mountCourseOffers } from './courses.js?v=20261111-clean-titles';
import { programCards, programUrl, programsUrl } from './course-programs.js?v=20261111-return';
import { topicIllustration } from './course-topic-illustrations.js?v=20261109';
import { createCourseView, courseErrorText, positiveId } from './course-views.js?v=20261109-silent-access';
import { node, cover, courseProgram, courseListUrl, courseUrl as baseCourseUrl, lessonUrl, freeCourseLessonId, validateCourse, primaryLink } from './course-ui.js?v=20261109-available-program-videos';

import { applySchoolCourseBanner, schoolCourseBanners } from './course-banners.js?v=20261109-school-covers';

import { topics, groupTopicLessons, courseLessonTopic } from './course-topics.js?v=20261110-feeding-title';

const list = document.querySelector('.owned-list');
const heading = document.querySelector('.owned-header h1');
const back = document.querySelector('.owned-main > .course-back');
const programNav = document.querySelector('.course-program-nav');
const params = new URLSearchParams(location.search);
const productId = params.get('course');
const sectionId = params.get('section');
const program = courseProgram(params.get('program'));
const selected = productId !== null;
const offerId = params.get('offer');
const offerSource = params.get('from') === 'journey' ? 'journey' : null;
const grouped = !selected && (offerId !== null || params.get('programs') === '1');
let offerCatalog = null;
const topicId = params.get('topic');
const subsectionId = params.get('sub');
const topic = topics.find(item => item.id === topicId);
const subsection = topic?.sections.find(([id]) => id === subsectionId);

const validId = (!selected || positiveId(productId)) && (sectionId === null || (selected && positiveId(sectionId)));
const baseTitle = selected ? (sectionId === null ? 'Курс' : 'Раздел курса')
  : grouped ? 'Программы школы' : program ? (subsection?.[1] ?? topic?.title ?? 'Курсы школы') : 'Мои курсы';
const programOffers = { express: [8835218], full: [8835266, 8835331] };
const programCourseIds = { express: '4309095', full: '4302509' };
const fullCourseId = programCourseIds.full;
const otherProgram = program === 'express' ? 'full' : 'express';
let programProducts = null;
let otherProgramProducts = null;
const courseUrl = (...args) => baseCourseUrl(...args) + (offerId !== null ? '&offer=' + encodeURIComponent(offerId) + (offerSource ? '&from=journey' : '') : '');

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
    if (topic.id === 'exercise' || topic.id === 'pregnancy') {
      const target = topic.id === 'exercise' ? 'exercise/pregnancy' : 'pregnancy/movement';
      const courseId = programCourseIds[program];
      const freeId = freeCourseLessonId(courseId);
      const entries = lessons.get(target) ?? [];
      if (freeId && !entries.some(lesson => String(lesson.lessonId) === freeId)) {
        lessons.set(target, [...entries, { productId: courseId, lessonId: freeId, title: 'Диафрагмальное дыхание', hasVideo: true }]);
      }
    }
    const available = topic.sections.filter(([id]) =>
      (topic.id !== 'other' || id !== 'course') && lessons.has(topic.id + '/' + id));
    setBack(subsectionId === null ? courseListUrl(program) : topicUrl(topic.id),
      subsectionId === null ? 'К курсам школы' : topic.title);
    if (subsectionId === null) {
      if (!available.length) {
        fragment.append(paragraph('В этой теме пока нет уроков, доступных по вашему тарифу.'));
        if ([...programProducts.keys()].some(id => !owned.has(id))) fragment.append(primaryLink('Посмотреть программы', 'courses.html'));
      }
      for (const [position, [id, title]] of available.entries()) {
        const count = lessons.get(topic.id + '/' + id).length;
        const link = node('a', 'course-topic-product');
        link.href = topicUrl(topic.id, id);
        link.classList.add('course-topic-subsection');
        const copy = node('div', 'course-topic-subsection-copy');
        copy.append(node('h2', '', title));
        copy.append(node('span', 'course-label', lessonCount(count)));
        link.append(topicIllustration(topic.id + '/' + id, '', position), copy);
        fragment.append(link);
      }
    } else if (!subsection) {
      fragment.append(paragraph('Такой подраздел не найден.'));
    } else {
      const entries = lessons.get(topic.id + '/' + subsectionId) ?? [];
      for (const [position, lesson] of entries.entries()) {
        const link = node('a', 'course-topic-product');
        link.href = lessonUrl(lesson.productId, lesson.lessonId, lesson.sectionId, program)
          + '&topic=' + encodeURIComponent(topic.id) + '&sub=' + encodeURIComponent(subsectionId);
        link.classList.add('course-topic-subsection');
        const copy = node('div', 'course-topic-subsection-copy');
        copy.append(node('h2', '', lesson.title),
          node('span', 'course-label', lesson.hasVideo ? 'Видеоурок' : lesson.hasText ? 'Текст урока' : 'Материалы урока'));
        link.append(topicIllustration(topic.id + '/' + subsectionId, lesson.title, position), copy);
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
  if (grouped) return renderOfferPrograms(data);
  if (!Array.isArray(data.courses)) throw new Error('invalid_response');
  const owned = new Map();
  for (const course of data.courses) {
    if (!course || !positiveId(course.productId) || owned.has(String(course.productId))
      || typeof course.title !== 'string' || !course.title.trim()
      || !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0) throw new Error('invalid_response');
    owned.set(String(course.productId), course);
  }
  if (!owned.size) {
    const catalog = node('div', 'course-offers');
    catalog.append(document.querySelector('#course-offers-template').content.cloneNode(true));
    mountCourseOffers(catalog);
    list.replaceChildren(catalog);
    list.setAttribute('aria-busy', 'false');
    return;
  }
  if (programProducts) {
    const readable = [...owned].filter(([, course]) => course.lessonCount > 0);
    if (otherProgramProducts && !readable.some(([id]) => programProducts.has(id))
      && readable.some(([id]) => otherProgramProducts.has(id))) {
      const query = new URLSearchParams(params);
      query.set('program', otherProgram);
      location.replace('my-courses.html?' + query);
      return;
    }
    return renderProgram(data, owned);
  }
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
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

function renderOfferPrograms(data) {
  const programs = programCards(offerCatalog, data.courses);
  const current = offerId === null ? null : programs.find(item => String(item.offerId) === offerId);
  if (offerId !== null && !current) throw Object.assign(new Error('not_found'), { status: 404 });
  const fragment = document.createDocumentFragment();
  const banners = schoolCourseBanners();
  const appendCard = (title, href, label, available) => {
    const card = node('a', 'owned-course course-product-card');
    card.href = href;
    const photo = node('div', 'course-cover');
    applySchoolCourseBanner(photo, banners.next().value, title, 'h2');
    const copy = node('div', 'owned-copy');
    copy.append(node('span', available ? 'course-label' : 'course-label course-label-locked', label));
    card.append(photo, copy);
    fragment.append(card);
  };
  if (current) {
    heading.textContent = current.title;
    document.title = current.title;
    setBack(offerSource ? 'journey.html' : programsUrl, offerSource ? 'Мой путь' : 'Все программы');
    current.items.forEach((item, index) => {
      if (index < 2) fragment.append(node('h2', 'course-list-title', index === 0 ? 'Основной курс' : 'Бонусы'));
      const href = item.owned ? courseUrl(item.productId) : 'courses.html';
      appendCard(item.title, href, item.owned ? 'Доступен · ' + lessonCount(item.lessonCount) : 'Открыть доступ', item.owned);
    });
  } else {
    setBack('journey.html', 'Мой путь');
    for (const item of programs) appendCard(item.title, programUrl(item.offerId),
      item.availableCount ? 'Есть доступные материалы' : 'Основной курс и бонусы', item.availableCount > 0);
  }
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
}

function moduleCard(section, count, number, parentTitle) {
  const card = node('a', 'course-module-card');
  card.href = courseUrl(productId, section.streamId, program);
  const copy = node('div', 'course-module-copy');
  copy.append(node('h3', '', section.title), node('span', '', lessonCount(count)));
  const index = node('span', 'course-module-index', String(number));
  index.setAttribute('aria-hidden', 'true');
  const theme = courseLessonTopic(section, parentTitle ? [parentTitle] : [], productId);
  const art = topicIllustration(theme, section.title, number - 1);
  art.append(index);
  card.append(art, copy);
  return card;
}

function lessonCard(lesson, section, position) {
  const link = node('a', 'course-lesson-link');
  link.href = lessonUrl(productId, lesson.lessonId, section.streamId, program);
  const copy = node('div', 'course-lesson-copy');
  copy.append(node('strong', '', lesson.title), node('span', '', lesson.hasVideo ? 'Видеоурок' : lesson.hasText ? 'Текст урока' : 'Материалы урока'));
  const topic = courseLessonTopic(lesson, [section.title], productId);
  link.append(topicIllustration(topic, lesson.title, position), copy);
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
  if (atRoot) setBack(offerId !== null ? programUrl(offerId, offerSource) : courseListUrl(program), offerId !== null ? 'К программе' : program ? 'К курсам школы' : 'Мои курсы');
  else setBack(courseUrl(productId, insideSection ? parentId : undefined, program),
    insideSection ? 'К разделу выше' : 'К программе курса');
  heading.textContent = atRoot ? course.title : section.title;
  document.title = heading.textContent;

  const modules = hasTree
    ? course.sections.filter(item => section && String(item.parentStreamId) === String(section.streamId))
    : atRoot ? course.sections : [];
  if (productId === fullCourseId && String(currentId) === '935386962') {
    modules.sort((a, b) => Number(b.title) - Number(a.title));
  }
  let directLessons = section?.lessons ?? [];
  if (atRoot && productId === fullCourseId) {
    directLessons = directLessons.filter(lesson => String(lesson.lessonId) !== '347472344');
  }
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
    const accessEnd = typeof course.accessEndsAt === 'string' ? Date.parse(course.accessEndsAt) : NaN;
    let accessLabel = 'Курс доступен';
    if (Number.isFinite(accessEnd)) {
      const date = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
      }).format(accessEnd);
      accessLabel += ' до ' + date;
    } else if (course.accessEndsAt === null) accessLabel += ' бессрочно';
    fragment.append(node('span', 'course-open-badge', accessLabel));
    if (productId === fullCourseId) {
      const banner = node('div', 'course-program-banner');
      applySchoolCourseBanner(banner, 1, 'Программа курса', 'h2');
      fragment.append(banner);
    } else {
      fragment.append(node('h2', 'course-list-title', 'Программа курса'));
    }
    const first = productId === fullCourseId ? undefined : course.sections.find(item => item.lessons.length);
    if (first) {
      const banner = node('a', 'course-start-banner');
      banner.href = lessonUrl(productId, first.lessons[0].lessonId, first.streamId, program);
      const caption = node('span', 'course-start-caption', 'Начать обучение');
      banner.append(cover(courseLessonTopic(first.lessons[0], [first.title], productId).split('/')[0], productId), caption);
      fragment.append(banner);
    }
  }
  if (modules.length) {
    fragment.append(node('h2', 'course-list-title', 'Разделы'));
    modules.forEach((child, index) => fragment.append(moduleCard(child, counts.get(String(child.streamId)), index + 1, section?.title)));
  }
  if (directLessons.length) {
    fragment.append(node('h2', 'course-list-title', atRoot ? 'Уроки курса' : 'Уроки раздела'));
    directLessons.forEach((lesson, index) => fragment.append(lessonCard(lesson, section, modules.length + index)));
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
}

function loading() {
  const status = paragraph(selected ? 'Загружаем разделы и уроки…' : 'Проверяем доступ к курсам…');
  status.setAttribute('role', 'status');
  list.replaceChildren(status);
}

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

function productsForProgram(offers, name) {
  const products = new Map();
  for (const offerId of programOffers[name]) {
    const offer = offers.find(item => item?.offerId === offerId);
    if (!Array.isArray(offer?.items)) return null;
    for (const item of offer.items) {
      if (!item || !positiveId(item.productId) || typeof item.title !== 'string' || !item.title.trim()
        || !['training', 'groups'].includes(item.type)) return null;
      if (item.type === 'training') products.set(String(item.productId), item);
    }
  }
  return products.size ? products : null;
}

async function loadProgram() {
  clear();
  loading();
  try {
    const response = await fetch('/api/course-offers', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('catalog_unavailable'), { status: response.status });
    const { offers } = await response.json();
    if (!Array.isArray(offers)) throw new Error('invalid_catalog');
    programProducts = productsForProgram(offers, program);
    if (!programProducts) throw new Error('invalid_catalog');
    otherProgramProducts = productsForProgram(offers, otherProgram);
    startView();
  } catch (error) {
    showError(error, loadProgram, error?.status === 401 ? undefined : 'Не удалось загрузить программу. Попробуйте ещё раз.');
  }
}

async function loadOfferPrograms() {
  clear();
  loading();
  try {
    const response = await fetch('/api/course-offers', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('catalog_unavailable'), { status: response.status });
    offerCatalog = (await response.json()).offers;
    programCards(offerCatalog, []);
    startView();
  } catch (error) { showError(error, loadOfferPrograms); }
}

if (!selected) {
  programNav.hidden = Boolean(program) || grouped;
  for (const link of programNav.querySelectorAll('a')) {
    if (courseProgram(link.dataset.program) === program) link.setAttribute('aria-current', 'page');
  }
  list.setAttribute('aria-label', program ? 'Курсы программы' : 'Ваши курсы');
} else list.setAttribute('aria-label', 'Разделы и уроки');

// Navigation stays available while the protected course content is cleared.
if (validId && sectionId !== null) {
  setBack(courseUrl(productId, undefined, program), 'К программе курса');
} else {
  if (offerId !== null) {
    setBack(selected ? programUrl(offerId, offerSource) : offerSource ? 'journey.html' : programsUrl,
      selected ? 'К программе' : offerSource ? 'Мой путь' : 'Все программы');
  } else setBack(selected ? courseListUrl(program) : 'journey.html', selected ? program ? 'К курсам школы' : 'Мои курсы' : 'Мой путь');
}

if (!validId) {
  clear();
  showError({ status: 404 }, () => location.assign(courseListUrl(program)));
} else if (grouped) void loadOfferPrograms();
else if (!selected && program) void loadProgram();
else {
  clear();
  startView();
}
