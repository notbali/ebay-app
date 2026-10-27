const { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } = require('./authService');

// Pure DB logic, kept separate from routes/auth.js so it's testable against an isolated
// in-memory DB (same pattern as middleware/auth.js's pruneExpiredSessions).
//
// node:sqlite's DatabaseSync has no better-sqlite3-style db.transaction() helper, so
// transactions here are plain BEGIN/COMMIT/ROLLBACK via db.exec.
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function changePassword(db, {
  userId, currentPassword, newPassword, keepSessionId = null,
}) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  // An over-long current password can't be correct (signup caps length), so skip the scrypt run.
  if (!user || String(currentPassword || '').length > MAX_PASSWORD_LENGTH
    || !(await verifyPassword(currentPassword, user.password_hash))) {
    return { success: false, error: 'INCORRECT_CURRENT_PASSWORD' };
  }
  if (String(newPassword || '').length < 8) {
    return { success: false, error: 'WEAK_NEW_PASSWORD' };
  }
  if (String(newPassword).length > MAX_PASSWORD_LENGTH) {
    return { success: false, error: 'PASSWORD_TOO_LONG' };
  }

  // Hash before opening the transaction: the transaction must stay synchronous (BEGIN..COMMIT
  // with no awaits in between), or another request's statements could interleave inside it.
  const newHash = await hashPassword(newPassword);

  withTransaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
    // Invalidate every other session so a stolen cookie doesn't survive a password change; the
    // session making this request (if any) is kept alive so the user isn't logged out mid-action.
    if (keepSessionId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSessionId);
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  });

  return { success: true };
}

// Deletes everything tied to a user account. No FOREIGN KEY ... CASCADE exists in this schema
// (see db.js), so each table is cleared by hand inside one transaction - if any step throws, the
// whole thing rolls back rather than leaving a half-deleted account.
//
// Only database rows are removed here. Returns the photo file paths those rows referenced - once
// the rows are gone there'd be no way to find the files again - so the caller can delete the
// files too (see services/userFilesService.js).
function deleteAccount(db, userId) {
  let photoPaths = [];

  withTransaction(db, () => {
    for (const row of db.prepare('SELECT photo_paths_json FROM parts WHERE user_id = ?').all(userId)) {
      try {
        const paths = JSON.parse(row.photo_paths_json || '[]');
        if (Array.isArray(paths)) photoPaths.push(...paths.filter((p) => typeof p === 'string' && p));
      } catch {
        // A row with unreadable photo data can't tell us which files to remove.
      }
    }

    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ebay_connections WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM parts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM feedback WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ai_generations WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  return { photoPaths };
}

module.exports = { changePassword, deleteAccount };
