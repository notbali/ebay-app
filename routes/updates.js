const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Public (no requireAuth) - "What's New" is now its own page, reachable without an account,
// same as the Terms/Privacy pages. Posting and deleting stay admin-only below.
router.get('/', (req, res) => {
  const updates = db.prepare('SELECT id, title, body, created_at FROM updates ORDER BY created_at DESC').all();
  res.json(updates);
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });

  const info = db.prepare('INSERT INTO updates (title, body, author_user_id) VALUES (?, ?, ?)')
    .run(title, body, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM updates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
