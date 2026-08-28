const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { getOnboardingStatus } = require('../services/onboardingService');

// Isolated in-memory DB per test, shaped like the real schema (see db.js).
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ebay_connections (
      user_id INTEGER PRIMARY KEY,
      refresh_token_encrypted TEXT NOT NULL,
      merchant_location_key TEXT,
      fulfillment_policy_id TEXT,
      payment_policy_id TEXT,
      return_policy_id TEXT
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      status TEXT DEFAULT 'draft'
    );
  `);
  return db;
}

function connectEbay(db, userId, overrides = {}) {
  const fields = {
    merchant_location_key: null, fulfillment_policy_id: null, payment_policy_id: null, return_policy_id: null, ...overrides,
  };
  db.prepare(`
    INSERT INTO ebay_connections (user_id, refresh_token_encrypted, merchant_location_key, fulfillment_policy_id, payment_policy_id, return_policy_id)
    VALUES (?, 'ciphertext', ?, ?, ?, ?)
  `).run(userId, fields.merchant_location_key, fields.fulfillment_policy_id, fields.payment_policy_id, fields.return_policy_id);
}

function addPart(db, userId, status = 'draft') {
  db.prepare('INSERT INTO parts (user_id, status) VALUES (?, ?)').run(userId, status);
}

const FULLY_CONFIGURED = {
  merchant_location_key: 'loc-1', fulfillment_policy_id: 'ship-1', payment_policy_id: 'pay-1', return_policy_id: 'return-1',
};

test('reports ebayConnected: false when there is no ebay_connections row', () => {
  const db = makeTestDb();
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.ebayConnected, false);
});

test('reports ebayConnected: true once a connection row exists', () => {
  const db = makeTestDb();
  connectEbay(db, 1);
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.ebayConnected, true);
});

test('reports policiesConfigured: false when connected but no policies set', () => {
  const db = makeTestDb();
  connectEbay(db, 1);
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.policiesConfigured, false);
});

test('reports policiesConfigured: false when only some policies are set', () => {
  const db = makeTestDb();
  connectEbay(db, 1, { merchant_location_key: 'loc-1', fulfillment_policy_id: 'ship-1' });
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.policiesConfigured, false);
});

test('reports policiesConfigured: true only once location + all 3 policies are set', () => {
  const db = makeTestDb();
  connectEbay(db, 1, FULLY_CONFIGURED);
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.policiesConfigured, true);
});

test('reports hasFirstListing: false with zero parts', () => {
  const db = makeTestDb();
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.hasFirstListing, false);
});

test('reports hasFirstListing: true once any part exists, regardless of status', () => {
  const db = makeTestDb();
  addPart(db, 1, 'draft');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.hasFirstListing, true);
});

test('reports hasPublishedListing: false when parts exist but none are published', () => {
  const db = makeTestDb();
  addPart(db, 1, 'draft');
  addPart(db, 1, 'reviewed');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.hasPublishedListing, false);
});

test('reports hasPublishedListing: true once at least one part is published', () => {
  const db = makeTestDb();
  addPart(db, 1, 'draft');
  addPart(db, 1, 'published');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.hasPublishedListing, true);
});

test('reports complete: true only when every step is done', () => {
  const db = makeTestDb();
  connectEbay(db, 1, FULLY_CONFIGURED);
  addPart(db, 1, 'published');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.complete, true);
});

test('reports complete: false when eBay is connected and published but policies are not configured', () => {
  const db = makeTestDb();
  connectEbay(db, 1);
  addPart(db, 1, 'published');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.complete, false);
});

test('reports complete: false when everything else is done but nothing is published yet', () => {
  const db = makeTestDb();
  connectEbay(db, 1, FULLY_CONFIGURED);
  addPart(db, 1, 'draft');
  const status = getOnboardingStatus(db, 1);
  assert.equal(status.complete, false);
});

test('scopes everything to the given user only', () => {
  const db = makeTestDb();
  connectEbay(db, 2, FULLY_CONFIGURED);
  addPart(db, 2, 'published');

  const status = getOnboardingStatus(db, 1);

  assert.equal(status.ebayConnected, false);
  assert.equal(status.policiesConfigured, false);
  assert.equal(status.hasFirstListing, false);
  assert.equal(status.hasPublishedListing, false);
  assert.equal(status.complete, false);
});
