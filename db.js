const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,           -- sha256 hash of the session token (raw token only ever lives in the cookie)
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ebay_connections (
    user_id INTEGER PRIMARY KEY,
    refresh_token_encrypted TEXT NOT NULL,
    refresh_token_expires_at TEXT,
    scopes TEXT,
    merchant_location_key TEXT,
    fulfillment_policy_id TEXT,
    payment_policy_id TEXT,
    return_policy_id TEXT,
    connected_at TEXT,
    updated_at TEXT
  );
`);

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
    ai_category_id TEXT,         -- eBay leaf category ID, looked up per-item via Taxonomy API
    ai_category_name TEXT,       -- human-readable name shown in the dashboard
    ai_quantity INTEGER DEFAULT 1,
    ai_free_shipping INTEGER DEFAULT 0, -- 0 = calculated shipping (buyer's location), 1 = free
    ai_weight_lb REAL,           -- estimated shipped-package weight, for calculated shipping
    ai_length_in REAL, ai_width_in REAL, ai_height_in REAL, -- estimated package dimensions
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
if (!columns.includes('ai_category_id')) {
  db.exec('ALTER TABLE parts ADD COLUMN ai_category_id TEXT');
  db.exec('ALTER TABLE parts ADD COLUMN ai_category_name TEXT');
}
if (!columns.includes('ai_quantity')) {
  db.exec('ALTER TABLE parts ADD COLUMN ai_quantity INTEGER DEFAULT 1');
}
if (!columns.includes('ai_free_shipping')) {
  db.exec('ALTER TABLE parts ADD COLUMN ai_free_shipping INTEGER DEFAULT 0');
  db.exec('ALTER TABLE parts ADD COLUMN ai_weight_lb REAL');
  db.exec('ALTER TABLE parts ADD COLUMN ai_length_in REAL');
  db.exec('ALTER TABLE parts ADD COLUMN ai_width_in REAL');
  db.exec('ALTER TABLE parts ADD COLUMN ai_height_in REAL');
}
if (!columns.includes('user_id')) {
  // Nullable: pre-existing rows from before multi-tenant accounts are backfilled to the
  // first-ever signed-up user (see routes/auth.js signup handler), not assigned here.
  db.exec('ALTER TABLE parts ADD COLUMN user_id INTEGER');
}

module.exports = db;
