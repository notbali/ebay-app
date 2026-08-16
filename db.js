const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_paths_json TEXT DEFAULT '[]', -- JSON array of relative paths under uploads/
    raw_input TEXT,              -- whatever the user typed in (part #, notes, spec sheet text)
    ai_part_number TEXT,
    ai_brand TEXT,
    ai_title TEXT,
    ai_description TEXT,
    ai_price_low REAL,
    ai_price_high REAL,
    ai_specifics_json TEXT,      -- JSON blob of item specifics (voltage, amperage, etc.)
    ai_confidence TEXT,          -- 'high' | 'medium' | 'low' - how sure Claude was on ID
    ai_condition TEXT DEFAULT 'USED_GOOD', -- eBay condition enum value, seller-reviewable
    status TEXT DEFAULT 'draft', -- draft -> reviewed -> pushed_to_ebay -> published
    ebay_offer_id TEXT,
    ebay_sku TEXT,
    ebay_listing_id TEXT,        -- set once actually published; used to link to the live listing
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for DBs created before these columns existed.
const columns = db.prepare("PRAGMA table_info(parts)").all().map((c) => c.name);
if (!columns.includes('ai_condition')) {
  db.exec("ALTER TABLE parts ADD COLUMN ai_condition TEXT DEFAULT 'USED_GOOD'");
}
if (!columns.includes('photo_paths_json')) {
  db.exec("ALTER TABLE parts ADD COLUMN photo_paths_json TEXT DEFAULT '[]'");
  // Backfill from the old single-photo column, if it exists.
  if (columns.includes('photo_path')) {
    for (const row of db.prepare('SELECT id, photo_path FROM parts WHERE photo_path IS NOT NULL').all()) {
      db.prepare('UPDATE parts SET photo_paths_json = ? WHERE id = ?')
        .run(JSON.stringify([row.photo_path]), row.id);
    }
  }
}
if (!columns.includes('ebay_listing_id')) {
  db.exec('ALTER TABLE parts ADD COLUMN ebay_listing_id TEXT');
}

module.exports = db;
