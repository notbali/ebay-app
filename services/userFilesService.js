const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./uploadService');
const { deleteUserPhotos } = require('./r2Service');

// Deletes the files that belong to a deleted account: the photos in the local upload dir and the
// public copies in R2. Kept apart from accountService (pure DB logic) because this touches the
// filesystem and network.

// Paths come from photo_paths_json, written when the photo was uploaded - possibly under a
// different UPLOAD_DIR than today's (the dir is configurable and has moved between deployments).
// So only the filename is used, re-rooted in the current upload dir: that also makes escaping the
// dir impossible, whatever a stored path contains. (routes/uploads.js matches by filename too.)
async function removeLocalUploads(storedPaths, { uploadDir = UPLOAD_DIR, unlink = fs.promises.unlink } = {}) {
  const filenames = new Set(
    (storedPaths || [])
      .filter((p) => typeof p === 'string' && p)
      .map((p) => path.basename(p))
      .filter((name) => name && name !== '.' && name !== '..'),
  );

  let removed = 0;
  let failed = 0;
  for (const name of filenames) {
    try {
      await unlink(path.join(uploadDir, name));
      removed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') failed += 1; // already gone is exactly the outcome we wanted
    }
  }
  return { removed, failed };
}

// Best-effort and never throws: by the time this runs the account's database rows are already
// gone, so a storage hiccup must not turn a completed deletion into an error response - it's
// logged for the operator instead. Local files and R2 are attempted independently.
async function cleanupAccountFiles({ photoPaths, userId }, {
  removeLocal = removeLocalUploads, deleteR2 = deleteUserPhotos, log = console.error,
} = {}) {
  const summary = {};

  try {
    summary.local = await removeLocal(photoPaths);
  } catch (err) {
    log(`Account cleanup: could not remove local photos for user ${userId}: ${err.message}`);
    summary.local = { error: err.message };
  }

  try {
    summary.r2 = await deleteR2(userId);
  } catch (err) {
    log(`Account cleanup: could not remove R2 photos for user ${userId}: ${err.message}`);
    summary.r2 = { error: err.message };
  }

  return summary;
}

module.exports = { removeLocalUploads, cleanupAccountFiles };
