/* ============================================================
   Theme (Sunrise/Sunset) logic — isomorphic so the same file is
   require()-able from test/theme.test.js and loadable via a plain
   <script> tag in the browser, with no build step either way.
   Internal preference values stay conventional ('light'/'dark'/
   'system'); only the Settings UI labels say Sunrise/Sunset.
   ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Theme = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const STORAGE_KEY = 'balibay-theme-preference';
  const PREFERENCES = ['light', 'dark', 'system'];

  function assertValidPreference(preference) {
    if (!PREFERENCES.includes(preference)) {
      throw new TypeError(`Invalid theme preference: ${preference}`);
    }
  }

  function readPreference(storage) {
    try {
      const stored = storage.getItem(STORAGE_KEY);
      if (PREFERENCES.includes(stored)) return stored;
    } catch (e) {
      // Storage disabled/unavailable (private mode, etc.) — fall through to default.
    }
    return 'system';
  }

  function writePreference(storage, preference) {
    assertValidPreference(preference);
    try {
      storage.setItem(STORAGE_KEY, preference);
    } catch (e) {
      // Quota/private-mode failures shouldn't crash the page over a preference save.
    }
  }

  function resolveTheme(preference, prefersDark) {
    assertValidPreference(preference);
    if (preference === 'system') return prefersDark ? 'dark' : 'light';
    return preference;
  }

  function applyPreference(doc, preference) {
    assertValidPreference(preference);
    if (preference === 'system') {
      doc.documentElement.removeAttribute('data-theme');
    } else {
      doc.documentElement.setAttribute('data-theme', preference);
    }
  }

  function setPreference(win, preference) {
    writePreference(win.localStorage, preference);
    applyPreference(win.document, preference);
  }

  function initTheme(win) {
    applyPreference(win.document, readPreference(win.localStorage));
    win.addEventListener('storage', (e) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      applyPreference(win.document, readPreference(win.localStorage));
    });
  }

  return { STORAGE_KEY, PREFERENCES, readPreference, writePreference, resolveTheme, applyPreference, setPreference, initTheme };
});
