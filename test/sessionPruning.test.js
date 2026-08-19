const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { pruneExpiredSessions } = require('../middleware/auth');

// Isolated in-memory DB per test, shaped like the real sessions table (see db.js), so pruning
// logic is verified against real SQL rather than a mock.
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
  `);
  return db;
}

test('pruneExpiredSessions deletes only sessions past their expiry', () => {
  const db = makeTestDb();
  const past = new Date(Date.now() - 60000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('expired-1', 1, past);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('expired-2', 1, past);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('still-valid', 1, future);

  pruneExpiredSessions(db);

  const remaining = db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
  assert.deepEqual(remaining, ['still-valid']);
});

test('pruneExpiredSessions is a no-op when nothing is expired', () => {
  const db = makeTestDb();
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('still-valid', 1, future);

  pruneExpiredSessions(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('pruneExpiredSessions handles an already-empty table without error', () => {
  const db = makeTestDb();
  assert.doesNotThrow(() => pruneExpiredSessions(db));
});
