const express = require('express');
const fetch = require('node-fetch');
const { requireAuth, getSessionUser } = require('../middleware/auth');
const { signCookieValue, verifyCookieValue } = require('../services/authService');
const { TOKEN_URL, AUTHORIZE_URL, listSellerLocations, listSellerPolicies } = require('../services/ebayService');
const {
  saveUserEbayTokens, updateUserEbaySettings, disconnectUser, getConnection, getRefreshToken,
} = require('../services/ebayAccountService');

const router = express.Router();

// sell.inventory covers listing/publishing (and merchant-location lookups); sell.account.readonly
// is only needed so Settings can show the seller's real business policies as a picker instead of
// raw policy-ID text fields. Sellers who connected before this scope was added will need to
// reconnect once to pick it up - see the /policies route below.
const SCOPE = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
].join(' ');
const STATE_TTL_MS = 10 * 60 * 1000;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

// Starts the 3-legged consent flow. "state" is a signed "<userId>.<timestamp>" value (no extra
// DB table) - the callback re-verifies the signature, checks it's fresh, and checks the userId
// matches whoever is logged in when eBay redirects back, which is what actually blocks the OAuth
// login-CSRF attack (an attacker can't forge a state that names a victim's user id without
// SESSION_SECRET, and can't complete a victim's session from their own signed state either).
router.get('/connect', requireAuth, (req, res) => {
  const clientId = process.env.EBAY_CLIENT_ID;
  const redirectUri = process.env.EBAY_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'eBay OAuth is not configured (EBAY_CLIENT_ID / EBAY_OAUTH_REDIRECT_URI)' });
  }

  const state = signCookieValue(`${req.user.id}.${Date.now()}`, secret());
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
  });
  res.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
});

// eBay redirects the browser here after consent - this is a page navigation, not a fetch() call,
// so failures redirect back into the dashboard with a query flag instead of returning raw JSON.
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect(`/?ebay=error&reason=${encodeURIComponent(String(oauthError))}`);

  const user = getSessionUser(req);
  if (!user) return res.redirect('/?ebay=error&reason=not_logged_in');

  const verifiedValue = state && verifyCookieValue(String(state), secret());
  if (!verifiedValue) return res.redirect('/?ebay=error&reason=invalid_state');

  const [stateUserId, stateTs] = verifiedValue.split('.');
  if (Number(stateUserId) !== user.id) return res.redirect('/?ebay=error&reason=state_mismatch');
  if (Date.now() - Number(stateTs) > STATE_TTL_MS) return res.redirect('/?ebay=error&reason=state_expired');
  if (!code) return res.redirect('/?ebay=error&reason=missing_code');

  try {
    const basicAuth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', String(code));
    params.append('redirect_uri', process.env.EBAY_OAUTH_REDIRECT_URI);

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
      body: params,
    });
    if (!tokenRes.ok) {
      console.error('eBay OAuth token exchange failed:', await tokenRes.text());
      return res.redirect('/?ebay=error&reason=token_exchange_failed');
    }

    const data = await tokenRes.json();
    const expiresAt = data.refresh_token_expires_in
      ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
      : null;

    saveUserEbayTokens(user.id, { refreshToken: data.refresh_token, expiresAt, scope: data.scope });
    res.redirect('/?ebay=connected');
  } catch (err) {
    console.error('eBay OAuth callback error:', err);
    res.redirect('/?ebay=error&reason=unexpected');
  }
});

router.get('/status', requireAuth, (req, res) => {
  const conn = getConnection(req.user.id);
  if (!conn) return res.json({ connected: false });
  res.json({
    connected: true,
    connectedAt: conn.connected_at,
    policiesConfigured: !!(
      conn.merchant_location_key && conn.fulfillment_policy_id && conn.payment_policy_id && conn.return_policy_id
    ),
  });
});

router.post('/disconnect', requireAuth, (req, res) => {
  disconnectUser(req.user.id);
  res.json({ success: true });
});

// For Settings' pickers: the seller's real merchant locations and business policies, straight
// from eBay, so they select what they already recognize instead of hunting for raw IDs.
router.get('/locations', requireAuth, async (req, res) => {
  const refreshToken = getRefreshToken(req.user.id);
  if (!refreshToken) return res.status(400).json({ error: 'Connect your eBay account first' });

  try {
    res.json(await listSellerLocations(refreshToken));
  } catch (err) {
    console.error('eBay location lookup failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/policies', requireAuth, async (req, res) => {
  const refreshToken = getRefreshToken(req.user.id);
  if (!refreshToken) return res.status(400).json({ error: 'Connect your eBay account first' });

  try {
    res.json(await listSellerPolicies(refreshToken));
  } catch (err) {
    console.error('eBay policy lookup failed:', err.message);
    // Most common cause: this connection predates the sell.account.readonly scope. Flag it
    // distinctly so the dashboard can prompt "reconnect" instead of a generic error.
    const needsReconnect = /invalid_scope|insufficient|unauthorized/i.test(err.message);
    res.status(needsReconnect ? 409 : 500).json({ error: err.message, needsReconnect });
  }
});

router.get('/settings', requireAuth, (req, res) => {
  const conn = getConnection(req.user.id);
  res.json({
    merchantLocationKey: conn?.merchant_location_key || '',
    fulfillmentPolicyId: conn?.fulfillment_policy_id || '',
    paymentPolicyId: conn?.payment_policy_id || '',
    returnPolicyId: conn?.return_policy_id || '',
  });
});

router.put('/settings', requireAuth, (req, res) => {
  try {
    updateUserEbaySettings(req.user.id, {
      merchantLocationKey: req.body.merchantLocationKey,
      fulfillmentPolicyId: req.body.fulfillmentPolicyId,
      paymentPolicyId: req.body.paymentPolicyId,
      returnPolicyId: req.body.returnPolicyId,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
