const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  getDailyLimit, reserveDraft, releaseDraft, getUsage, pruneAiUsage, createInFlightTracker,
  runWithDraftQuota, quotaRefusal, DEFAULT_DAILY_LIMIT, WINDOW_MS,
} = require('../services/aiQuotaService');

// Same shape as the real table in db.js.
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ai_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_ai_generations_user_created ON ai_generations (user_id, created_at);
  `);
  return db;
}

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const countRows = (db, userId) => db.prepare('SELECT COUNT(*) AS n FROM ai_generations WHERE user_id = ?').get(userId).n;

// --- getDailyLimit ---

test('getDailyLimit defaults when AI_DAILY_LIMIT is unset or unusable', () => {
  assert.equal(getDailyLimit({}), DEFAULT_DAILY_LIMIT);
  assert.equal(getDailyLimit({ AI_DAILY_LIMIT: '' }), DEFAULT_DAILY_LIMIT);
  assert.equal(getDailyLimit({ AI_DAILY_LIMIT: 'lots' }), DEFAULT_DAILY_LIMIT);
  assert.equal(getDailyLimit({ AI_DAILY_LIMIT: '0' }), DEFAULT_DAILY_LIMIT);
  assert.equal(getDailyLimit({ AI_DAILY_LIMIT: '-5' }), DEFAULT_DAILY_LIMIT);
});

test('getDailyLimit honors a positive integer from AI_DAILY_LIMIT', () => {
  assert.equal(getDailyLimit({ AI_DAILY_LIMIT: '12' }), 12);
});

// --- reserveDraft ---

test('reserveDraft allows drafts up to the limit and records each one', () => {
  const db = makeTestDb();
  for (let i = 0; i < 3; i += 1) {
    const r = reserveDraft(db, 1, { limit: 3, now: NOW + i });
    assert.equal(r.ok, true);
    assert.ok(r.reservationId);
  }
  assert.equal(countRows(db, 1), 3);
});

test('reserveDraft refuses once the limit is hit and reports when a slot frees up', () => {
  const db = makeTestDb();
  reserveDraft(db, 1, { limit: 2, now: NOW });
  reserveDraft(db, 1, { limit: 2, now: NOW + 60_000 });

  const blocked = reserveDraft(db, 1, { limit: 2, now: NOW + 120_000 });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.used, 2);
  assert.equal(blocked.limit, 2);
  // The oldest draft ages out of the 24h window first - that's when the user can go again.
  assert.equal(blocked.retryAt, NOW + WINDOW_MS);
  assert.equal(countRows(db, 1), 2, 'a refused attempt must not be recorded');
});

test('reserveDraft uses a rolling window: drafts older than 24h stop counting', () => {
  const db = makeTestDb();
  reserveDraft(db, 1, { limit: 1, now: NOW });

  assert.equal(reserveDraft(db, 1, { limit: 1, now: NOW + WINDOW_MS - 1 }).ok, false);
  assert.equal(reserveDraft(db, 1, { limit: 1, now: NOW + WINDOW_MS + 1 }).ok, true);
});

test('reserveDraft limits each user separately', () => {
  const db = makeTestDb();
  reserveDraft(db, 1, { limit: 1, now: NOW });

  assert.equal(reserveDraft(db, 1, { limit: 1, now: NOW }).ok, false);
  assert.equal(reserveDraft(db, 2, { limit: 1, now: NOW }).ok, true);
});

// --- releaseDraft ---

test('releaseDraft gives the slot back (a failed generation should not cost the user a draft)', () => {
  const db = makeTestDb();
  const r = reserveDraft(db, 1, { limit: 1, now: NOW });
  assert.equal(reserveDraft(db, 1, { limit: 1, now: NOW }).ok, false);

  releaseDraft(db, r.reservationId);

  assert.equal(reserveDraft(db, 1, { limit: 1, now: NOW }).ok, true);
});

test('releaseDraft on an unknown id is a safe no-op', () => {
  const db = makeTestDb();
  assert.doesNotThrow(() => releaseDraft(db, 9999));
});

// --- getUsage / pruneAiUsage ---

test('getUsage reports used, remaining and the reset time', () => {
  const db = makeTestDb();
  reserveDraft(db, 1, { limit: 5, now: NOW });
  reserveDraft(db, 1, { limit: 5, now: NOW + 1000 });

  const usage = getUsage(db, 1, { limit: 5, now: NOW + 2000 });

  assert.deepEqual(usage, { used: 2, limit: 5, remaining: 3, resetsAt: NOW + WINDOW_MS });
});

test('getUsage with no usage has full remaining and no reset time', () => {
  const db = makeTestDb();
  assert.deepEqual(getUsage(db, 1, { limit: 5, now: NOW }), { used: 0, limit: 5, remaining: 5, resetsAt: null });
});

test('pruneAiUsage deletes only rows older than the window', () => {
  const db = makeTestDb();
  reserveDraft(db, 1, { limit: 99, now: NOW - WINDOW_MS - 5000 });
  reserveDraft(db, 1, { limit: 99, now: NOW - 1000 });

  pruneAiUsage(db, { now: NOW });

  assert.equal(countRows(db, 1), 1);
});

// --- in-flight tracker ---

test('in-flight tracker allows up to the max concurrent generations per user', () => {
  const tracker = createInFlightTracker({ max: 2 });
  const a = tracker.begin(1);
  const b = tracker.begin(1);
  assert.ok(a && b);
  assert.equal(tracker.begin(1), null);
  assert.ok(tracker.begin(2), 'another user is unaffected');
});

test('in-flight tracker frees a slot when a generation finishes, and release is idempotent', () => {
  const tracker = createInFlightTracker({ max: 1 });
  const done = tracker.begin(1);
  assert.equal(tracker.begin(1), null);

  done();
  done(); // a double release must not free someone else's slot
  const next = tracker.begin(1);
  assert.ok(next);
  assert.equal(tracker.begin(1), null);
});

// --- runWithDraftQuota ---

test('runWithDraftQuota runs the work and keeps the reservation on success', async () => {
  const db = makeTestDb();
  const tracker = createInFlightTracker({ max: 2 });

  const out = await runWithDraftQuota(db, 1, async () => 'listing', { limit: 5, now: NOW, tracker });

  assert.deepEqual(out, { ok: true, value: 'listing' });
  assert.equal(countRows(db, 1), 1);
  assert.ok(tracker.begin(1) && tracker.begin(1), 'in-flight slot was released afterward');
});

test('runWithDraftQuota releases the reservation and rethrows when the work fails', async () => {
  const db = makeTestDb();
  const tracker = createInFlightTracker({ max: 1 });

  await assert.rejects(
    runWithDraftQuota(db, 1, async () => { throw new Error('AI down'); }, { limit: 5, now: NOW, tracker }),
    /AI down/,
  );

  assert.equal(countRows(db, 1), 0, 'a failed generation must not use up a draft');
  assert.ok(tracker.begin(1), 'in-flight slot was released even though the work threw');
});

test('runWithDraftQuota refuses without running the work when the daily limit is reached', async () => {
  const db = makeTestDb();
  const tracker = createInFlightTracker({ max: 2 });
  reserveDraft(db, 1, { limit: 1, now: NOW });
  let ran = false;

  const out = await runWithDraftQuota(db, 1, async () => { ran = true; }, { limit: 1, now: NOW + 1000, tracker });

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DAILY_LIMIT');
  assert.equal(out.limit, 1);
  assert.equal(out.retryAt, NOW + WINDOW_MS);
  assert.equal(ran, false);
  assert.ok(tracker.begin(1) && tracker.begin(1), 'refusal must not leak an in-flight slot');
});

test('runWithDraftQuota refuses a user with too many drafts already generating', async () => {
  const db = makeTestDb();
  const tracker = createInFlightTracker({ max: 1 });
  let finish;
  const first = runWithDraftQuota(db, 1, () => new Promise((resolve) => { finish = resolve; }), { limit: 5, now: NOW, tracker });

  const second = await runWithDraftQuota(db, 1, async () => 'x', { limit: 5, now: NOW, tracker });

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'TOO_MANY_IN_FLIGHT');
  assert.equal(countRows(db, 1), 1, 'the refused attempt reserved nothing');

  finish('done');
  assert.deepEqual(await first, { ok: true, value: 'done' });
});

// --- quotaRefusal (the 429 response body for a refused outcome) ---

test('quotaRefusal for the daily limit names the limit and roughly how long to wait', () => {
  const r = quotaRefusal({ ok: false, reason: 'DAILY_LIMIT', used: 50, limit: 50, retryAt: NOW + 3 * 60 * 60 * 1000 + 20 * 60 * 1000 }, NOW);
  assert.equal(r.retryAfterSeconds, 3 * 60 * 60 + 20 * 60);
  assert.match(r.error, /50 AI drafts/);
  assert.match(r.error, /3 hours/);
});

test('quotaRefusal speaks in minutes when the wait is under an hour, and never says "0 minutes"', () => {
  const r = quotaRefusal({ ok: false, reason: 'DAILY_LIMIT', used: 5, limit: 5, retryAt: NOW + 12 * 60 * 1000 }, NOW);
  assert.match(r.error, /12 minutes/);
  const soon = quotaRefusal({ ok: false, reason: 'DAILY_LIMIT', used: 5, limit: 5, retryAt: NOW + 5000 }, NOW);
  assert.match(soon.error, /1 minute\b/);
  assert.ok(soon.retryAfterSeconds >= 1);
});

test('quotaRefusal for too many in flight asks the seller to wait for the current draft', () => {
  const r = quotaRefusal({ ok: false, reason: 'TOO_MANY_IN_FLIGHT' }, NOW);
  assert.match(r.error, /already being generated/i);
  assert.equal(r.retryAfterSeconds, 30);
});
