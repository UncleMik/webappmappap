import { mountCourseVideo } from './course-video-player.js?v=20261026-weekly-style';
import { courseChapters } from './course-video-chapters.js?v=20261026-weekly-style';
import { createCourseView, courseErrorText, positiveId, stopCourseMedia } from './course-views.js?v=20261026-course-layout';
import { node, courseUrl, lessonUrl, validateCourse, primaryLink } from './course-ui.js?v=20261026-course-layout';

const params = new URLSearchParams(location.search);
const productId = params.get('course');
const lessonId = params.get('courseLesson');
const scroller = document.querySelector('.reader-scroll');
const toolbar = document.querySelector('.reader-toolbar > span');
const back = document.querySelector('[data-reader-return]');
const progress = document.querySelector('.reader-progress');
let courseView = null;
let pendingVideoPositions = new Map();
let selectedTab = 'about';
document.querySelector('.reader-page').classList.add('course-lesson-mode');
progress.hidden = true;
toolbar.textContent = 'Урок';
scroller.setAttribute('aria-label', 'Текст урока');
back.href = positiveId(productId) ? `my-courses.html?course=${encodeURIComponent(productId)}` : 'my-courses.html';
back.setAttribute('aria-label', 'Вернуться к курсу');
toolbar.textContent = 'К программе курса';
toolbar.addEventListener('click', () => back.click());
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
const rutubeVideoUrl = /^https:\/\/rutube\.ru\/play\/embed\/[A-Za-z0-9_-]{1,200}$/;

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
      positions.set(key, { url, time, playing: !player.paused && !player.ended });
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
      isAllowed: () => scroller.contains(container) && courseView?.isCurrent(),
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
    stopCourseMedia(scroller);
    location.assign(destination.href);
  };
  for (const [destination, label, path] of [
    [navigation.previous, 'Предыдущий урок', 'M5 5h3v14H5zm14 0v14L8 12Z'],
    [navigation.next, 'Следующий урок', 'M16 5h3v14h-3zM5 5l11 7-11 7Z'],
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
    player.setAttribute('allow', 'fullscreen; picture-in-picture');
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
  const playerNavigation = { previous: target(previous), next: target(next), title: lesson.title };
  const { byVideo: lessonChapters, tableIndexes: chapterTableIndexes } = courseChapters(lesson.blocks);

  back.href = courseUrl(productId, section.streamId);
  back.setAttribute('aria-label', 'К урокам раздела');
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
  const tabItems = [['about', 'Об уроке', about], ['materials', 'Материалы', materials]];
  function selectTab(id) {
    selectedTab = id;
    tabItems.forEach(([key, , panel]) => {
      const button = document.getElementById(`course-tab-${key}`);
      button?.setAttribute('aria-selected', String(key === id));
      if (button) button.tabIndex = key === id ? 0 : -1;
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
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    button.addEventListener('click', () => selectTab(key));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectTab(tabItems[target][0]);
      tabs.children[target].focus();
    });
    tabs.append(button);
  });
  let hasHero = false;
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
        section.append(videoPlayer(video, index, block.videos.length, lesson.videoAvailable,
          key, positions, restoreJobs, playerNavigation, lessonChapters.get(blockIndex) || []));
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
      if (block.type === 'video' && !hasHero) { videoHero.append(section); hasHero = true; }
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
  if (!materials.childNodes.length) materials.append(sectionWithMessage('Отдельных материалов в этом уроке нет.', 'Материалы'));
  fragment.append(videoHero, tabs, about, materials);
  const navigation = node('section', 'reader-section course-lesson-navigation');
  if (next) {
    navigation.append(node('h2', '', 'Следующий урок'), node('p', '', next.title),
      primaryLink('Следующий урок', lessonUrl(productId, next.lessonId, next.sectionId)));
  } else navigation.append(primaryLink('К программе курса', courseUrl(productId)));
  fragment.append(navigation);
  stopCourseMedia(scroller);
  scroller.replaceChildren(fragment);
  selectTab(selectedTab);
  pendingVideoPositions = new Map();
  for (const restore of restoreJobs) restore();
  scroller.removeAttribute('aria-busy');
  scroller.classList.toggle('course-copy-disabled', lesson.contentCopyDisabled);
  toolbar.textContent = 'К урокам раздела';
  document.title = lesson.title;
}

if (!positiveId(productId) || !positiveId(lessonId)) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  courseView = createCourseView({
    url: `/api/auth/courses/${productId}/lessons/${lessonId}`,
    relatedUrl: `/api/auth/courses/${productId}`,
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
