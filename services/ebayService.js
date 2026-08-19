const fetch = require('node-fetch');
const { uploadPartPhoto } = require('./r2Service');

const BASE_URL = process.env.EBAY_ENV === 'sandbox'
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com';

const TOKEN_URL = process.env.EBAY_ENV === 'sandbox'
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token';

// User-consent redirect endpoint for the 3-legged OAuth flow (routes/ebayAuth.js) - distinct
// from TOKEN_URL, which is the identity API's token-exchange endpoint.
const AUTHORIZE_URL = process.env.EBAY_ENV === 'sandbox'
  ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
  : 'https://auth.ebay.com/oauth2/authorize';

// eBay access tokens from a refresh token are short-lived (~2 hrs). We fetch a fresh one
// per request rather than caching, to keep this simple and avoid stale-token bugs.
// refreshToken is this seller's own token (routes/ebayAuth.js's OAuth flow), not a shared
// app-level credential - every seller only ever authorizes their own eBay account.
async function getAccessToken(refreshToken, scope = 'https://api.ebay.com/oauth/api_scope/sell.inventory') {
  if (!refreshToken) throw new Error('Missing eBay refresh token for this seller');

  const basicAuth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('scope', scope);

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

// App-level token (client credentials, no user login) for public marketplace metadata like the
// category tree - separate from getAccessToken(), which is the user token for selling actions.
async function getAppAccessToken() {
  const basicAuth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.ebay.com/oauth/api_scope');

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
    throw new Error(`eBay app token request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Lets Settings show the seller's real merchant locations as a picker instead of a raw
// "paste your location key" text field - uses the same sell.inventory-scoped token as
// publishing, so it works for every already-connected seller with no reconnect needed.
async function listSellerLocations(refreshToken) {
  const token = await getAccessToken(refreshToken);
  const res = await fetch(`${BASE_URL}/sell/inventory/v1/location`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay location lookup failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return (data.locations || []).map((l) => {
    const addr = l.location?.address || {};
    const place = [addr.city, addr.stateOrProvince, addr.postalCode].filter(Boolean).join(', ');
    return {
      key: l.merchantLocationKey,
      label: [l.name || l.merchantLocationKey, place].filter(Boolean).join(' — '),
    };
  });
}

const ACCOUNT_READONLY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.account.readonly';

async function fetchPolicyList(url, token, arrayKey, idKey) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay policy lookup failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return (data[arrayKey] || []).map((p) => ({ id: p[idKey], label: p.name }));
}

// Lets Settings show the seller's real business policies as pickers instead of raw policy-ID
// text fields. Needs the sell.account.readonly scope, which older connections (from before this
// existed) won't have - callers should expect this to throw for those and prompt a reconnect.
async function listSellerPolicies(refreshToken) {
  const token = await getAccessToken(refreshToken, ACCOUNT_READONLY_SCOPE);
  const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  const [fulfillment, payment, returnPolicies] = await Promise.all([
    fetchPolicyList(`${BASE_URL}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`, token, 'fulfillmentPolicies', 'fulfillmentPolicyId'),
    fetchPolicyList(`${BASE_URL}/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`, token, 'paymentPolicies', 'paymentPolicyId'),
    fetchPolicyList(`${BASE_URL}/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`, token, 'returnPolicies', 'returnPolicyId'),
  ]);

  return { fulfillment, payment, return: returnPolicies };
}

let cachedCategoryTreeId = null;
async function getCategoryTreeId(token) {
  if (cachedCategoryTreeId) return cachedCategoryTreeId;

  const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const res = await fetch(
    `${BASE_URL}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay category tree lookup failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  cachedCategoryTreeId = data.categoryTreeId;
  return cachedCategoryTreeId;
}

// Looks up real eBay leaf categories matching a plain-language query, e.g. "general purpose
// relay" -> [{categoryId: "36328", categoryName: "General Purpose Relays", breadcrumb: "..."}].
// Only leaf categories are ever returned by this eBay endpoint, so no separate leaf check needed.
async function suggestCategories(query) {
  const token = await getAppAccessToken();
  const treeId = await getCategoryTreeId(token);

  const res = await fetch(
    `${BASE_URL}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay category suggestion failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return (data.categorySuggestions || []).map((s) => ({
    categoryId: s.category.categoryId,
    categoryName: s.category.categoryName,
    breadcrumb: [...(s.categoryTreeNodeAncestors || [])].reverse()
      .map((a) => a.categoryName)
      .concat(s.category.categoryName)
      .join(' > '),
  }));
}

// Maps this app's condition enum values (the ones offered in the dashboard dropdown) to eBay's
// numeric condition IDs, so a chosen condition can be checked against a category's allowed set
// before publishing. NEW/NEW_OTHER/SELLER_REFURBISHED/FOR_PARTS_OR_NOT_WORKING and USED_GOOD are
// confirmed directly from eBay's own get_item_condition_policies/error responses; USED_VERY_GOOD
// and USED_EXCELLENT are corroborated by eBay's public docs; USED_ACCEPTABLE (6000) follows the
// same 1000-increment ladder as its confirmed neighbors (USED_GOOD=5000, FOR_PARTS=7000).
const CONDITION_ID_BY_ENUM = {
  NEW: '1000',
  NEW_OTHER: '1500',
  SELLER_REFURBISHED: '2500',
  USED_EXCELLENT: '3000',
  USED_VERY_GOOD: '4000',
  USED_GOOD: '5000',
  USED_ACCEPTABLE: '6000',
  FOR_PARTS_OR_NOT_WORKING: '7000',
};
const ENUM_BY_CONDITION_ID = Object.fromEntries(
  Object.entries(CONDITION_ID_BY_ENUM).map(([enumName, id]) => [id, enumName])
);

// eBay restricts which item conditions are valid per leaf category (e.g. most Business &
// Industrial categories reject the fine-grained USED_VERY_GOOD/GOOD/ACCEPTABLE tiers and only
// accept NEW/NEW_OTHER/SELLER_REFURBISHED/USED_EXCELLENT("Used")/FOR_PARTS_OR_NOT_WORKING).
// This fetches the marketplace-wide policy list once (it doesn't change often) and caches it,
// so every publish can check the chosen condition against the offer's actual category first.
let cachedConditionPolicyByCategory = null;
async function getConditionPolicyByCategory(token) {
  if (cachedConditionPolicyByCategory) return cachedConditionPolicyByCategory;

  const marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const res = await fetch(
    `${BASE_URL}/sell/metadata/v1/marketplace/${marketplaceId}/get_item_condition_policies`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay item condition policy lookup failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const map = new Map();
  for (const policy of data.itemConditionPolicies || []) {
    map.set(policy.categoryId, policy.itemConditions || []);
  }
  cachedConditionPolicyByCategory = map;
  return map;
}

// Fails fast, before any eBay write, if the seller's chosen condition isn't valid for this
// listing's category - eBay would otherwise reject the offer at publish time with an opaque
// numeric-ID error. Skips silently (rather than blocking) if the category or condition isn't one
// we have data for, since that's a "can't verify" case, not a known mismatch.
async function validateCondition(part) {
  const categoryId = part.ai_category_id || process.env.EBAY_CATEGORY_ID;
  const condition = part.ai_condition || 'USED_GOOD';
  const conditionId = CONDITION_ID_BY_ENUM[condition];
  if (!categoryId || !conditionId) return;

  // Uses the app-level token (like suggestCategories/getCategoryTreeId), not the user selling
  // token, since this is public marketplace metadata rather than a selling action.
  const appToken = await getAppAccessToken();
  const policyByCategory = await getConditionPolicyByCategory(appToken);
  const allowed = policyByCategory.get(String(categoryId));
  if (!allowed) return;

  const isAllowed = allowed.some((c) => c.conditionId === conditionId);
  if (isAllowed) return;

  const validLabels = allowed.map((c) => c.conditionDescription).join(', ');
  throw new Error(
    `Condition "${condition}" isn't valid for category "${part.ai_category_name || categoryId}". ` +
    `Valid conditions for this category: ${validLabels}. Change the condition in the dashboard and try again.`
  );
}

// For the dashboard's condition dropdown: returns just the conditions eBay actually allows for
// this category, labeled with eBay's own wording (e.g. "Used" rather than this app's internal
// "USED_EXCELLENT" enum name) - so the seller picks from real options instead of guessing which
// of the app's generic labels maps to what eBay allows for this particular category.
async function getValidConditions(categoryId) {
  if (!categoryId) return null;

  const appToken = await getAppAccessToken();
  const policyByCategory = await getConditionPolicyByCategory(appToken);
  const allowed = policyByCategory.get(String(categoryId));
  if (!allowed) return null;

  return allowed
    .filter((c) => ENUM_BY_CONDITION_ID[c.conditionId])
    .map((c) => ({ value: ENUM_BY_CONDITION_ID[c.conditionId], label: c.conditionDescription }));
}

// eBay fetches listing images itself from a public HTTPS URL - it can never reach localhost -
// so each photo is uploaded to R2 (namespaced per seller) and eBay is given the resulting URLs.
async function buildImageUrls(part) {
  const photoPaths = JSON.parse(part.photo_paths_json || '[]');
  return Promise.all(photoPaths.map((p) => uploadPartPhoto(p, part.user_id)));
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
        shipToLocationAvailability: { quantity: part.ai_quantity || 1 },
      },
      condition: part.ai_condition || 'USED_GOOD',
      packageWeightAndSize: part.ai_weight_lb ? {
        weight: { value: part.ai_weight_lb, unit: 'POUND' },
        dimensions: (part.ai_length_in && part.ai_width_in && part.ai_height_in) ? {
          length: part.ai_length_in,
          width: part.ai_width_in,
          height: part.ai_height_in,
          unit: 'INCH',
        } : undefined,
        packageType: 'PACKAGE_THICK_ENVELOPE',
      } : undefined,
      product: {
        title: part.ai_title,
        description: part.ai_description,
        aspects,
        // Many eBay categories require brand+MPN as a pair - sending only one half (e.g. a
        // legible part number but no visible manufacturer name, common on generic industrial
        // parts) gets rejected with a "BrandMPN invalid or missing" error. eBay's own convention
        // for this is to fill the missing half with "Unbranded"/"Does Not Apply" rather than
        // omitting it, whenever the other half is actually known.
        brand: part.ai_brand || (part.ai_part_number ? 'Unbranded' : undefined),
        mpn: part.ai_part_number || (part.ai_brand ? 'Does Not Apply' : undefined),
        imageUrls: await buildImageUrls(part),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`eBay inventory item creation failed (${res.status}): ${errText}`);
  }
}

