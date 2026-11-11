// Presentation groups use the school's offer composition, never grant access.
const programIds = [8835218, 8835266, 8835331];
const validId = value => Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/.test(String(value));

export const programUrl = offerId => `my-courses.html?offer=${encodeURIComponent(offerId)}`;
export const programsUrl = 'my-courses.html?programs=1';

export function programCards(offers, owned) {
  if (!Array.isArray(offers) || offers.length !== 3) throw new Error('invalid_catalog');
  if (!Array.isArray(owned)) throw new Error('invalid_response');
  const available = new Map();
  for (const course of owned) {
    if (!course || !validId(course.productId) || available.has(String(course.productId))
      || typeof course.title !== 'string' || !course.title.trim()
      || !Number.isSafeInteger(course.lessonCount) || course.lessonCount < 0) throw new Error('invalid_response');
    available.set(String(course.productId), course);
  }
  return programIds.map(offerId => {
    const matches = offers.filter(offer => offer?.offerId === offerId);
    const offer = matches[0];
    if (matches.length !== 1 || typeof offer.displayName !== 'string' || !offer.displayName.trim()
      || !Array.isArray(offer.items) || !offer.items.length) throw new Error('invalid_catalog');
    const ids = new Set();
    const items = offer.items.filter(item => {
      if (!item || !validId(item.productId) || ids.has(String(item.productId))
        || typeof item.title !== 'string' || !item.title.trim()
        || !['training', 'groups'].includes(item.type)) throw new Error('invalid_catalog');
      ids.add(String(item.productId));
      return item.type === 'training';
    }).map(item => ({ ...item, owned: available.has(String(item.productId)),
      lessonCount: available.get(String(item.productId))?.lessonCount }));
    if (!items.length) throw new Error('invalid_catalog');
    return { offerId, title: offer.displayName, items,
      availableCount: items.filter(item => item.owned).length };
  });
}
