const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { generateListing } = require('../services/geminiService');
const { pushDraftListing, publishOffer } = require('../services/ebayService');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// --- Create a new draft from a photo and/or notes ---
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const rawInput = req.body.notes || '';
    const imagePath = req.file ? req.file.path : null;

    const ai = await generateListing({ imagePath, rawInput });

    const stmt = db.prepare(`
      INSERT INTO parts (
        photo_path, raw_input, ai_part_number, ai_brand, ai_title, ai_description,
        ai_price_low, ai_price_high, ai_specifics_json, ai_confidence, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `);

    const info = stmt.run(
      imagePath,
      rawInput,
      ai.part_number,
      ai.brand,
      ai.title,
      ai.description,
      ai.price_low,
      ai.price_high,
      JSON.stringify(ai.specifics || {}),
      ai.confidence
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

// --- Edit a draft before pushing (seller review step) ---
router.put('/:id', (req, res) => {
  const fields = ['ai_title', 'ai_description', 'ai_price_low', 'ai_price_high', 'ai_specifics_json'];
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

// --- Push a reviewed draft to eBay as an UNPUBLISHED offer ---
router.post('/:id/push-to-ebay', async (req, res) => {
  try {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Not found' });

    const result = await pushDraftListing(part);

    db.prepare(`
      UPDATE parts SET status = 'pushed_to_ebay', ebay_sku = ?, ebay_offer_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.sku, result.offerId, req.params.id);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    db.prepare(`UPDATE parts SET error_message = ? WHERE id = ?`).run(err.message, req.params.id);
    res.status(500).json({ error: err.message });
  }
});

// --- Explicit, separate step: actually make the eBay offer live ---
router.post('/:id/publish', async (req, res) => {
  try {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part || !part.ebay_offer_id) {
      return res.status(400).json({ error: 'Push to eBay before publishing.' });
    }
    const result = await publishOffer(part.ebay_offer_id);
    db.prepare(`UPDATE parts SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
