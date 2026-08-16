const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_path TEXT,
    raw_input TEXT,              -- whatever the user typed in (part #, notes, spec sheet text)
    ai_part_number TEXT,
    ai_brand TEXT,
    ai_title TEXT,
    ai_description TEXT,
    ai_price_low REAL,
    ai_price_high REAL,
    ai_specifics_json TEXT,      -- JSON blob of item specifics (voltage, amperage, etc.)
    ai_confidence TEXT,          -- 'high' | 'medium' | 'low' - how sure Claude was on ID
    status TEXT DEFAULT 'draft', -- draft -> reviewed -> pushed_to_ebay -> published
    ebay_offer_id TEXT,
    ebay_sku TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
