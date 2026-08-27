const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOAD_DIR, ownsUploadedFile, sniffImageFile } = require('../services/uploadService');

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

  // Ignore the on-disk extension for the response's Content-Type - it comes from the client's
  // original filename (see safeUploadFilename), which is not trustworthy. sendFile would
  // otherwise derive Content-Type from that extension (e.g. serving a smuggled photo.html as
  // text/html), which combined with a browser rendering it could execute embedded script under
  // this app's origin. Sniffing the real file signature and forcing that as the Content-Type -
  // res.type() sets a header sendFile then leaves alone - closes that off regardless of name.
  const filePath = path.join(UPLOAD_DIR, filename);
  const verifiedType = sniffImageFile(filePath);
  if (!verifiedType) return res.status(404).end();

  res.type(verifiedType);
  res.sendFile(filePath);
});

module.exports = router;
