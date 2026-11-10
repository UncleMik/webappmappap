import { courseLessonTopic } from './course-topics.js?v=20261109-topic-covers';
import { courseVideoTopic } from './course-video-topics.js?v=20261027-topic-titles';
import { courseVideoDescription } from './course-video-description.js?v=20261028-descriptions';
import { mountCourseVideo } from './course-video-player.js?v=20261027-subtopics';
import { courseChapters } from './course-video-chapters.js?v=20261026-weekly-style';
import { createCourseView, courseErrorText, positiveId, stopCourseMedia } from './course-views.js?v=20261109-silent-access';
import { node, courseProgram, courseListUrl, courseUrl, lessonUrl, isFreeCourseLesson, validateCourse, primaryLink } from './course-ui.js?v=20261109-programs';

const params = new URLSearchParams(location.search);
const productId = params.get('course');
const lessonId = params.get('courseLesson');
const program = courseProgram(params.get('program'));
const topic = params.get('topic');
const subsection = params.get('sub');
const thematicBack = program && /^[a-z-]+$/.test(topic ?? '') && /^[a-z-]+$/.test(subsection ?? '')
  ? courseListUrl(program) + '&topic=' + topic + '&sub=' + subsection : null;
const freeLesson = params.get('from') !== 'course' && isFreeCourseLesson(productId, lessonId);
const scroller = document.querySelector('.reader-scroll');
const toolbar = document.querySelector('.reader-toolbar > span');
const back = document.querySelector('[data-reader-return]');
const progress = document.querySelector('.reader-progress');
const setFavorite = window.bindFavoriteButton(document.querySelector('.video-favorite'), document.querySelector('.favorite-status'));
const requestedVideo = params.get('video');
const fromFavorites = params.get('from') === 'favorites';
let courseView = null;
let pendingVideoPositions = new Map();
let selectedTab = 'about';
let selectedVideoKey;
document.querySelector('.reader-page').classList.add('course-lesson-mode');
progress.hidden = true;
scroller.setAttribute('aria-label', 'Содержание урока');
const initialBackText = fromFavorites ? 'В избранное' : thematicBack ? 'К урокам по теме' : freeLesson ? 'На главную' : 'К программе курса';
back.href = fromFavorites ? 'favorites.html' : thematicBack ?? (freeLesson ? 'index.html'
  : positiveId(productId) ? courseUrl(productId, undefined, program) : courseListUrl(program));