function offerBody(part, sku, ebayCreds) {
  return {
    sku,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: part.ai_quantity || 1,
    categoryId: part.ai_category_id || process.env.EBAY_CATEGORY_ID,
    listingDescription: part.ai_description,
    pricingSummary: {
      price: {
        value: part.ai_price_low ? String(part.ai_price_low) : '0.00',
        currency: 'USD',
      },
    },
    listingPolicies: {
      fulfillmentPolicyId: ebayCreds.fulfillmentPolicyId,
      paymentPolicyId: ebayCreds.paymentPolicyId,
      returnPolicyId: ebayCreds.returnPolicyId,
      // The referenced fulfillment policy is set up (in the seller's own Seller Hub) to use
      // calculated shipping based on the buyer's location. This override zeroes the cost for
      // just this offer when the seller wants free shipping, without touching the policy used
      // by every other listing.
      ...(part.ai_free_shipping ? {
        shippingCostOverrides: [
          { priority: 1, shippingServiceType: 'DOMESTIC', shippingCost: { value: '0.00', currency: 'USD' } },
        ],
      } : {}),
    },
    merchantLocationKey: ebayCreds.merchantLocationKey,
  };
}

// Reuses an existing offer (PUT) if this part already has one from a prior attempt, rather than
// always creating a new one - otherwise every retry after a fixable error (e.g. a missing photo)
// leaves an orphaned duplicate unpublished offer sitting on the seller's account.
async function ensureOffer(token, part, sku, ebayCreds) {
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
      body: JSON.stringify(offerBody(part, sku, ebayCreds)),
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
async function publishListing(part, ebayCreds) {
  const token = await getAccessToken(ebayCreds.refreshToken);
  const sku = part.ebay_sku || `IND-${part.id}-${Date.now()}`;

  await validateCondition(part);
  await putInventoryItem(token, part, sku);
  const offerId = await ensureOffer(token, part, sku, ebayCreds);

  try {
    const result = await publishOfferById(token, offerId);
    return { sku, offerId, listingId: result.listingId };
  } catch (err) {
    err.sku = sku;
    err.offerId = offerId;
    throw err;
  }
}

module.exports = {
  publishListing, suggestCategories, getValidConditions, listSellerLocations, listSellerPolicies,
  TOKEN_URL, AUTHORIZE_URL,
};
