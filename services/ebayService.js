const fetch = require('node-fetch');
const path = require('path');

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

// eBay fetches listing images itself from a public HTTPS URL - it can never reach localhost.
function buildImageUrls(part) {
  const photoPaths = JSON.parse(part.photo_paths_json || '[]');
  if (photoPaths.length === 0) return [];

  if (!process.env.PUBLIC_BASE_URL) {
    throw new Error(
      'PUBLIC_BASE_URL is not set in .env - eBay needs a public https URL to fetch photos from. ' +
      'Run `ngrok http 3000` and paste the https URL it prints into PUBLIC_BASE_URL, then restart the server.'
    );
  }

  const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return photoPaths.map((p) => `${base}/uploads/${path.basename(p)}`);
}

async function putInventoryItem(token, part, sku) {
  const specifics = JSON.parse(part.ai_specifics_json || '{}');
  const aspects = {};
  for (const [key, value] of Object.entries(specifics)) {
    if (key.toLowerCase() === 'condition') continue; // condition is a structured field below, not a free-text aspect
    aspects[key] = [String(value)];
  }

  const res = await fetch(`${BASE_URL}/sell/inventory/v1/inventory_item/${sku}`, {
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
      condition: part.ai_condition || 'USED_GOOD',
      product: {
        title: part.ai_title,
        description: part.ai_description,
        aspects,
        brand: part.ai_brand || undefined,
        mpn: part.ai_part_number || undefined,
        imageUrls: buildImageUrls(part),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay inventory item creation failed (${res.status}): ${errText}`);
  }
}

function offerBody(part, sku) {
  return {
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
  };
}

// Reuses an existing offer (PUT) if this part already has one from a prior attempt, rather than
// always creating a new one - otherwise every retry after a fixable error (e.g. a missing photo)
// leaves an orphaned duplicate unpublished offer sitting on the seller's account.
async function ensureOffer(token, part, sku) {
  const existingOfferId = part.ebay_offer_id;

  const res = await fetch(
    existingOfferId
      ? `${BASE_URL}/sell/inventory/v1/offer/${existingOfferId}`
      : `${BASE_URL}/sell/inventory/v1/offer`,
    {
      method: existingOfferId ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Language': 'en-US',
      },
      body: JSON.stringify(offerBody(part, sku)),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay offer ${existingOfferId ? 'update' : 'creation'} failed (${res.status}): ${errText}`);
  }

  if (existingOfferId) return existingOfferId;
  const data = await res.json();
  return data.offerId;
}

async function publishOfferById(token, offerId) {
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

// One action: create/update the inventory item, create/update its offer (reusing an existing
// one if this part was already pushed before), then publish. If the item+offer succeed but
// publish itself fails, the error carries the sku/offerId so the caller can persist them -
// the next retry then reuses that offer instead of minting another orphaned one.
async function publishListing(part) {
  const token = await getAccessToken();
  const sku = part.ebay_sku || `IND-${part.id}-${Date.now()}`;

  await putInventoryItem(token, part, sku);
  const offerId = await ensureOffer(token, part, sku);

  try {
    const result = await publishOfferById(token, offerId);
    return { sku, offerId, listingId: result.listingId };
  } catch (err) {
    err.sku = sku;
    err.offerId = offerId;
    throw err;
  }
}

module.exports = { publishListing };
