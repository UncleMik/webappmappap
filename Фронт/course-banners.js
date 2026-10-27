// Verified GetCourse data-training-image snapshot, 2026-10-27.
const productBanners = {
  "4309095": "935386893",
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
  "935397478": "935386893",
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
