const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, createSessionToken, verifyCookieValue } = require('../services/authService');
const {
  parseCookies, setSessionCookie, clearSessionCookie, createSession, destroySessionByToken, getSessionUser, COOKIE_NAME,
} = require('../middleware/auth');

const router = express.Router();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

router.post('/signup', (req, res) => {
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
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Same generic error whether the email doesn't exist or the password is wrong, so a login
  // attempt can't be used to enumerate which emails have accounts.
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

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
  res.json({ user });
});

module.exports = router;
