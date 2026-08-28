const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, createSessionToken, hashSessionToken, verifyCookieValue,
} = require('../services/authService');
const {
  parseCookies, setSessionCookie, clearSessionCookie, createSession, destroySessionByToken, getSessionUser,
  requireAuth, COOKIE_NAME, isAdminEmail,
} = require('../middleware/auth');
const { checkRateLimit, resetRateLimit } = require('../services/rateLimitService');
const { changePassword, deleteAccount } = require('../services/accountService');

const router = express.Router();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Keyed by IP alone (not IP+email) so an attacker can't dodge the limit by spraying different
// emails from the same source, and a distributed attack still has to burn many IPs either way.
router.post('/signup', (req, res) => {
  if (!checkRateLimit(`signup:${req.ip}`, { maxAttempts: 5, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many signup attempts. Please try again later.' });
  }

  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  // The very first account created inherits any pre-existing parts rows that predate multi-user
  // accounts (this app's own dev/owner data) - see db.js's parts.user_id migration comment.
  const isFirstUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, hashPassword(password));
  const userId = info.lastInsertRowid;

  if (isFirstUser) {
    db.prepare('UPDATE parts SET user_id = ? WHERE user_id IS NULL').run(userId);
  }

  const token = createSessionToken();
  createSession(userId, token);
  setSessionCookie(res, token);

  res.json({ user: { id: userId, email } });
});

router.post('/login', (req, res) => {
  const rateLimitKey = `login:${req.ip}`;
  if (!checkRateLimit(rateLimitKey, { maxAttempts: 10, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
  }

  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Same generic error whether the email doesn't exist or the password is wrong, so a login
  // attempt can't be used to enumerate which emails have accounts.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  resetRateLimit(rateLimitKey);
  const token = createSessionToken();
  createSession(user.id, token);
  setSessionCookie(res, token);

  res.json({ user: { id: user.id, email: user.email } });
});

router.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  const token = raw && verifyCookieValue(raw, process.env.SESSION_SECRET);
  if (token) destroySessionByToken(token);
  clearSessionCookie(res);
  res.json({ success: true });
});

// Always 200 (never 401) - the frontend uses this as a plain status check on load.
router.get('/me', (req, res) => {
  const user = getSessionUser(req);
  res.json({ user: user ? { ...user, isAdmin: isAdminEmail(user.email) } : null });
});

// Keyed by user id (not IP) since the caller is already authenticated - brute-forcing your own
// current password from a known session is the threat here, not IP-based credential spraying.
router.post('/change-password', requireAuth, (req, res) => {
  const rateLimitKey = `change-password:${req.user.id}`;
  if (!checkRateLimit(rateLimitKey, { maxAttempts: 10, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  const token = raw && verifyCookieValue(raw, process.env.SESSION_SECRET);
  const keepSessionId = token ? hashSessionToken(token) : null;

  const result = changePassword(db, {
    userId: req.user.id, currentPassword, newPassword, keepSessionId,
  });

  if (!result.success) {
    if (result.error === 'WEAK_NEW_PASSWORD') {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  resetRateLimit(rateLimitKey);
  res.json({ success: true });
});

// Requires the current password as confirmation since this is irreversible - there is no undo
// for deleteAccount.
router.post('/delete-account', requireAuth, (req, res) => {
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  deleteAccount(db, req.user.id);
  clearSessionCookie(res);
  res.json({ success: true });
});

module.exports = router;