back.setAttribute('aria-label', initialBackText);
toolbar.textContent = initialBackText;
toolbar.addEventListener('click', () => back.click());
document.querySelectorAll('.nav-item').forEach(link => {
  const selected = params.get('from') !== 'index-breathing' && link.getAttribute('href') === 'journey.html';
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
  stopCourseMedia(scroller);
  scroller.replaceChildren(section);
  scroller.removeAttribute('aria-busy');
}

function buildCourseNavigator(course, lessonId, program) {
  const children = new Map();
  for (const section of course.sections) {
    const key = String(section.parentStreamId);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(section);
  }
  const navigator = node('section', 'reader-section course-navigator');
  navigator.append(node('h2', '', 'Разделы и уроки'),
    node('p', 'course-navigator-hint', 'Раскройте раздел и выберите урок.'));

  function appendLessons(parent, section) {
    const lessons = section.lessons.filter(lesson => String(lesson.lessonId) !== lessonId);
    if (!lessons.length) return;
    const list = node('ul', 'course-navigator-lessons');
    for (const lesson of lessons) {
      const row = node('li');
      const link = node('a', '', lesson.title);
      link.href = lessonUrl(course.productId, lesson.lessonId, section.streamId, program);
      row.append(link);
      list.append(row);
    }
    parent.append(list);
  }

  function appendSection(parent, section) {
    const group = node('details', 'course-navigator-group');
    const body = node('div', 'course-navigator-body');
    const link = node('a', 'course-navigator-section-link', 'Открыть раздел');
    link.href = courseUrl(course.productId, section.streamId, program);
    link.setAttribute('aria-label', `Открыть раздел «${section.title}»`);
    body.append(link);
    appendLessons(body, section);
    for (const child of children.get(String(section.streamId)) ?? []) appendSection(body, child);
    group.append(node('summary', '', section.title), body);
    parent.append(group);
  }

  const rootId = String(course.rootStreamId);
  const root = course.sections.find(section => String(section.streamId) === rootId);
  if (root?.lessons.some(lesson => String(lesson.lessonId) !== lessonId)) {
    const intro = node('details', 'course-navigator-group');
    intro.append(node('summary', '', 'Вводные уроки'));
    appendLessons(intro, root);
    navigator.append(intro);
  }
  for (const section of children.get(rootId) ?? []) appendSection(navigator, section);
  return navigator.childElementCount > 2 ? navigator : null;
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
  // GetCourse uses empty paragraphs as spacers; retain the text without large blank gaps.
  template.content.querySelectorAll('p').forEach(paragraph => { if (!paragraph.textContent.trim()) paragraph.remove(); });
  return template.content;
}

const getcourseVideoUrl = /^https:\/\/fs\.getcourse\.ru\/fileservice\/file\/download\/a\/25918\/sc\/(?:0|[1-9][0-9]*)\/h\/[a-fA-F0-9]{32}\.(?:mp4|m4v|mov|webm)$/;
const youtubeVideoUrl = /^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{1,200}$/;
const rutubeVideoUrl = /^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]{1,200}\/?(?:\?p=[A-Za-z0-9_-]{1,200})?$/;

function playableVideo(video, available) {
  if (!available || !video || typeof video !== 'object' || typeof video.url !== 'string') return false;
  if (video.provider === 'getcourse') return getcourseVideoUrl.test(video.url);
  if (video.provider === 'youtube') return youtubeVideoUrl.test(video.url);
  if (video.provider === 'rutube') return rutubeVideoUrl.test(video.url);
  return false;
}

function mediaNote(message) {
  const note = document.createElement('p');
  note.className = 'course-media-note';
  note.textContent = message;
  return note;
}

function currentVideoPositions() {
  const positions = new Map();
  for (const player of scroller.querySelectorAll('video.course-video-element')) {
    const key = player.courseVideoKey;
    const url = player.getAttribute('src');
    const time = player.currentTime;
    if (typeof key === 'string' && typeof url === 'string' &&
        Number.isFinite(time) && time >= 0) {
      positions.set(key, { url, time, playing: !player.paused && !player.ended && !player.closest('[hidden]') });
    }
  }
  return positions;
}

