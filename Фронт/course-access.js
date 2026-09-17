/* Demo access only. Replace with server-verified entitlements for real payments. */
window.courseAccess = {
  get() {
    try {
      const value = JSON.parse(localStorage.getItem('webpril.demoCourseAccess'));
      return value && ['basic', 'optimal', 'premium'].includes(value.plan) ? value : null;
    } catch { return null; }
  },
  grant(plan) {
    if (!['basic', 'optimal', 'premium'].includes(plan)) return false;
    try { localStorage.setItem('webpril.demoCourseAccess', JSON.stringify({plan, demo: true})); return true; }
    catch { return false; }
  }
};
if (document.querySelector('.course-list') && window.courseAccess.get()) {
  document.querySelectorAll('a[href^="courses.html"]').forEach(link => {
    link.href = link.getAttribute('href').replace('courses.html', 'my-courses.html');
    if (link.classList.contains('journey-primary')) {
      link.textContent = 'Продолжить';
      link.setAttribute('aria-label', 'Открыть мои курсы');
    }
  });
  document.querySelectorAll('.course-lock-icon').forEach(icon => { icon.hidden = true; icon.style.display = 'none'; });
}
