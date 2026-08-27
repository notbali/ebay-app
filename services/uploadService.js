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

// The multer fileFilter above only sees the client-declared multipart Content-Type - trivially
// spoofable with any HTTP client, independent of the file's real bytes or its filename/extension
// (which safeUploadFilename preserves). A file named photo.html with a spoofed "image/jpeg" part
// would pass that check and land on disk as a .html file. sniffImageBuffer reads the actual file
// signature instead, so callers can verify what was written is really one of the allowed image
// types before trusting it (uploads route rejects bad files; routes/uploads.js forces the
// verified type on the response instead of trusting the on-disk extension when serving it back).
function sniffImageBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.slice(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// Reads just enough of a file on disk to sniff its type, without loading the whole (up to 10MB)
// file into memory.
function sniffImageFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, header, 0, 12, 0);
    return sniffImageBuffer(header.slice(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
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

module.exports = {
  UPLOAD_DIR, safeUploadFilename, isAllowedImageMimetype, ownsUploadedFile,
  sniffImageBuffer, sniffImageFile,
};