function videoPlayer(video, index, total, available, key, positions, restoreJobs, navigation, chapters, coverTopic) {
  const container = document.createElement('div');
  container.className = 'course-video-item';
  if (!playableVideo(video, available)) {
    container.append(mediaNote(total > 1 ? `Видео ${index + 1} пока недоступно.` : 'Видео пока недоступно.'));
    return container;
  }
  if (video.provider === 'getcourse') {
    const snapshot = positions.get(key);
    const saved = snapshot?.url === video.url ? snapshot : null;
    const mounted = mountCourseVideo({ video, container, key, saved,
      isAllowed: () => scroller.contains(container) && !container.closest('[hidden]') && courseView?.isCurrent(),
      refresh: () => courseView?.refresh(), ...navigation, chapters });
    if (saved) restoreJobs.push(mounted.restore);
    return container;
  }
  container.classList.add('course-player');
  const stage = node('div', 'video-stage');
  const button = node('button', 'video-cover course-video-start');
  button.type = 'button';
  button.dataset.coverTopic = coverTopic;
  button.setAttribute('aria-label', total > 1 ? `Смотреть видео ${index + 1}` : 'Смотреть видео');
  const symbol = node('span', 'cover-play');
  symbol.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 13 8-13 8Z"/></svg>';
  button.append(symbol, node('span', 'cover-label', 'Смотреть видео'));
  const panel = node('div', 'video-panel');
  const controls = node('div', 'video-controls');
  const go = destination => {
    if (!destination || !scroller.contains(container)) return;
    if (!courseView?.isCurrent()) { courseView?.refresh(); return; }
    if (destination.activate) { destination.activate(); return; }
    stopCourseMedia(scroller);
    location.assign(destination.href);
  };
  for (const [destination, label, path] of [
    [navigation.previous, navigation.previous?.activate ? 'Предыдущее видео' : 'Предыдущий урок', 'M5 5h3v14H5zm14 0v14L8 12Z'],
    [navigation.next, navigation.next?.activate ? 'Следующее видео' : 'Следующий урок', 'M16 5h3v14h-3zM5 5l11 7-11 7Z'],
  ]) {
    const arrow = node('button', 'skip-button');
    arrow.type = 'button'; arrow.disabled = !destination;
    arrow.setAttribute('aria-label', destination ? `${label}: ${destination.title}` : `${label} отсутствует`);
    arrow.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    arrow.addEventListener('click', () => go(destination));
    controls.append(arrow);
  }
  panel.append(controls);
  const reset = () => { stopCourseMedia(stage); stage.replaceChildren(button); };
  container.courseReset = reset;
  button.addEventListener('click', () => {
    if (!scroller.contains(button)) return;
    if (!courseView?.isCurrent()) { courseView?.refresh(); return; }
    for (const player of scroller.querySelectorAll('video')) player.pause();
    for (const item of scroller.querySelectorAll('.course-video-item')) {
      if (item !== container && item.courseReset) item.courseReset();
    }
    const player = document.createElement('iframe');
    player.className = 'course-video-element';
    player.title = total > 1 ? `Видео ${index + 1}` : 'Видео урока';
    player.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    player.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write');
    player.setAttribute('allowfullscreen', '');
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    player.src = video.url;
    player.addEventListener('error', () => {
      reset();
      panel.append(mediaNote('Не удалось открыть видео. Попробуйте ещё раз.'));
    });
    stage.replaceChildren(player);
  });
  stage.append(button);
  container.append(stage, panel);
  return container;
}

