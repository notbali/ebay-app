const fs = require('fs');
const path = require('path');

// Single source of truth for where uploaded photos live, shared by routes/parts.js (writes) and
// routes/uploads.js (reads). UPLOAD_DIR lets a deployment host's persistent disk hold these across
// deploys/restarts - defaults to a local ./uploads folder for dev.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// file.originalname is attacker-controlled (the client sets it in the multipart request). Passing
// it straight into multer's diskStorage filename (as this app originally did) lets a crafted name
// like "../../../../etc/cron.d/evil" escape the uploads/ directory via path.join in multer's
// internals - an arbitrary file write. path.basename() strips any directory component before it
// ever reaches the filesystem.
function safeUploadFilename(originalname) {
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(originalname)}`;
}

// Client-side accept="image/*" is not a security boundary - it's trivially bypassed. Uploads are
// served back out publicly via express.static, so accepting arbitrary file types (an .svg or
// .html with an embedded <script>) would let a stored file execute as content in a visitor's
// browser under this app's own origin. Restricting to raster image types server-side closes that.
const ALLOWED_IMAGE_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function isAllowedImageMimetype(mimetype) {
  return ALLOWED_IMAGE_MIMETYPES.includes(mimetype);
}

// Local uploads/ files aren't namespaced by user in their path (unlike the R2 keys in
// r2Service.js, which are "parts/<userId>/..."), so serving them back out requires checking
// ownership against the DB rather than the path alone. Takes already-fetched photo_paths_json
// strings (one per part row) rather than querying itself, so it stays a pure, easily-testable
// function - the caller (routes/uploads.js) owns the DB access.
function ownsUploadedFile(photoPathsJsonRows, filename) {
  return photoPathsJsonRows.some((json) => {
    let paths;
    try {
      paths = JSON.parse(json || '[]');
    } catch {
      return false;
    }
    return paths.some((p) => path.basename(p) === filename);
  });
}

module.exports = { UPLOAD_DIR, safeUploadFilename, isAllowedImageMimetype, ownsUploadedFile };
