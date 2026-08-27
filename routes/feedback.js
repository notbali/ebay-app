const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { checkRateLimit } = require('../services/rateLimitService');
const { sendEmail } = require('../services/emailService');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 5000;

router.post('/', requireAuth, async (req, res) => {
  if (!checkRateLimit(`feedback:${req.user.id}`, { maxAttempts: 5, windowMs: 60 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Too many messages sent. Please try again in a bit.' });
  }

  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
  }

  const info = db.prepare('INSERT INTO feedback (user_id, message) VALUES (?, ?)').run(req.user.id, message);

  // The DB row is the durable record - email delivery is best-effort on top of it, so a Resend
  // outage or missing API key never loses feedback, it just doesn't page the admin immediately.
  let emailSent = 0;
  if (process.env.ADMIN_EMAIL) {
    try {
      await sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: `Bali Bay feedback from ${req.user.email}`,
        text: message,
      });
      emailSent = 1;
    } catch (err) {
      console.error('Failed to send feedback email:', err.message);
    }
  }
  db.prepare('UPDATE feedback SET email_sent = ? WHERE id = ?').run(emailSent, info.lastInsertRowid);

  res.json({ success: true });
});

router.get('/', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT feedback.id, feedback.message, feedback.email_sent, feedback.created_at, users.email
    FROM feedback
    JOIN users ON users.id = feedback.user_id
    ORDER BY feedback.created_at DESC
  `).all();
  res.json(rows);
});

module.exports = router;
