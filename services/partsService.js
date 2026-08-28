// Pure query logic, kept separate from routes/parts.js so it's testable against an isolated
// in-memory DB (same pattern as services/accountService.js).

const VALID_STATUSES = ['draft', 'reviewed', 'pushed_to_ebay', 'published'];

const SORTS = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  price_high: 'ai_price_low DESC',
  price_low: 'ai_price_low ASC',
};

// Escapes SQLite LIKE wildcards (% and _) plus the escape character itself, so a search term
// like "50%" matches the literal characters rather than acting as a wildcard.
function escapeLike(str) {
  return str.replace(/[\\%_]/g, '\\$&');
}

function listParts(db, userId, { status, q, sort } = {}) {
  const clauses = ['user_id = ?'];
  const params = [userId];

  if (VALID_STATUSES.includes(status)) {
    clauses.push('status = ?');
    params.push(status);
  }

  const trimmedQ = String(q || '').trim();
  if (trimmedQ) {
    clauses.push("ai_title LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escapeLike(trimmedQ)}%`);
  }

  const orderBy = SORTS[sort] || SORTS.newest;

  return db.prepare(`SELECT * FROM parts WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy}`).all(...params);
}

module.exports = { listParts };
