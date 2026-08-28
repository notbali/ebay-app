const { hashPassword, verifyPassword } = require('./authService');

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

function changePassword(db, {
  userId, currentPassword, newPassword, keepSessionId = null,
}) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return { success: false, error: 'INCORRECT_CURRENT_PASSWORD' };
  }
  if (String(newPassword || '').length < 8) {
    return { success: false, error: 'WEAK_NEW_PASSWORD' };
  }

  withTransaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
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
function deleteAccount(db, userId) {
  withTransaction(db, () => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ebay_connections WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM parts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM feedback WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
}

module.exports = { changePassword, deleteAccount };
