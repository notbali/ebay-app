const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { getUpdateById } = require('../services/updatesService');

// Isolated in-memory DB per test, shaped like the real updates table (see db.js).
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author_user_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function seedUpdate(db, overrides = {}) {
  const update = { title: 'Faster uploads', body: 'Photo uploads now process in parallel.', author_user_id: 1, ...overrides };
  const info = db.prepare('INSERT INTO updates (title, body, author_user_id) VALUES (?, ?, ?)')
    .run(update.title, update.body, update.author_user_id);
  return info.lastInsertRowid;
}

test('getUpdateById returns the matching row', () => {
  const db = makeTestDb();
  const id = seedUpdate(db, { title: 'Onboarding checklist', body: 'New accounts now see a getting-started checklist.' });

  const result = getUpdateById(db, id);

  assert.equal(result.id, id);
  assert.equal(result.title, 'Onboarding checklist');
  assert.equal(result.body, 'New accounts now see a getting-started checklist.');
  assert.ok(result.created_at);
});

test('getUpdateById returns undefined for a non-existent id', () => {
  const db = makeTestDb();
  seedUpdate(db);

  const result = getUpdateById(db, 999);

  assert.equal(result, undefined);
});

test('getUpdateById does not leak the author_user_id column', () => {
  const db = makeTestDb();
  const id = seedUpdate(db, { author_user_id: 42 });

  const result = getUpdateById(db, id);

  assert.equal('author_user_id' in result, false);
});
