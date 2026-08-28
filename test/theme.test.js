const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Theme = require('../public/theme.js');

// Duck-typed stubs, same style as makeTestDb() in test/onboardingService.test.js.
function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    _data: data,
  };
}

function makeThrowingStorage(which) {
  return {
    getItem: () => { if (which === 'get') throw new Error('storage disabled'); return null; },
    setItem: () => { if (which === 'set') throw new Error('storage disabled'); },
  };
}

function makeDoc() {
  const calls = [];
  return {
    documentElement: {
      setAttribute: (name, value) => calls.push(['set', name, value]),
      removeAttribute: (name) => calls.push(['remove', name]),
    },
    _calls: calls,
  };
}

describe('readPreference', () => {
  test('returns "system" when nothing is stored', () => {
    assert.equal(Theme.readPreference(makeStorage()), 'system');
  });

  test('returns the stored value when it is valid', () => {
    assert.equal(Theme.readPreference(makeStorage({ [Theme.STORAGE_KEY]: 'light' })), 'light');
    assert.equal(Theme.readPreference(makeStorage({ [Theme.STORAGE_KEY]: 'dark' })), 'dark');
  });

  test('falls back to "system" for an invalid stored value', () => {
    assert.equal(Theme.readPreference(makeStorage({ [Theme.STORAGE_KEY]: 'blue' })), 'system');
  });

  test('falls back to "system" when storage.getItem throws', () => {
    assert.equal(Theme.readPreference(makeThrowingStorage('get')), 'system');
  });
});

describe('writePreference', () => {
  test('writes a valid value under STORAGE_KEY', () => {
    const storage = makeStorage();
    Theme.writePreference(storage, 'dark');
    assert.equal(storage._data[Theme.STORAGE_KEY], 'dark');
  });

  test('throws TypeError for an invalid value and does not write', () => {
    const storage = makeStorage();
    assert.throws(() => Theme.writePreference(storage, 'blue'), TypeError);
    assert.equal(Theme.STORAGE_KEY in storage._data, false);
  });

  test('swallows storage.setItem exceptions', () => {
    assert.doesNotThrow(() => Theme.writePreference(makeThrowingStorage('set'), 'light'));
  });
});

describe('resolveTheme', () => {
  test('"light" resolves to "light" regardless of system preference', () => {
    assert.equal(Theme.resolveTheme('light', true), 'light');
    assert.equal(Theme.resolveTheme('light', false), 'light');
  });

  test('"dark" resolves to "dark" regardless of system preference', () => {
    assert.equal(Theme.resolveTheme('dark', true), 'dark');
    assert.equal(Theme.resolveTheme('dark', false), 'dark');
  });

  test('"system" resolves based on prefersDark', () => {
    assert.equal(Theme.resolveTheme('system', true), 'dark');
    assert.equal(Theme.resolveTheme('system', false), 'light');
  });

  test('throws for an invalid preference', () => {
    assert.throws(() => Theme.resolveTheme('blue', true), TypeError);
  });
});

describe('applyPreference', () => {
  test('"light" sets data-theme="light"', () => {
    const doc = makeDoc();
    Theme.applyPreference(doc, 'light');
    assert.deepEqual(doc._calls, [['set', 'data-theme', 'light']]);
  });

  test('"dark" sets data-theme="dark"', () => {
    const doc = makeDoc();
    Theme.applyPreference(doc, 'dark');
    assert.deepEqual(doc._calls, [['set', 'data-theme', 'dark']]);
  });

  test('"system" removes the data-theme attribute instead of setting one', () => {
    const doc = makeDoc();
    Theme.applyPreference(doc, 'system');
    assert.deepEqual(doc._calls, [['remove', 'data-theme']]);
  });

  test('throws for an invalid preference', () => {
    assert.throws(() => Theme.applyPreference(makeDoc(), 'blue'), TypeError);
  });
});

describe('setPreference', () => {
  test('writes the preference and applies it to the document', () => {
    const storage = makeStorage();
    const doc = makeDoc();
    const win = { localStorage: storage, document: doc };
    Theme.setPreference(win, 'dark');
    assert.equal(storage._data[Theme.STORAGE_KEY], 'dark');
    assert.deepEqual(doc._calls, [['set', 'data-theme', 'dark']]);
  });
});
