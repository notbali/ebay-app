// Pure query logic for a single "What's New" entry, kept separate from routes/ so it's testable
// against an isolated in-memory DB (same pattern as the other services/*).

function getUpdateById(db, id) {
  return db.prepare('SELECT id, title, body, created_at FROM updates WHERE id = ?').get(id);
}

module.exports = { getUpdateById };
