/* Browser preview values never grant access to a real school account.
   Real purchase entitlements remain a separate GetCourse integration. */
window.courseAccess = Object.freeze({ get: () => null, grant: () => false });
