async function requestCourse(path) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error('course_unavailable'), { status: response.status });
  return response.json();
}

// Identifiers only. The existing lesson API remains responsible for purchase,
// schedule, stop-lesson and session checks and for issuing video addresses.
export const schoolVideoRoutes = Object.freeze({
  'back-practice': { title: 'Расслабление спины', lessons: [347472590, 347529530] },
  breathing: { title: 'Дыхательная практика', lessons: [347472707, 347531402] },
  'practice-article': { title: 'Расслабление тазового дна', lessons: [] },
  'birth-course': { title: 'Подготовка к родам', lessons: [347472356, 347529855] },
  'back-course': { title: 'Здоровая спина', lessons: [347472656] },
  'confidence-course': { title: 'Эмоциональная уверенность', lessons: [347472380, 347529451] },
  'baby-course': { title: 'Уход за малышом', lessons: [347472434, 347529601] },
  'baby-birth-lesson': { title: 'Как малыш проходит через родовые пути', lessons: [347472363, 347529862] },
  webinars: { title: 'Запись вебинара', lessons: [348997994] },
});

const productsByLesson = {
  347472590: [4302509, 4302552], 347529530: [4309095],
  347472707: [4302509], 347531402: [4309095],
  347472356: [4302509], 347529855: [4309095],
  347472656: [4302509],
  347472380: [4302509], 347529451: [4309095],
  347472434: [4302509], 347529601: [4309095, 4307012],
  347472363: [4302509], 347529862: [4309095],
  348997994: [4302509],
};

export async function resolveSchoolVideo(id, request = requestCourse) {
  const route = Object.hasOwn(schoolVideoRoutes, id) ? schoolVideoRoutes[id] : null;
  if (!route || !route.lessons.length) return { state: 'missing', route };
  if (id === 'breathing') return { state: 'available', href: 'article.html?courseLesson=347472707&course=4302509' };
  const { courses } = await request('/api/auth/courses');
  if (!Array.isArray(courses)) throw new Error('invalid_response');
  const owned = new Set(courses.map(course => course.productId));
  const products = [...new Set(route.lessons.flatMap(lesson => productsByLesson[lesson]))];
  for (const productId of products.filter(product => owned.has(product))) {
    let data;
    try { data = await request(`/api/auth/courses/${productId}`); }
    catch (error) {
      if (error.status === 403 || error.status === 404) continue;
      throw error;
    }
    if (data.course?.productId !== productId || !Array.isArray(data.course.sections)) throw new Error('invalid_response');
    for (const lessonId of route.lessons) {
      if (!productsByLesson[lessonId].includes(productId)) continue;
      const section = data.course.sections.find(section => Array.isArray(section.lessons)
        && section.lessons.some(lesson => lesson.lessonId === lessonId && lesson.hasVideo === true));
      if (section && Number.isSafeInteger(section.streamId) && section.streamId > 0) {
        return { state: 'available', href: `article.html?courseLesson=${lessonId}&course=${productId}&section=${section.streamId}` };
      }
    }
  }
  return { state: 'locked', route };
}

export async function mountSchoolVideo(id) {
  const route = Object.hasOwn(schoolVideoRoutes, id) ? schoolVideoRoutes[id] : null;
  document.title = route?.title || 'Видео не найдено';
  document.querySelector('#video-title').textContent = document.title;
  document.querySelector('.video-header p').textContent = 'Видео школы';
  document.querySelector('.video-favorite')?.remove();
  document.querySelector('.video-stage').hidden = true;
  const panel = document.querySelector('.video-panel');
  panel.setAttribute('aria-labelledby', 'video-title');
  const status = document.createElement('p');
  status.className = 'step-description';
  status.setAttribute('role', 'status');
  status.textContent = 'Проверяем доступ к уроку…';
  panel.replaceChildren(status);
  document.querySelector('.video-app').removeAttribute('data-video-pending');
  try {
    const result = await resolveSchoolVideo(id);
    if (result.state === 'available') {
      const destination = new URL(result.href, location.href);
      if (id === 'breathing' && new URLSearchParams(location.search).get('from') === 'index') {
        destination.searchParams.set('from', 'index-breathing');
      }
      location.replace(destination.href);
      return;
    }
    status.textContent = result.state === 'missing'
      ? route ? 'Видео «Расслабление тазового дна» пока не добавлено.' : 'Видео по этой ссылке не найдено.'
      : 'Этот урок входит в платный курс. Сейчас доступ к нему не подтверждён: проверьте покупку и условия открытия урока.';
    if (result.state === 'locked') {
      const link = document.createElement('a');
      link.className = 'video-login'; link.href = 'courses.html'; link.textContent = 'Посмотреть тарифы';
      panel.append(link);
    }
  } catch (error) {
    status.textContent = error.status === 401 ? 'Войдите, чтобы открыть урок.'
      : 'Не удалось проверить доступ. Попробуйте ещё раз.';
  }
  const retry = document.createElement('button');
  retry.type = 'button'; retry.className = 'video-login'; retry.textContent = 'Повторить проверку';
  retry.addEventListener('click', () => mountSchoolVideo(id));
  if (route?.lessons.length) panel.append(retry);
}
