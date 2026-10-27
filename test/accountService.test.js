const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } = require('../services/authService');
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
      ai_title TEXT,
      photo_paths_json TEXT DEFAULT '[]'
    );
    CREATE TABLE ai_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL
    );
  `);
  return db;
}

async function makeUser(db, email = 'seller@example.com', password = 'correct-horse-battery-staple') {
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, await hashPassword(password));
  return info.lastInsertRowid;
}

// --- changePassword ---

test('changePassword updates the stored hash when the current password is correct', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');

  const result = await changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  assert.equal(result.success, true);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  assert.equal(await verifyPassword('new-password-456', row.password_hash), true);
  assert.equal(await verifyPassword('old-password-123', row.password_hash), false);
});

test('changePassword rejects an incorrect current password and leaves the hash untouched', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');
  const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;

  const result = await changePassword(db, { userId, currentPassword: 'wrong-password', newPassword: 'new-password-456' });

  assert.equal(result.success, false);
  assert.equal(result.error, 'INCORRECT_CURRENT_PASSWORD');
  const after = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;
  assert.equal(after, before);
});

test('changePassword rejects a new password shorter than 8 characters', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');

  const result = await changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'short' });

  assert.equal(result.success, false);
  assert.equal(result.error, 'WEAK_NEW_PASSWORD');
});

test('changePassword rejects an absurdly long new password (scrypt cost is spent on every byte)', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');

  const result = await changePassword(db, {
    userId, currentPassword: 'old-password-123', newPassword: 'a'.repeat(MAX_PASSWORD_LENGTH + 1),
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'PASSWORD_TOO_LONG');
});

test('changePassword accepts a password of exactly the maximum length', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');

  const result = await changePassword(db, {
    userId, currentPassword: 'old-password-123', newPassword: 'a'.repeat(MAX_PASSWORD_LENGTH),
  });

  assert.equal(result.success, true);
});

test('changePassword invalidates every other session for that user', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-b', userId, future);

  await changePassword(db, {
    userId, currentPassword: 'old-password-123', newPassword: 'new-password-456', keepSessionId: 'session-a',
  });

  const remaining = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId).map((r) => r.id);
  assert.deepEqual(remaining, ['session-a']);
});

test('changePassword invalidates all sessions when no session is asked to be kept', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);

  await changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
  assert.equal(remaining, 0);
});

test('changePassword does not touch other users\' sessions', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com', 'old-password-123');
  const otherId = await makeUser(db, 'other@example.com', 'other-password-123');
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('other-session', otherId, future);

  await changePassword(db, { userId, currentPassword: 'old-password-123', newPassword: 'new-password-456' });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('other-session').n, 1);
});

// --- deleteAccount ---

test('deleteAccount removes the user row', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId).n, 0);
});

test('deleteAccount removes all sessions for that user', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);
  const future = new Date(Date.now() + 60000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-a', userId, future);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run('session-b', userId, future);

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount removes the ebay_connections row for that user', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);
  db.prepare('INSERT INTO ebay_connections (user_id, refresh_token_encrypted) VALUES (?, ?)').run(userId, 'ciphertext');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ebay_connections WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount removes all parts rows for that user only', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com');
  const otherId = await makeUser(db, 'other@example.com');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(userId, 'Relay 1');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(userId, 'Relay 2');
  db.prepare('INSERT INTO parts (user_id, ai_title) VALUES (?, ?)').run(otherId, 'Someone else\'s part');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts WHERE user_id = ?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts WHERE user_id = ?').get(otherId).n, 1);
});

test('deleteAccount removes all feedback rows for that user', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);
  db.prepare('INSERT INTO feedback (user_id, message) VALUES (?, ?)').run(userId, 'Great app!');

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?').get(userId).n, 0);
});

test('deleteAccount on a nonexistent user id is a safe no-op', async () => {
  const db = makeTestDb();
  assert.doesNotThrow(() => deleteAccount(db, 999999));
});

test('deleteAccount is atomic: nothing is committed if a step fails', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);
  db.prepare('INSERT INTO ebay_connections (user_id, refresh_token_encrypted) VALUES (?, ?)').run(userId, 'ciphertext');
  // Drop a table deleteAccount depends on, mid-schema, to force a failure partway through the
  // transaction - the user row (deleted last) must survive if an earlier statement throws.
  db.exec('DROP TABLE feedback');

  assert.throws(() => deleteAccount(db, userId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId).n, 1);
});

test('deleteAccount removes the AI-usage rows for that user only', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com');
  const otherId = await makeUser(db, 'other@example.com');
  db.prepare('INSERT INTO ai_generations (user_id, created_at) VALUES (?, ?)').run(userId, 1);
  db.prepare('INSERT INTO ai_generations (user_id, created_at) VALUES (?, ?)').run(otherId, 1);

  deleteAccount(db, userId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_generations WHERE user_id = ?').get(userId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_generations WHERE user_id = ?').get(otherId).n, 1);
});

// deleteAccount only clears DB rows; it reports which photo files those rows pointed at so the
// caller can delete them too (once the rows are gone there'd be no way to find them again).

test('deleteAccount returns every photo path from that user\'s parts, and none from anyone else', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db, 'seller@example.com');
  const otherId = await makeUser(db, 'other@example.com');
  const insert = db.prepare('INSERT INTO parts (user_id, ai_title, photo_paths_json) VALUES (?, ?, ?)');
  insert.run(userId, 'Relay 1', JSON.stringify(['/up/a.jpg', '/up/b.jpg']));
  insert.run(userId, 'Relay 2', JSON.stringify(['/up/c.jpg']));
  insert.run(otherId, 'Not mine', JSON.stringify(['/up/other.jpg']));

  const result = deleteAccount(db, userId);

  assert.deepEqual(result.photoPaths.sort(), ['/up/a.jpg', '/up/b.jpg', '/up/c.jpg']);
});

test('deleteAccount tolerates parts with empty, null or malformed photo_paths_json', async () => {
  const db = makeTestDb();
  const userId = await makeUser(db);
  const insert = db.prepare('INSERT INTO parts (user_id, ai_title, photo_paths_json) VALUES (?, ?, ?)');
  insert.run(userId, 'a', null);
  insert.run(userId, 'b', '');
  insert.run(userId, 'c', '{not json');
  insert.run(userId, 'd', JSON.stringify(['/up/ok.jpg']));

  const result = deleteAccount(db, userId);

  assert.deepEqual(result.photoPaths, ['/up/ok.jpg']);
});

test('deleteAccount returns no photo paths for a nonexistent user', () => {
  const db = makeTestDb();
  assert.deepEqual(deleteAccount(db, 999999).photoPaths, []);
});
