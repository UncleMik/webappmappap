// Only these three originals were approved for unprotected, free playback.
// Permanent file addresses resolve fresh CDN redirects; never store signed player URLs.
const sources = Object.freeze({
  'contractions-lesson': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/300/h/f4790cf21fbfe47b405df26fce8f5136.mp4',
  'back-relief-video': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/80/h/551f66a3fdd9feefd7aedc7d47d6eaac.mp4',
  'birth-breathing-video': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/399/h/fed8d00c6cdd8fb90e65830df8df28b4.mp4',
});
export const weeklyVideoSource = id => Object.hasOwn(sources, id) ? sources[id] : null;
