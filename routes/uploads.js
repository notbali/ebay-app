const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOAD_DIR, ownsUploadedFile } = require('../services/uploadService');

const router = express.Router();

// Replaces a blanket express.static mount (which served every seller's photos to anyone with the
// URL, no auth at all) - only the part's own owner can fetch it, matching every other /api/parts
// route's per-user scoping.
router.get('/:filename', requireAuth, (req, res) => {
  const { filename } = req.params;
  if (filename !== path.basename(filename)) return res.status(400).end();

  const rows = db.prepare('SELECT photo_paths_json FROM parts WHERE user_id = ?')
    .all(req.user.id)
    .map((r) => r.photo_paths_json);

  if (!ownsUploadedFile(rows, filename)) return res.status(404).end();

  res.sendFile(path.join(UPLOAD_DIR, filename));
});

module.exports = router;
