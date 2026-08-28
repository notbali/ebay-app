const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { listParts } = require('../services/partsService');

// Isolated in-memory DB per test, shaped like the real parts table (see db.js), so filtering/
// search/sort logic is verified against real SQL rather than a mock.
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ai_title TEXT,
      ai_price_low REAL,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function seedPart(db, overrides = {}) {
  const part = {
    user_id: 1,
    ai_title: 'Untitled part',
    ai_price_low: null,
    status: 'draft',
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare('INSERT INTO parts (user_id, ai_title, ai_price_low, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(part.user_id, part.ai_title, part.ai_price_low, part.status, part.created_at);
}

test('listParts returns only the given user\'s parts', () => {
  const db = makeTestDb();
  seedPart(db, { user_id: 1, ai_title: 'My relay' });
  seedPart(db, { user_id: 2, ai_title: 'Someone else\'s relay' });

  const results = listParts(db, 1);

  assert.equal(results.length, 1);
  assert.equal(results[0].ai_title, 'My relay');
});

test('listParts defaults to newest-first order', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Oldest', created_at: '2026-01-01T00:00:00.000Z' });
  seedPart(db, { ai_title: 'Newest', created_at: '2026-03-01T00:00:00.000Z' });
  seedPart(db, { ai_title: 'Middle', created_at: '2026-02-01T00:00:00.000Z' });

  const results = listParts(db, 1);

  assert.deepEqual(results.map((r) => r.ai_title), ['Newest', 'Middle', 'Oldest']);
});

test('listParts filters by status when given a valid status', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'A draft', status: 'draft' });
  seedPart(db, { ai_title: 'A published one', status: 'published' });

  const results = listParts(db, 1, { status: 'published' });

  assert.deepEqual(results.map((r) => r.ai_title), ['A published one']);
});

test('listParts ignores an unrecognized status value (treated as no filter)', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'A draft', status: 'draft' });
  seedPart(db, { ai_title: 'A published one', status: 'published' });

  const results = listParts(db, 1, { status: 'not_a_real_status' });

  assert.equal(results.length, 2);
});

test('listParts searches by title substring, case-insensitively', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Allen-Bradley 700-HC24Z24 relay' });
  seedPart(db, { ai_title: 'Omron PLC module' });

  const results = listParts(db, 1, { q: 'relay' });

  assert.equal(results.length, 1);
  assert.equal(results[0].ai_title, 'Allen-Bradley 700-HC24Z24 relay');

  const upperResults = listParts(db, 1, { q: 'RELAY' });
  assert.equal(upperResults.length, 1);
});

test('listParts search matches a substring anywhere in the title, not just a prefix', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Allen-Bradley 700-HC24Z24 relay' });

  const results = listParts(db, 1, { q: 'HC24Z24' });

  assert.equal(results.length, 1);
});

test('listParts treats % and _ in the search term literally, not as SQL LIKE wildcards', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: '50% off relay' });
  seedPart(db, { ai_title: '50X off relay' }); // would match "50%" via LIKE wildcard if unescaped

  const results = listParts(db, 1, { q: '50%' });

  assert.deepEqual(results.map((r) => r.ai_title), ['50% off relay']);
});

test('listParts treats a whitespace-only search term as no search', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Relay one' });
  seedPart(db, { ai_title: 'Relay two' });

  const results = listParts(db, 1, { q: '   ' });

  assert.equal(results.length, 2);
});

test('listParts sort=oldest orders ascending by created_at', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Oldest', created_at: '2026-01-01T00:00:00.000Z' });
  seedPart(db, { ai_title: 'Newest', created_at: '2026-03-01T00:00:00.000Z' });

  const results = listParts(db, 1, { sort: 'oldest' });

  assert.deepEqual(results.map((r) => r.ai_title), ['Oldest', 'Newest']);
});

test('listParts sort=price_high orders descending by price', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Cheap', ai_price_low: 5 });
  seedPart(db, { ai_title: 'Expensive', ai_price_low: 500 });
  seedPart(db, { ai_title: 'Mid', ai_price_low: 50 });

  const results = listParts(db, 1, { sort: 'price_high' });

  assert.deepEqual(results.map((r) => r.ai_title), ['Expensive', 'Mid', 'Cheap']);
});

test('listParts sort=price_low orders ascending by price', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Cheap', ai_price_low: 5 });
  seedPart(db, { ai_title: 'Expensive', ai_price_low: 500 });

  const results = listParts(db, 1, { sort: 'price_low' });

  assert.deepEqual(results.map((r) => r.ai_title), ['Cheap', 'Expensive']);
});

test('listParts falls back to newest-first for an unrecognized sort value', () => {
  const db = makeTestDb();
  seedPart(db, { ai_title: 'Older', created_at: '2026-01-01T00:00:00.000Z' });
  seedPart(db, { ai_title: 'Newer', created_at: '2026-02-01T00:00:00.000Z' });

  const results = listParts(db, 1, { sort: 'not_a_real_sort' });

  assert.deepEqual(results.map((r) => r.ai_title), ['Newer', 'Older']);
});

test('listParts combines status, search, and sort together', () => {
  const db = makeTestDb();
  seedPart(db, {
    ai_title: 'Cheap published relay', status: 'published', ai_price_low: 5, created_at: '2026-01-01T00:00:00.000Z',
  });
  seedPart(db, {
    ai_title: 'Expensive published relay', status: 'published', ai_price_low: 500, created_at: '2026-01-02T00:00:00.000Z',
  });
  seedPart(db, {
    ai_title: 'Draft relay', status: 'draft', ai_price_low: 1000, created_at: '2026-01-03T00:00:00.000Z',
  });

  const results = listParts(db, 1, { status: 'published', q: 'relay', sort: 'price_high' });

  assert.deepEqual(results.map((r) => r.ai_title), ['Expensive published relay', 'Cheap published relay']);
});
