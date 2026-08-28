const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('../services/authService');
const { changePassword, deleteAccount } = require('../services/accountService');

// Isolated in-memory DB per test, shaped like the real schema (see db.js), so this logic is
// verified against real SQL rather than a mock.
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE ebay_connections (
      user_id INTEGER PRIMARY KEY,
      refresh_token_encrypted TEXT NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ai_title TEXT
    );
    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL
    );
  `);
  return db;
}

function makeUser(db, email = 'seller@example.com', password = 'correct-horse-battery-staple') {
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, hashPassword(password));
  return info.lastInsertRowid;
}

// --- changePassword ---

test('changePassword updates the stored hash when the current password is correct', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');

  const result = changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  assert.equal(result.success, true);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  assert.equal(verifyPassword('new-password-456', row.password_hash), true);
  assert.equal(verifyPassword('old-password-123', row.password_hash), false);
});

test('changePassword rejects an incorrect current password and leaves the hash untouched', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');
  const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;

  const result = changePassword(db, { userId, currentPassword: 'wrong-password', newPassword: 'new-password-456' });

  assert.equal(result.success, false);
  assert.equal(result.error, 'INCORRECT_CURRENT_PASSWORD');
  const after = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;
  assert.equal(after, before);
});

test('changePassword rejects a new password shorter than 8 characters', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');

  const result = changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'short' });

  assert.equal(result.success, false);
  assert.equal(result.error, 'WEAK_NEW_PASSWORD');
});

test('changePassword invalidates every other session for that user', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-b', userId, future);

  changePassword(db, {
    userId, currentPassword: 'old-password-123', newPassword: 'new-password-456', keepSessionId: 'session-a',
  });

  const remaining = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId).map((r) => r.id);
  assert.deepEqual(remaining, ['session-a']);
});

test('changePassword invalidates all sessions when no session is asked to be kept', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);

  changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
  assert.equal(remaining, 0);
});

test('changePassword does not touch other users\' sessions', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com', 'old-password-123');
  const otherId = makeUser(db, 'other@example.com', 'other-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('other-session', otherId, future);

  changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('other-session').n, 1);
});

// --- deleteAccount ---

test('deleteAccount removes the user row', () => {
  const db = makeTestDb();
  const userId = makeUser(db);

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId).n, 0);
});

test('deleteAccount removes all sessions for that user', () => {
  const db = makeTestDb();
  const userId = makeUser(db);
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-b', userId, future);

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount removes the ebay_connections row for that user', () => {
  const db = makeTestDb();
  const userId = makeUser(db);
  db.prepare('INSERT INTO ebay_connections (user_id, refresh_token_encrypted) VALUES (?, ?)').run(userId, 'ciphertext');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ebay_connections WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount removes all parts rows for that user only', () => {
  const db = makeTestDb();
  const userId = makeUser(db, 'seller@example.com');
  const otherId = makeUser(db, 'other@example.com');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(userId, 'Relay 1');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(userId, 'Relay 2');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(otherId, 'Someone else\'s part');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts WHERE user_id = ?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts WHERE user_id = ?').get(otherId).n, 1);
});

test('deleteAccount removes all feedback rows for that user', () => {
  const db = makeTestDb();
  const userId = makeUser(db);
  db.prepare('INSERT INTO feedback (user_id, message) VALUES (?, ?)').run(userId, 'Great app!');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount on a nonexistent user id is a safe no-op', () => {
  const db = makeTestDb();
  assert.doesNotThrow(() => deleteAccount(db, 999999));
});

test('deleteAccount is atomic: nothing is committed if a step fails', () => {
  const db = makeTestDb();
  const userId = makeUser(db);
  db.prepare('INSERT INTO ebay_connections (user_id, refresh_token_encrypted) VALUES (?, ?)').run(userId, 'ciphertext');
  // Drop a table deleteAccount depends on, mid-schema, to force a failure partway through the
  // transaction - the user row (deleted last) must survive if an earlier statement throws.
  db.exec('DROP TABLE feedback');

  assert.throws(() => deleteAccount(db, userId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId).n, 1);
});
