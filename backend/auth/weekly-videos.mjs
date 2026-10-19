// Only these three originals were approved for unprotected, free playback.
// Permanent file addresses resolve fresh CDN redirects; never store signed player URLs.
const sources = Object.freeze({
  'contractions-lesson': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/475/h/97940f802630331b86e3f992245eb71b.mp4',
  'back-relief-video': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/247/h/b4daa2d9984ce06635cac32c2f479f82.mp4',
  'birth-breathing-video': 'https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/107/h/23417198ee14f7a1c5e4730d685c84de.mp4',
});
export const weeklyVideoSource = id => Object.hasOwn(sources, id) ? sources[id] : null;
