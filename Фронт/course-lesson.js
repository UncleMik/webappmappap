import { courseVideoTopic } from './course-video-topics.js?v=20261027-topic-titles';
import { courseVideoDescription } from './course-video-description.js?v=20261028-descriptions';
import { mountCourseVideo } from './course-video-player.js?v=20261027-subtopics';
import { courseChapters } from './course-video-chapters.js?v=20261026-weekly-style';
import { createCourseView, courseErrorText, positiveId, stopCourseMedia } from './course-views.js?v=20261026-course-layout';
import { node, courseUrl, lessonUrl, validateCourse, primaryLink } from './course-ui.js?v=20261026-course-layout';

const params = new URLSearchParams(location.search);
const productId = params.get('course');
const lessonId = params.get('courseLesson');
const freeLesson = (productId === '4302509' && lessonId === '347472707')
  || (productId === '4309095' && lessonId === '347531402');
const scroller = document.querySelector('.reader-scroll');
const toolbar = document.querySelector('.reader-toolbar > span');
const back = document.querySelector('[data-reader-return]');
const progress = document.querySelector('.reader-progress');
let courseView = null;
let pendingVideoPositions = new Map();
let selectedTab = 'about';
let selectedVideoKey = null;
document.querySelector('.reader-page').classList.add('course-lesson-mode');
progress.hidden = true;
toolbar.textContent = 'Урок';
scroller.setAttribute('aria-label', 'Текст урока');
back.href = positiveId(productId) ? `my-courses.html?course=${encodeURIComponent(productId)}` : 'my-courses.html';
back.setAttribute('aria-label', 'Вернуться к курсу');
toolbar.textContent = 'К программе курса';
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

function videoPlayer(video, index, total, available, key, positions, restoreJobs, navigation, chapters) {
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
  const ordered = course.sections.flatMap(item => item.lessons.map(row => ({ ...row, sectionId: item.streamId })));
  const lessonIndex = ordered.findIndex(row => String(row.lessonId) === String(lessonId));
  const next = ordered[lessonIndex + 1];
  const previous = ordered[lessonIndex - 1];
  const target = row => row ? { href: lessonUrl(productId, row.lessonId, row.sectionId), title: row.title } : null;
  const videos = [];
  for (const [blockIndex, block] of lesson.blocks.entries()) {
    if (block?.type !== 'video' || !Array.isArray(block.videos)) continue;
    for (const [index] of block.videos.entries()) {
      const key = JSON.stringify([blockIndex, block.text, index]);
      videos.push({ key, title: courseVideoTopic(lesson.blocks, blockIndex, lesson.title) });
    }
  }
  if (!videos.some(item => item.key === selectedVideoKey)) selectedVideoKey = videos[0]?.key ?? null;
  const videoNodes = new Map(), topicButtons = new Map();
  function selectVideo(key) {
    if (!courseView?.isCurrent()) { courseView?.refresh(); return; }
    selectedVideoKey = key;
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

  back.href = freeLesson ? 'index.html' : courseUrl(productId, section.streamId);
  back.setAttribute('aria-label', freeLesson ? 'На главную' : 'К урокам раздела');
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
  if (videos.length > 1) {
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
          key, positions, restoreJobs, playerNavigation, lessonChapters.get(blockIndex) || []));
        videoNodes.set(key, part);
        videoHero.append(part);
      }
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
  fragment.append(videoHero);
  if (videos.length > 1) fragment.append(topics);
  fragment.append(tabs, about);
  if (hasMaterials) fragment.append(materials);
  const navigation = node('section', 'reader-section course-lesson-navigation');
  if (next) {
    navigation.append(node('h2', '', 'Следующий урок'), node('p', '', next.title),
      primaryLink('Следующий урок', lessonUrl(productId, next.lessonId, next.sectionId)));
  } else navigation.append(primaryLink(freeLesson ? 'На главную' : 'К программе курса', freeLesson ? 'index.html' : courseUrl(productId)));
  fragment.append(navigation);
  stopCourseMedia(scroller);
  scroller.replaceChildren(fragment);
  selectTab(selectedTab);
  pendingVideoPositions = new Map();
  for (const restore of restoreJobs) restore();
  scroller.removeAttribute('aria-busy');
  scroller.classList.toggle('course-copy-disabled', lesson.contentCopyDisabled);
  toolbar.textContent = freeLesson ? 'На главную' : 'К урокам раздела';
  document.title = lesson.title;
}

if (!positiveId(productId) || !positiveId(lessonId)) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  courseView = createCourseView({
    url: `/api/auth/courses/${productId}/lessons/${lessonId}`,
    relatedUrl: freeLesson ? null : `/api/auth/courses/${productId}`,
    clear: reason => {
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
