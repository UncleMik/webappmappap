import { programCards, programUrl } from './course-programs.js?v=20261111-return';
import { createCourseView, courseErrorText } from './course-views.js?v=20261109-silent-access';
import { applySchoolCourseBanner, schoolCourseBanners } from './course-banners.js?v=20261109-school-covers';

const section = document.querySelector('[aria-labelledby="courses-title"]');
const list = section.querySelector('.course-list');
const status = section.querySelector('.journey-courses-status');
const retry = section.querySelector('.journey-courses-retry');
const arrows = section.querySelectorAll('.round-arrow');
let catalog = null;
let pending = false;

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}


function clear() {
  list.replaceChildren();
  list.scrollLeft = 0;
  list.setAttribute('aria-busy', 'true');
  arrows.forEach(button => { button.hidden = true; });
}

function loading() {
  status.hidden = false;
  status.textContent = 'Проверяем доступ к курсам…';
  retry.hidden = true;
}

function error(caught, again) {
  list.setAttribute('aria-busy', 'false');
  status.hidden = false;
  status.textContent = courseErrorText(caught);
  retry.hidden = false;
  retry.onclick = again;
}

function render(data) {
  const cards = programCards(catalog.offers, data.courses);
  const fragment = document.createDocumentFragment();
  const banners = schoolCourseBanners();
  for (const course of cards) {
    const card = node('article', 'journey-content-card course-card');
    card.dataset.offerId = course.offerId;
    card.dataset.access = course.availableCount ? 'available' : 'locked';
    const photo = node('div', 'course-photo journey-photo');
    applySchoolCourseBanner(photo, banners.next().value, course.title, 'h3');
    if (!course.availableCount) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'course-lock-icon');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#j-lock');
      icon.append(use);
      photo.append(icon);
    }
    const copy = node('div', 'course-copy');
    copy.append(node('p', '', course.availableCount ? 'Есть доступные материалы' : 'Основной курс и бонусы'));
    const link = node('a', 'journey-primary', 'Открыть программу');
    link.href = programUrl(course.offerId, 'journey');
    link.setAttribute('aria-label', `${'Открыть программу'}: ${course.title}`);
    card.append(photo, copy, link);
    fragment.append(card);
  }
  list.replaceChildren(fragment);
  list.setAttribute('aria-busy', 'false');
  status.hidden = true;
  retry.hidden = true;
  arrows.forEach(button => { button.hidden = cards.length < 2; });
}

async function start() {
  if (pending) return;
  pending = true;
  clear();
  loading();
  try {
    const response = await fetch('/api/course-offers', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('catalog_unavailable'), { status: response.status });
    catalog = await response.json();
    programCards(catalog.offers, []);
    createCourseView({ url: '/api/auth/courses', clear, loading, render, error }).start();
  } catch (caught) {
    error(caught, start);
  } finally {
    pending = false;
  }
}

start();
