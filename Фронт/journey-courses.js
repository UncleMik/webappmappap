import { createCourseView, courseErrorText, positiveId } from './course-views.js';
import { applyCourseBanner } from './course-banners.js?v=20261027';

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

// Product IDs come from the school's catalogue; a tariff or a demo card is
// never proof that the current account may read a product.
export function courseCards(offers, owned) {
  if (!Array.isArray(offers) || !offers.length || !Array.isArray(owned)) throw new Error('invalid_catalog');
  const products = new Map();
  for (const offer of offers) {
    if (!Array.isArray(offer.items)) throw new Error('invalid_catalog');
    for (const item of offer.items) {
      if (!positiveId(item.productId) || typeof item.title !== 'string' || !item.title.trim()
        || !['training', 'groups'].includes(item.type)) throw new Error('invalid_catalog');
      if (item.type === 'training') products.set(String(item.productId), { productId: item.productId, title: item.title });
    }
  }
  if (!products.size) throw new Error('invalid_catalog');
  const available = new Map();
  for (const course of owned) {
    if (!positiveId(course.productId) || typeof course.title !== 'string' || !course.title.trim()
      || !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0
      || available.has(String(course.productId))) throw new Error('invalid_response');
    available.set(String(course.productId), course);
    // Preserve older purchases even if the product has left current tariffs.
    products.set(String(course.productId), { productId: course.productId, title: course.title });
  }
  return [...products.values()].map(product => ({ ...product, owned: available.has(String(product.productId)),
    lessonCount: available.get(String(product.productId))?.lessonCount }))
    .sort((a, b) => Number(b.owned) - Number(a.owned));
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
  const cards = courseCards(catalog.offers, data.courses);
  const fragment = document.createDocumentFragment();
  for (const course of cards) {
    const card = node('article', 'journey-content-card course-card');
    card.dataset.productId = course.productId;
    card.dataset.access = course.owned ? 'available' : 'locked';
    const photo = node('span', 'course-photo journey-photo');
    photo.setAttribute('style', '--x:282;--y:686;--w:123;--h:45');
    photo.setAttribute('aria-hidden', 'true');
    applyCourseBanner(photo, course.productId);
    if (!course.owned) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'course-lock-icon');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#j-lock');
      icon.append(use);
      photo.append(icon);
    }
    const copy = node('div', 'course-copy');
    copy.append(node('h3', '', course.title), node('p', '', course.owned ? 'Доступен по вашей покупке' : 'Входит в программу школы'));
    const link = node('a', 'journey-primary', course.owned ? 'Открыть курс' : 'Открыть доступ');
    link.href = course.owned ? `my-courses.html?course=${encodeURIComponent(course.productId)}` : 'courses.html';
    link.setAttribute('aria-label', `${course.owned ? 'Открыть курс' : 'Открыть доступ'}: ${course.title}`);
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
    courseCards(catalog.offers, []);
    createCourseView({ url: '/api/auth/courses', clear, loading, render, error }).start();
  } catch (caught) {
    error(caught, start);
  } finally {
    pending = false;
  }
}

start();
