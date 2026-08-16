const fetch = require('node-fetch');

const BASE_URL = process.env.EBAY_ENV === 'sandbox'
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';

const TOKEN_URL = process.env.EBAY_ENV === 'sandbox'
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token';

// eBay access tokens from a refresh token are short-lived (~2 hrs). We fetch a fresh one
// per request rather than caching, to keep this simple and avoid stale-token bugs.
async function getAccessToken() {
  const basicAuth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', process.env.EBAY_REFRESH_TOKEN);
  params.append(
    'scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory'
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: params,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay token refresh failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Creates the inventory item + a draft offer. Deliberately does NOT call the
// publishOffer endpoint, so the listing exists in Seller Hub as a draft only -
// it will not go live until you explicitly publish it (in Seller Hub, or via
// the separate /publish route below, which you trigger manually per listing).
async function pushDraftListing(part) {
  const token = await getAccessToken();
  const sku = `IND-${part.id}-${Date.now()}`;

  const specifics = JSON.parse(part.ai_specifics_json || '{}');
  const aspects = {};
  for (const [key, value] of Object.entries(specifics)) {
    aspects[key] = [String(value)];
  }

  // 1. Create/replace the inventory item
  const invRes = await fetch(`${BASE_URL}/sell/inventory/v1/inventory_item/${sku}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Language': 'en-US',
    },
    body: JSON.stringify({
      availability: {
        shipToLocationAvailability: { quantity: 1 },
      },
      condition: 'USED_EXCELLENT', // adjust per item as needed - see README
      product: {
        title: part.ai_title,
        description: part.ai_description,
        aspects,
        brand: part.ai_brand || undefined,
        mpn: part.ai_part_number || undefined,
      },
    }),
  });

  if (!invRes.ok) {
    const errText = await invRes.text();
    throw new Error(`eBay inventory item creation failed (${invRes.status}): ${errText}`);
  }

  // 2. Create a draft offer (unpublished - buyers cannot see this yet)
  const offerRes = await fetch(`${BASE_URL}/sell/inventory/v1/offer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Language': 'en-US',
    },
    body: JSON.stringify({
      sku,
      marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      categoryId: process.env.EBAY_CATEGORY_ID,
      listingDescription: part.ai_description,
      pricingSummary: {
        price: {
          value: part.ai_price_low ? String(part.ai_price_low) : '0.00',
          currency: 'USD',
        },
      },
      listingPolicies: {
        fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID,
        paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID,
        returnPolicyId: process.env.EBAY_RETURN_POLICY_ID,
      },
      merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY,
    }),
  });

  if (!offerRes.ok) {
    const errText = await offerRes.text();
    throw new Error(`eBay offer creation failed (${offerRes.status}): ${errText}`);
  }

  const offerData = await offerRes.json();
  return { sku, offerId: offerData.offerId };
}

// Separate, explicit, one-at-a-time publish call. Only wire a button to this
// once you've reviewed the draft in eBay Seller Hub or your own dashboard.
async function publishOffer(offerId) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/sell/inventory/v1/offer/${offerId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay publish failed (${res.status}): ${errText}`);
  }

  return res.json();
}

module.exports = { pushDraftListing, publishOffer };
