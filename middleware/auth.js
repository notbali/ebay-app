const db = require('../db');
const { hashSessionToken, signCookieValue, verifyCookieValue } = require('../services/authService');

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set - required to sign session cookies');
  return s;
}

// req.headers.cookie is a single "a=1; b=2" string - no cookie-parser dependency, so parse it
// by hand. Values are assumed not to contain ";" (true for our own signed session cookie).
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function isSecureContext() {
  return (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
}

function setSessionCookie(res, token) {
  const signed = signCookieValue(token, secret());
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(signed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureContext()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureContext()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function createSession(userId, token) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashSessionToken(token), userId, expiresAt);
}

function destroySessionByToken(token) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(hashSessionToken(token));
}

// Expired sessions are already rejected on lookup (getSessionUser below deletes them lazily,
// one row at a time, only when someone happens to present that exact expired cookie) - this
// sweeps the rest so the table doesn't grow unbounded from sessions nobody ever presents again.
// Takes a db instance (defaulting to the real one) so it's testable against an isolated DB.
function pruneExpiredSessions(dbInstance = db) {
  dbInstance.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// Resolves the logged-in user (or null) from the request's session cookie, without rejecting -
// used by requireAuth and by routes that want to know the user optionally (e.g. GET /api/auth/me).
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;

  const token = verifyCookieValue(raw, secret());
  if (!token) return null;

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hashSessionToken(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(session.user_id);
  return user || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  destroySessionByToken,
  getSessionUser,
  requireAuth,
  pruneExpiredSessions,
};
