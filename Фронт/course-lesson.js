import { createCourseView, courseErrorText, positiveId, stopCourseMedia, resumeCourseVideo, queueCourseVideoRestore } from './course-views.js?v=20261024-paid-video';

const params = new URLSearchParams(location.search);
const productId = params.get('course');
const lessonId = params.get('courseLesson');
const scroller = document.querySelector('.reader-scroll');
const toolbar = document.querySelector('.reader-toolbar > span');
const back = document.querySelector('[data-reader-return]');
const progress = document.querySelector('.reader-progress');
let courseView = null;
let pendingVideoPositions = new Map();
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

function getcoursePlayer(video, container, key, saved = null) {
  const player = document.createElement('video');
  player.className = 'course-video-element';
  player.courseVideoKey = key;
  player.controls = true;
  player.playsInline = true;
  player.preload = saved ? 'metadata' : 'none';
  player.addEventListener('error', () => {
    stopCourseMedia(container);
    container.replaceChildren(mediaNote('Не удалось открыть видео.'));
  });
  if (saved) resumeCourseVideo(player, saved, () => scroller.contains(player)
    && document.visibilityState === 'visible' && courseView?.isCurrent()
    && player.getAttribute('src') === saved.url);
  return player;
}

function videoPlayer(video, index, total, available, key, positions, restoreJobs) {
  const container = document.createElement('div');
  container.className = 'course-video-item';
  if (!playableVideo(video, available)) {
    container.append(mediaNote(total > 1 ? `Видео ${index + 1} пока недоступно.` : 'Видео пока недоступно.'));
    return container;
  }
  const saved = video.provider === 'getcourse' ? positions.get(key) : null;
  if (saved?.url === video.url) {
    const player = getcoursePlayer(video, container, key, saved);
    container.append(player);
    restoreJobs.push(() => queueCourseVideoRestore(player, video.url, () =>
      scroller.contains(player) && document.visibilityState === 'visible' && courseView?.isCurrent()));
    return container;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reader-button course-video-start';
  button.textContent = total > 1 ? `Смотреть видео ${index + 1}` : 'Смотреть видео';
  button.addEventListener('click', () => {
    if (!scroller.contains(button)) return;
    if (!courseView?.isCurrent()) { courseView?.refresh(); return; }
    if (video.provider === 'getcourse') {
      const player = getcoursePlayer(video, container, key);
      player.src = video.url;
      container.replaceChildren(player);
      const started = player.play();
      if (started && typeof started.catch === 'function') started.catch(() => {});
    } else {
      const player = document.createElement('iframe');
      player.className = 'course-video-element';
      player.title = total > 1 ? `Видео ${index + 1}` : 'Видео урока';
      player.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      player.setAttribute('allow', 'fullscreen; picture-in-picture');
      player.setAttribute('allowfullscreen', '');
      player.referrerPolicy = 'strict-origin-when-cross-origin';
      player.src = video.url;
      player.addEventListener('error', () => {
        stopCourseMedia(container);
        container.replaceChildren(mediaNote('Не удалось открыть видео.'));
      });
      container.replaceChildren(player);
    }
  });
  container.append(button);
  return container;
}

function renderLesson(data) {
  const lesson = data.lesson;
  if (!lesson || !positiveId(lesson.lessonId) || String(lesson.lessonId) !== String(lessonId) ||
      !positiveId(lesson.productId) || String(lesson.productId) !== String(productId) ||
      typeof lesson.title !== 'string' || !Array.isArray(lesson.blocks) ||
      typeof lesson.videoAvailable !== 'boolean' || typeof lesson.contentCopyDisabled !== 'boolean' ||
      typeof lesson.hasAssignment !== 'boolean' || lesson.assignmentAvailable !== false) throw new Error('invalid_response');
  const fragment = document.createDocumentFragment();
  const restoreJobs = [];
  const positions = pendingVideoPositions;
  const intro = document.createElement('section');
  intro.className = 'reader-section reader-intro';
  const heading = document.createElement('h1');
  heading.textContent = lesson.title;
  intro.append(heading);
  fragment.append(intro);
  for (const [blockIndex, block] of lesson.blocks.entries()) {
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
          key, positions, restoreJobs));
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
    if (section.childNodes.length) fragment.append(section);
  }
  if (!lesson.blocks.length) {
    const section = document.createElement('section');
    section.className = 'reader-section';
    const message = document.createElement('p');
    message.textContent = 'Материалов в этом уроке пока нет.';
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
  stopCourseMedia(scroller);
  scroller.replaceChildren(fragment);
  pendingVideoPositions = new Map();
  for (const restore of restoreJobs) restore();
  scroller.removeAttribute('aria-busy');
  scroller.classList.toggle('course-copy-disabled', lesson.contentCopyDisabled);
  toolbar.textContent = 'Урок';
  document.title = lesson.title;
}

if (!positiveId(productId) || !positiveId(lessonId)) {
  showError({ status: 404 }, () => location.assign('my-courses.html'));
} else {
  courseView = createCourseView({
    url: `/api/auth/courses/${productId}/lessons/${lessonId}`,
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
