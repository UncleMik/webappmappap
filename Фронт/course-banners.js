// GetCourse snapshot (2026-10-27); Express 2.0 artwork supplied by the user (2026-11-05).
const productBanners = {
  "4309095": "express-2",
  "4316498": "267352508",
  "4302509": "935386893",
  "4302523": "430799983",
  "4302529": "853459064",
  "4302552": "820572152",
  "4302555": "430799983",
  "4302557": "267352508",
  "4302567": "267352508"
};
const trainingBanners = {
  "935397478": "express-2",
  "935397511": "267352508",
  "935386893": "935386893",
  "935386911": "430799983",
  "935386914": "853459064",
  "935386924": "820572152",
  "935386925": "430799983",
  "935386926": "267352508",
  "935386927": "267352508"
};

export function applyCourseBanner(container, id, kind = 'product') {
  const asset = (kind === 'training' ? trainingBanners : productBanners)[String(id)];
  if (!asset) return;
  const image = document.createElement('img');
  image.className = 'course-banner-image';
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => container.classList.add('has-course-banner'));
  image.addEventListener('error', () => {
    image.remove();
    container.classList.remove('has-course-banner');
  });
  image.src = `assets/course-banners/${asset}.webp`;
  container.append(image);
}

const schoolBanners = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const titleOnRight = new Set([3, 6, 8, 10]);

// Shuffle a full set before repeating a photo, including at the join between sets.
export function* schoolCourseBanners() {
  let previous;
  while (true) {
    const deck = [...schoolBanners];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    if (deck[0] === previous) [deck[0], deck[1]] = [deck[1], deck[0]];
    for (const asset of deck) {
      previous = asset;
      yield asset;
    }
  }
}

export function applySchoolCourseBanner(container, asset, title, headingTag) {
  container.classList.add('school-course-banner');
  if (titleOnRight.has(asset)) container.classList.add('school-course-banner-right');
  const image = document.createElement('img');
  image.className = 'course-banner-image';
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.width = 1200;
  image.height = 800;
  image.src = `assets/course-banners/school-${asset}.webp`;
  image.addEventListener('error', () => image.remove(), { once: true });
  const heading = document.createElement(headingTag);
  heading.className = 'course-banner-title';
  if (title.length > 48) heading.classList.add('course-banner-title-long');
  heading.textContent = title;
  container.append(image, heading);
}
