// In-process fixed-window rate limiter, keyed by caller-chosen string (e.g. "login:<ip>" or
// "signup:<ip>"). No extra dependency (express-rate-limit etc.) - consistent with this app's
// zero-extra-auth-deps approach, and a single-process app doesn't need a shared store. Resets on
// process restart, which is an acceptable tradeoff for a small beta rather than adding Redis.
const buckets = new Map();

function checkRateLimit(key, { maxAttempts, windowMs, now = Date.now() }) {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (bucket.count >= maxAttempts) return false;
  bucket.count += 1;
  return true;
}

// Called after a successful login so a legitimate user who mistyped their password a few times
// isn't left counting toward the limit for the rest of the window.
function resetRateLimit(key) {
  buckets.delete(key);
}

module.exports = { checkRateLimit, resetRateLimit };
