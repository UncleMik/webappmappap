// Accept only existing application pages in this directory, never another origin.
export function returnPage(raw, base = location.href) {
  const fallback = new URL('index.html', base);
  if (typeof raw !== 'string' || !raw || /[\\\x00-\x20]/.test(raw)) return fallback.href;
  try {
    const next = new URL(raw, base);
    const directory = new URL('.', base);
    const file = next.pathname.slice(directory.pathname.length);
    const pages = ['index.html', 'journey.html', 'ai.html', 'club.html', 'club-chat.html',
      'profile.html', 'personal-data.html', 'articles.html', 'article.html', 'baby.html',
      'mom.html', 'courses.html', 'my-courses.html', 'video.html'];
    if (next.origin !== directory.origin || !next.pathname.startsWith(directory.pathname) ||
        (file && !pages.includes(file))) return fallback.href;
    next.searchParams.delete('_app');
    return next.href;
  } catch { return fallback.href; }
}
