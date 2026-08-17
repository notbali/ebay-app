const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { generateListing } = require('../services/claudeService');
const { publishListing, suggestCategories } = require('../services/ebayService');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 }, // 10MB per file, up to 12 photos (eBay's per-listing limit)
});

// --- Create a new draft from photo(s) and/or notes ---
router.post('/', upload.array('photos', 12), async (req, res) => {
  try {
    const rawInput = req.body.notes || '';
    const imagePaths = (req.files || []).map((f) => f.path);

    const ai = await generateListing({ imagePaths, rawInput });

    // Best-effort: if the category lookup itself fails (eBay API hiccup, no match, etc.), still
    // save the draft - the seller can search for the right category manually in the dashboard.
    let category = null;
    try {
      const suggestions = await suggestCategories(ai.category_search_term);
      category = suggestions[0] || null;
    } catch (e) {
      console.error('Category suggestion failed:', e.message);
    }

    const stmt = db.prepare(`
      INSERT INTO parts (
        photo_paths_json, raw_input, ai_part_number, ai_brand, ai_title, ai_description,
        ai_price_low, ai_price_high, ai_specifics_json, ai_confidence, ai_condition,
        ai_category_id, ai_category_name, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `);

    const info = stmt.run(
      JSON.stringify(imagePaths),
      rawInput,
      ai.part_number,
      ai.brand,
      ai.title,
      ai.description,
      ai.price_low,
      ai.price_high,
      JSON.stringify(ai.specifics || {}),
      ai.confidence,
      ai.condition,
      category ? category.categoryId : null,
      category ? category.categoryName : null
    );

    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(info.lastInsertRowid);
    res.json({ part, notes_for_seller: ai.notes_for_seller });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- List all drafts ---
router.get('/', (req, res) => {
  const parts = db.prepare('SELECT * FROM parts ORDER BY created_at DESC').all();
  res.json(parts);
});

// --- Get one ---
router.get('/:id', (req, res) => {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });
  res.json(part);
});

// --- Edit a draft before publishing (seller review step) ---
router.put('/:id', (req, res) => {
  const fields = [
    'ai_title', 'ai_description', 'ai_price_low', 'ai_price_high', 'ai_specifics_json',
    'ai_condition', 'ai_category_id', 'ai_category_name',
  ];
  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = CURRENT_TIMESTAMP", "status = 'reviewed'");
  values.push(req.params.id);

  db.prepare(`UPDATE parts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  res.json(part);
});

// --- Search eBay categories, for overriding the auto-suggested one in the dashboard ---
router.get('/categories/suggest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });

  try {
    const suggestions = await suggestCategories(q);
    res.json(suggestions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Add more photos to an existing draft ---
router.post('/:id/photos', upload.array('photos', 12), async (req, res) => {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });

  const existing = JSON.parse(part.photo_paths_json || '[]');
  const added = (req.files || []).map((f) => f.path);
  const combined = [...existing, ...added].slice(0, 12);

  db.prepare('UPDATE parts SET photo_paths_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(combined), req.params.id);

  const updated = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// --- Remove one photo from a draft by index ---
router.delete('/:id/photos/:index', (req, res) => {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });

  const paths = JSON.parse(part.photo_paths_json || '[]');
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= paths.length) {
    return res.status(400).json({ error: 'Invalid photo index' });
  }

  const [removed] = paths.splice(index, 1);
  fs.unlink(removed, () => {}); // best-effort - don't fail the request if the file is already gone

  db.prepare('UPDATE parts SET photo_paths_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(paths), req.params.id);

  const updated = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// --- Publish a reviewed draft live to eBay ---
// One action: creates/updates the inventory item, creates/updates its offer (reusing an
// existing offer if this part was already attempted before, so a retry after fixing an
// error doesn't leave an orphaned duplicate), then publishes it. Review happens beforehand
// in this dashboard - there is no intermediate "unpublished draft on eBay" step anymore,
// since eBay's own UI doesn't surface that state anywhere useful.
router.post('/:id/publish', async (req, res) => {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Not found' });

  try {
    const result = await publishListing(part);

    db.prepare(`
      UPDATE parts SET status = 'published', ebay_sku = ?, ebay_offer_id = ?, ebay_listing_id = ?,
        error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.sku, result.offerId, result.listingId, req.params.id);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);

    if (err.sku && err.offerId) {
      // Item + offer exist on eBay even though publish itself failed - save them so the
      // next attempt updates this same offer instead of creating another one.
      db.prepare(`
        UPDATE parts SET status = 'pushed_to_ebay', ebay_sku = ?, ebay_offer_id = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(err.sku, err.offerId, err.message, req.params.id);
    } else {
      db.prepare('UPDATE parts SET error_message = ? WHERE id = ?').run(err.message, req.params.id);
    }

    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
