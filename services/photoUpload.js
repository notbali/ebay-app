const multer = require('multer');
const fs = require('fs');
const { UPLOAD_DIR, safeUploadFilename, isAllowedImageMimetype, sniffImageFile } = require('./uploadService');

// Photo-upload middleware shared by routes/parts.js (new draft, add photos to a draft). Lives
// here rather than inline in the route so the limits/filtering can be exercised in tests against
// a real multipart request - they're security-relevant and multer's behavior can shift between
// major versions.
function createPhotoUpload(destination = UPLOAD_DIR) {
  return multer({
    storage: multer.diskStorage({
      destination,
      filename: (req, file, cb) => cb(null, safeUploadFilename(file.originalname)),
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 12 }, // 10MB per file, up to 12 photos (eBay's per-listing limit)
    // Cheap first-pass rejection only - file.mimetype is the client-declared multipart
    // Content-Type, trivially spoofed. verifyUploadedImages below does the real check against
    // the bytes multer actually wrote to disk.
    fileFilter: (req, file, cb) => cb(null, isAllowedImageMimetype(file.mimetype)),
  });
}

// Runs after multer has written req.files to disk. file.mimetype can't be trusted (see above),
// so this re-checks each file's real signature and deletes+rejects the whole request if any file
// isn't actually one of the allowed image types - closes the gap where a non-image file (e.g.
// named photo.html, containing a <script>) could be smuggled in behind a spoofed Content-Type.
function verifyUploadedImages(req, res, next) {
  const files = req.files || [];
  for (const file of files) {
    if (!sniffImageFile(file.path)) {
      for (const f of files) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: `File "${file.originalname}" is not a valid image` });
    }
  }
  next();
}

module.exports = { createPhotoUpload, verifyUploadedImages };
