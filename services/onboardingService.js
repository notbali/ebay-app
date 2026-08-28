// Pure query logic for the dashboard's getting-started checklist, kept separate from routes/
// so it's testable against an isolated in-memory DB (same pattern as the other services/*).

function getOnboardingStatus(db, userId) {
  const conn = db.prepare('SELECT * FROM ebay_connections WHERE user_id = ?').get(userId);
  const ebayConnected = !!conn;
  const policiesConfigured = !!(conn
    && conn.merchant_location_key && conn.fulfillment_policy_id && conn.payment_policy_id && conn.return_policy_id);

  const counts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published
    FROM parts WHERE user_id = ?
  `).get(userId);
  const hasFirstListing = (counts.total || 0) > 0;
  const hasPublishedListing = (counts.published || 0) > 0;

  return {
    ebayConnected,
    policiesConfigured,
    hasFirstListing,
    hasPublishedListing,
    complete: ebayConnected && policiesConfigured && hasFirstListing && hasPublishedListing,
  };
}

module.exports = { getOnboardingStatus };
