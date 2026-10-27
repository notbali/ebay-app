// Per-user cap on AI draft generation. Every draft is a call to a shared, rate-limited free-tier
// model (NVIDIA's is ~40 requests/minute across *all* sellers), and sign-up is open, so without a
// per-user limit one account - or a script - could use up everyone's share (or, with a paid
// provider, the bill). Counts live in the DB rather than memory so a restart or deploy doesn't
// hand every user a fresh allowance.
//
// Pure DB logic taking a db instance (like accountService), so it's testable against an isolated
// in-memory database.

const DEFAULT_DAILY_LIMIT = 50;
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling window, not a calendar day - no midnight reset to game
const MAX_IN_FLIGHT_PER_USER = 2;

function getDailyLimit(env = process.env) {
  const parsed = Number.parseInt(env.AI_DAILY_LIMIT, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

function windowRows(db, userId, now) {
  return db.prepare('SELECT id, created_at FROM ai_generations WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC')
    .all(userId, now - WINDOW_MS);
}

// Counts a draft against the user *before* the AI call, so concurrent requests can't all slip
// under the limit together (the check and insert run back-to-back with no await between them, and
// node:sqlite is synchronous). The caller releases it if generation then fails.
function reserveDraft(db, userId, { limit = getDailyLimit(), now = Date.now() } = {}) {
  const rows = windowRows(db, userId, now);
  if (rows.length >= limit) {
    // The user can go again once enough of their oldest drafts have aged out of the window.
    const unblockingRow = rows[rows.length - limit];
    return { ok: false, used: rows.length, limit, retryAt: unblockingRow.created_at + WINDOW_MS };
  }

  const info = db.prepare('INSERT INTO ai_generations (user_id, created_at) VALUES (?, ?)').run(userId, now);
  return { ok: true, reservationId: Number(info.lastInsertRowid) };
}

function releaseDraft(db, reservationId) {
  db.prepare('DELETE FROM ai_generations WHERE id = ?').run(reservationId);
}

function getUsage(db, userId, { limit = getDailyLimit(), now = Date.now() } = {}) {
  const rows = windowRows(db, userId, now);
  return {
    used: rows.length,
    limit,
    remaining: Math.max(0, limit - rows.length),
    resetsAt: rows.length ? rows[0].created_at + WINDOW_MS : null,
  };
}

// Rows older than the window no longer affect any decision - this just keeps the table small.
function pruneAiUsage(db, { now = Date.now() } = {}) {
  db.prepare('DELETE FROM ai_generations WHERE created_at <= ?').run(now - WINDOW_MS);
}

// Caps simultaneous generations per user (in memory - it only describes requests happening right
// now, so a restart correctly resets it). Stops one user from tying up the shared model queue by
// firing a pile of requests at once, even while still under the daily cap.
function createInFlightTracker({ max = MAX_IN_FLIGHT_PER_USER } = {}) {
  const counts = new Map();
  return {
    // Returns a release function, or null when this user is already at the limit.
    begin(userId) {
      const current = counts.get(userId) || 0;
      if (current >= max) return null;
      counts.set(userId, current + 1);
      let released = false;
      return () => {
        if (released) return; // a double release must not free somebody else's slot
        released = true;
        const n = (counts.get(userId) || 1) - 1;
        if (n <= 0) counts.delete(userId);
        else counts.set(userId, n);
      };
    },
  };
}

const defaultTracker = createInFlightTracker();

// Runs `work` (the AI call) under both limits. Success keeps the reservation; if `work` throws -
// an outage, a malformed response, the seller cancelling - the reservation is released, so only
// drafts that actually produced a result count against the user.
async function runWithDraftQuota(db, userId, work, {
  limit = getDailyLimit(), now = Date.now(), tracker = defaultTracker,
} = {}) {
  const endInFlight = tracker.begin(userId);
  if (!endInFlight) return { ok: false, reason: 'TOO_MANY_IN_FLIGHT' };

  try {
    const reservation = reserveDraft(db, userId, { limit, now });
    if (!reservation.ok) {
      return {
        ok: false, reason: 'DAILY_LIMIT', used: reservation.used, limit: reservation.limit, retryAt: reservation.retryAt,
      };
    }

    try {
      return { ok: true, value: await work() };
    } catch (err) {
      releaseDraft(db, reservation.reservationId);
      throw err;
    }
  } finally {
    endInFlight();
  }
}

function describeWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

// What the route tells the seller when runWithDraftQuota refuses: a message for the dashboard
// (which shows the response's `error` text as-is) and a Retry-After value in seconds.
function quotaRefusal(outcome, now = Date.now()) {
  if (outcome.reason === 'TOO_MANY_IN_FLIGHT') {
    return {
      error: 'Another draft is already being generated for your account - wait for it to finish, then try again.',
      retryAfterSeconds: 30,
    };
  }
  const waitMs = Math.max(0, outcome.retryAt - now);
  return {
    error: `You've reached your limit of ${outcome.limit} AI drafts per 24 hours. You can generate another in ${describeWait(waitMs)}.`,
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
  };
}

module.exports = {
  getDailyLimit, reserveDraft, releaseDraft, getUsage, pruneAiUsage, createInFlightTracker, runWithDraftQuota,
  quotaRefusal, DEFAULT_DAILY_LIMIT, WINDOW_MS, MAX_IN_FLIGHT_PER_USER,
};
