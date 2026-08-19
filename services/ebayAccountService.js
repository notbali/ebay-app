const db = require('../db');
const { encrypt, decrypt } = require('./cryptoService');

function getConnection(userId) {
  return db.prepare('SELECT * FROM ebay_connections WHERE user_id = ?').get(userId) || null;
}

function isConnected(userId) {
  return !!getConnection(userId);
}

// Stores/replaces the tokens from a fresh OAuth authorize-code exchange or a re-consent.
function saveUserEbayTokens(userId, { refreshToken, expiresAt, scope }) {
  const existing = getConnection(userId);
  if (existing) {
    db.prepare(`
      UPDATE ebay_connections
      SET refresh_token_encrypted = ?, refresh_token_expires_at = ?, scopes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(encrypt(refreshToken), expiresAt || null, scope || null, userId);
  } else {
    db.prepare(`
      INSERT INTO ebay_connections (user_id, refresh_token_encrypted, refresh_token_expires_at, scopes, connected_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(userId, encrypt(refreshToken), expiresAt || null, scope || null);
  }
}

function updateUserEbaySettings(userId, { merchantLocationKey, fulfillmentPolicyId, paymentPolicyId, returnPolicyId }) {
  const existing = getConnection(userId);
  if (!existing) throw new Error('Connect your eBay account before configuring settings');

  db.prepare(`
    UPDATE ebay_connections
    SET merchant_location_key = ?, fulfillment_policy_id = ?, payment_policy_id = ?, return_policy_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(merchantLocationKey || null, fulfillmentPolicyId || null, paymentPolicyId || null, returnPolicyId || null, userId);
}

function disconnectUser(userId) {
  db.prepare('DELETE FROM ebay_connections WHERE user_id = ?').run(userId);
}

// For Settings' location/policy pickers, which need the seller's raw refresh token before any
// policies are configured yet - unlike getUserEbayCreds(), this doesn't require settings to
// already be filled in.
function getRefreshToken(userId) {
  const conn = getConnection(userId);
  return conn ? decrypt(conn.refresh_token_encrypted) : null;
}

// Resolves everything services/ebayService.js needs to publish on this user's behalf. Throws a
// clear, seller-facing error (surfaced by routes/parts.js's publish route) rather than a generic
// null-pointer failure deep inside the eBay API call chain.
function getUserEbayCreds(userId) {
  const conn = getConnection(userId);
  if (!conn) {
    throw new Error('Connect your eBay account first (Settings) before publishing a listing.');
  }
  if (!conn.merchant_location_key || !conn.fulfillment_policy_id || !conn.payment_policy_id || !conn.return_policy_id) {
    throw new Error('Finish setting up your eBay shipping/payment/return policies (Settings) before publishing a listing.');
  }

  return {
    refreshToken: decrypt(conn.refresh_token_encrypted),
    merchantLocationKey: conn.merchant_location_key,
    fulfillmentPolicyId: conn.fulfillment_policy_id,
    paymentPolicyId: conn.payment_policy_id,
    returnPolicyId: conn.return_policy_id,
  };
}

module.exports = {
  getConnection,
  isConnected,
  saveUserEbayTokens,
  updateUserEbaySettings,
  disconnectUser,
  getUserEbayCreds,
  getRefreshToken,
};