function renderLesson(data) {
  const lesson = data.lesson;
  if (!lesson || !positiveId(lesson.lessonId) || String(lesson.lessonId) !== String(lessonId) ||
      !positiveId(lesson.productId) || String(lesson.productId) !== String(productId) ||
      typeof lesson.title !== 'string' || !Array.isArray(lesson.blocks) ||
      typeof lesson.videoAvailable !== 'boolean' || typeof lesson.contentCopyDisabled !== 'boolean' ||
      typeof lesson.hasAssignment !== 'boolean' || lesson.assignmentAvailable !== false) throw new Error('invalid_response');
  const course = validateCourse(data.navigation, productId);
  const section = course.sections.find(item => item.lessons.some(row => String(row.lessonId) === String(lessonId)));
  if (!section) throw Object.assign(new Error('lesson_not_in_course'), { status: 403 });
  const courseNavigator = productId === '4302509' && lessonId === '347472344'
    ? buildCourseNavigator(course, lessonId, program) : null;
  const coverTopic = courseLessonTopic(lesson, [section.title], productId).split('/')[0];
  const ordered = course.sections.flatMap(item => item.lessons.map(row => ({ ...row, sectionId: item.streamId })));
  const lessonIndex = ordered.findIndex(row => String(row.lessonId) === String(lessonId));
  const next = ordered[lessonIndex + 1];
  const previous = ordered[lessonIndex - 1];
  const target = row => row ? { href: lessonUrl(productId, row.lessonId, row.sectionId, program), title: row.title } : null;
  const videos = [];
  for (const [blockIndex, block] of lesson.blocks.entries()) {
    if (block?.type !== 'video' || !Array.isArray(block.videos)) continue;
    for (const [index, video] of block.videos.entries()) {
      const key = JSON.stringify([blockIndex, block.text, index]);
      const favoriteId = /^[a-f0-9]{64}$/.test(video?.favoriteId) ? video.favoriteId : null;
      const title = courseVideoTopic(lesson.blocks, blockIndex, lesson.title);
      videos.push({ key, title, favoriteId, playable: playableVideo(video, lesson.videoAvailable) });
    }
  }
  if (selectedVideoKey === undefined || (selectedVideoKey !== null && !videos.some(item => item.key === selectedVideoKey))) {
    selectedVideoKey = (requestedVideo === null ? videos[0] : videos.find(item => item.favoriteId === requestedVideo))?.key ?? null;
  }
  const unavailableVideo = mediaNote('Сохранённое видео больше недоступно.');
  const videoNodes = new Map(), topicButtons = new Map();
  function updateFavorite() {
    const index = videos.findIndex(item => item.key === selectedVideoKey);
    const item = videos[index];
    if (!item?.playable || !item.favoriteId) { setFavorite(null); return; }
    const title = videos.filter(video => video.title === item.title).length > 1
      ? `${item.title.slice(0, 480)} · Видео ${index + 1}` : item.title.slice(0, 500);
    setFavorite({ id: `course:${productId}:${lessonId}:${item.favoriteId}`, title });
  }
  function selectVideo(key) {
    if (!courseView?.isCurrent()) { courseView?.refresh(); return; }
    selectedVideoKey = key;
    unavailableVideo.remove();
    updateFavorite();
    for (const [id, section] of videoNodes) {
      const active = id === key;
      if (!active) {
        if (document.fullscreenElement && section.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {});
        for (const player of section.querySelectorAll('video')) player.pause();
        section.querySelector('.course-video-item')?.courseReset?.();
      }
      section.hidden = !active;
      const button = topicButtons.get(id);
      if (active) button?.setAttribute('aria-current', 'true');
      else button?.removeAttribute('aria-current');
    }
  }
  const videoTarget = item => item ? { title: item.title, activate: () => selectVideo(item.key) } : null;
  const { byVideo: lessonChapters, tableIndexes: chapterTableIndexes } = courseChapters(lesson.blocks);

  const atRoot = String(section.streamId) === String(course.rootStreamId);
  const backText = fromFavorites ? 'В избранное' : thematicBack ? 'К урокам по теме' : freeLesson ? 'На главную' : atRoot ? 'К программе курса' : 'К урокам раздела';
  back.href = fromFavorites ? 'favorites.html' : thematicBack ?? (freeLesson ? 'index.html' : courseUrl(productId, atRoot ? undefined : section.streamId, program));
  back.setAttribute('aria-label', backText);
  const fragment = document.createDocumentFragment();
  const restoreJobs = [];
  const positions = pendingVideoPositions;
  const intro = document.createElement('section');
  intro.className = 'reader-section reader-intro';
  intro.append(node('p', 'course-lesson-section', section.title));
  const heading = document.createElement('h1');
  heading.textContent = lesson.title;
  intro.append(heading);
  fragment.append(intro);
  const videoHero = node('div', 'course-video-hero');
  const about = node('section', 'course-tab-panel');
  about.id = 'course-about';
  const materials = node('section', 'course-tab-panel');
  materials.id = 'course-materials';
  const tabs = node('div', 'course-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Содержание урока');
  const hasMaterials = lesson.blocks.some(block => block?.type === 'image' || block?.type === 'attachment');
  const tabItems = [['about', 'Об уроке', about]];
  if (hasMaterials) tabItems.push(['materials', 'Материалы', materials]);
  if (!hasMaterials) selectedTab = 'about';
  function selectTab(id) {
    selectedTab = id;
    tabItems.forEach(([key, , panel]) => {
      const button = document.getElementById(`course-tab-${key}`);
      button?.setAttribute('aria-selected', String(key === id));
      if (button) button.tabIndex = key === id && !button.disabled ? 0 : -1;
      panel.hidden = key !== id;
    });
    // Videos below the tabs must not keep playing in a hidden panel.
    if (id === 'materials') for (const video of about.querySelectorAll('video')) video.pause();
    if (id === 'materials') for (const frame of about.querySelectorAll('iframe')) {
      const item = frame.closest('.course-video-item');
      frame.removeAttribute('src');
      item?.courseReset?.();
    }
  }
  tabItems.forEach(([key, label, panel], index) => {
    const button = node('button', 'course-tab', label);
    button.id = `course-tab-${key}`;
    button.type = 'button';
    button.disabled = tabItems.length === 1;
    if (button.disabled) button.style.cursor = 'default';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    button.addEventListener('click', () => selectTab(key));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabItems.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabItems.length) % tabItems.length;
      selectTab(tabItems[target][0]);
      tabs.children[target].focus();
    });
    tabs.append(button);
  });
  const topics = node('section', 'reader-section course-subtopics');
  topics.setAttribute('aria-label', 'Подтемы урока');
  const savedVideoMissing = requestedVideo !== null && selectedVideoKey === null;
  const showTopics = videos.length > 1 || (savedVideoMissing && videos.length > 0);
  if (savedVideoMissing) videoHero.append(unavailableVideo);
  if (showTopics) {
    topics.append(node('h2', '', 'Подтемы урока'));
    const list = node('ol', 'course-subtopic-list');
    for (const [index, item] of videos.entries()) {
      const row = node('li');
      const button = node('button', 'course-subtopic-button', `${index + 1}. ${item.title}`);
      button.type = 'button';
      button.setAttribute('aria-controls', `course-subtopic-${index + 1}`);
      if (item.key === selectedVideoKey) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => selectVideo(item.key));
      topicButtons.set(item.key, button);
      row.append(button); list.append(row);
    }
    topics.append(list);
  }
  for (const [blockIndex, block] of lesson.blocks.entries()) {
    if (chapterTableIndexes.has(blockIndex)) continue;
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
      if (!Array.isArray(block.videos)) throw new Error('invalid_response');
      if (block.text) {
        const text = document.createElement('p');
        text.className = 'course-video-caption';
        text.textContent = block.text;
        section.append(text);
      }
      if (!block.videos.length) section.append(mediaNote('Видео пока недоступно.'));
      for (const [index, video] of block.videos.entries()) {
        if (!video || typeof video !== 'object' ||
            (!['getcourse', 'youtube', 'rutube'].includes(video.provider) &&
              !(video.provider === 'unknown' && video.url === null)) ||
            !(video.url === null || typeof video.url === 'string')) throw new Error('invalid_response');
        const key = JSON.stringify([blockIndex, block.text, index]);
        const videoIndex = videos.findIndex(item => item.key === key);
        const item = videos[videoIndex];
        const part = node('section', 'reader-section course-content-block course-subtopic-video');
        part.id = `course-subtopic-${videoIndex + 1}`;
        part.hidden = key !== selectedVideoKey;
        part.setAttribute('aria-label', item.title);
        part.append(node('p', 'course-video-caption', item.title));
        part.append(node('p', 'course-video-description', courseVideoDescription({
          blocks: lesson.blocks, blockIndex, title: item.title, lessonTitle: lesson.title,
          chapters: lessonChapters.get(blockIndex) || [],
        })));
        const playerNavigation = {
          previous: videoTarget(videos[videoIndex - 1]) || target(previous),
          next: videoTarget(videos[videoIndex + 1]) || target(next), title: item.title,
        };
        part.append(videoPlayer(video, index, block.videos.length, lesson.videoAvailable,
          key, positions, restoreJobs, playerNavigation, lessonChapters.get(blockIndex) || [], coverTopic));
        videoNodes.set(key, part);
        videoHero.append(part);
      }
    } else if (block.type === 'image' && block.imageUrl) {
      const image = document.createElement('img');
      image.className = 'course-material-image';
      image.alt = block.text || 'Иллюстрация к уроку';
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        const note = node('p', 'course-media-note');
        note.textContent = 'Не удалось загрузить изображение.';
        image.replaceWith(note);
      }, { once: true });
      image.src = block.imageUrl;
      section.append(image);
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
    if (section.childNodes.length) {
      if (block.type === 'video') { if (!block.videos.length) videoHero.append(section); }
      else if (block.type === 'image' || block.type === 'attachment') materials.append(section);
      else about.append(section);
    }
  }
  if (!lesson.blocks.length) {
    const section = document.createElement('section');
    section.className = 'reader-section';
    const message = document.createElement('p');
    message.textContent = 'Материалов в этом уроке пока нет.';
    section.append(message);
    about.append(section);
  }
  if (lesson.hasAssignment && !lesson.assignmentAvailable) {
    const section = document.createElement('section');
    section.className = 'reader-section';
    const message = document.createElement('p');
    message.className = 'course-media-note';
    message.textContent = 'В этом уроке есть задание. Выполнение задания в приложении пока недоступно.';
    section.append(message);
    about.append(section);
  }
  if (!about.childNodes.length) about.append(sectionWithMessage('Описание этого урока пока не добавлено.', 'Об уроке'));
  if (courseNavigator) {
    const source = node('details', 'reader-section course-navigator-source');
    source.append(node('summary', '', 'Подробное описание тем'), ...about.childNodes);
    about.append(courseNavigator, source);
  }
  fragment.append(videoHero);
  if (showTopics) fragment.append(topics);
  if (courseNavigator && !hasMaterials) {
    about.removeAttribute('role');
    about.removeAttribute('aria-labelledby');
  } else fragment.append(tabs);
  fragment.append(about);
  if (hasMaterials) fragment.append(materials);
  const navigation = node('section', 'reader-section course-lesson-navigation');
  if (next) {
    navigation.append(node('h2', '', 'Следующий урок'), node('p', '', next.title),
      primaryLink('Следующий урок', lessonUrl(productId, next.lessonId, next.sectionId, program)));
  } else navigation.append(primaryLink(freeLesson ? 'На главную' : 'К программе курса', freeLesson ? 'index.html' : courseUrl(productId, undefined, program)));
  fragment.append(navigation);
  stopCourseMedia(scroller);
  scroller.replaceChildren(fragment);
  selectTab(selectedTab);
  updateFavorite();
  pendingVideoPositions = new Map();
  for (const restore of restoreJobs) restore();
  scroller.removeAttribute('aria-busy');
  scroller.classList.toggle('course-copy-disabled', lesson.contentCopyDisabled);
  toolbar.textContent = backText;
  document.title = lesson.title;
}

if (!positiveId(productId) || !positiveId(lessonId)) {
  showError({ status: 404 }, () => location.assign(courseListUrl(program)));
} else {
  courseView = createCourseView({
    url: `/api/auth/courses/${productId}/lessons/${lessonId}`,
    relatedUrl: freeLesson ? null : `/api/auth/courses/${productId}`,
    clear: reason => {
      setFavorite(null);
      if (reason === 'refresh' && document.visibilityState === 'visible') pendingVideoPositions = currentVideoPositions();
      else if (reason !== 'render') pendingVideoPositions = new Map();
      stopCourseMedia(scroller);
      scroller.replaceChildren();
      scroller.classList.remove('course-copy-disabled');
      scroller.setAttribute('aria-busy', 'true');
      document.title = 'Урок';
    },
    loading: () => scroller.replaceChildren(sectionWithMessage('Проверяем доступ к уроку…')),
    render: renderLesson,
    error: showError,
  });
  courseView.start();
}
