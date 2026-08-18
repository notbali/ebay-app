# Industrial Parts Listing Assistant

A small full-stack app: upload one or more photos/notes about a part (drag & drop supported) →
AI identifies it and drafts a title, description, pricing, condition, and item specifics →
you review and edit everything in a dashboard → one explicit, confirmed click publishes it live
to eBay.

## Stack
- Backend: Node.js + Express
- DB: SQLite (via Node's built-in `node:sqlite`), file-based, no separate DB server needed
- Frontend: plain HTML/CSS/JS dashboard (no build step)
- AI: pluggable via `AI_PROVIDER` (`services/aiService.js`) - defaults to Kimi K2.6 via NVIDIA's
  free NIM tier (vision + text, structured JSON output), or Anthropic Claude as a fallback
- Marketplace: eBay Inventory API
- Photo hosting: Cloudflare R2 (eBay needs a public HTTPS URL to fetch each photo from)

## 1. Install

Requires **Node.js 22+** (uses the built-in `node:sqlite` module, which is experimental in Node 22
and stable from Node 24 — the `npm start`/`npm run dev` scripts already pass the
`--experimental-sqlite` flag for you).

```bash
npm install
```

## 2. Configure credentials

Copy the example env file and fill in your real values:

```bash
cp .env.example .env
```

You'll need:

- **AI provider** — set `AI_PROVIDER` to `kimi` (default) or `claude`:
  - `kimi` uses Moonshot AI's Kimi K2.6 via NVIDIA's free NIM tier — sign up free at
    [build.nvidia.com](https://build.nvidia.com), then Account → API Keys, for `NVIDIA_API_KEY`.
    Free tier is rate-limited to roughly 40 requests/minute.
  - `claude` uses Anthropic's API — get `ANTHROPIC_API_KEY` from your
    [Anthropic Console](https://console.anthropic.com/settings/keys). Paid only, no free tier.
- **eBay credentials** — from your eBay Developer account:
  - `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — your app's keys
  - `EBAY_REFRESH_TOKEN` — generated once via eBay's OAuth user-consent flow (this authorizes
    the app to act on your seller account; it's a one-time setup step in eBay's developer docs
    under "Generating a User Access Token")
  - `EBAY_MERCHANT_LOCATION_KEY` — your inventory location, set up in Seller Hub or via the
    Inventory API's `/location` endpoint
  - `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID` — business
    policy IDs from your eBay account (Seller Hub → Business Policies)
  - `EBAY_CATEGORY_ID` — the eBay category ID your parts should list under (verify the exact
    ID for your specific product type at eBay's category lookup)
- **Cloudflare R2 credentials** — eBay's Inventory API fetches listing photos itself from a
  public HTTPS URL; it can never reach `localhost`, so each photo is uploaded to R2 right before
  publishing:
  - Create a bucket in the Cloudflare dashboard (dash.cloudflare.com) → R2, and enable public
    access on it (either the free `r2.dev` subdomain, or your own custom domain)
  - Create an R2 API token (R2 → Manage API Tokens) scoped to that bucket for
    `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
  - `R2_ACCOUNT_ID` is shown on your Cloudflare dashboard's R2 overview page
  - `R2_PUBLIC_BASE_URL` is the public URL the bucket is served from, no trailing slash

Start with `EBAY_ENV=sandbox` and eBay's sandbox credentials until you've tested the flow
end-to-end — this avoids any risk of pushing test data into your live store.

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000`.

## How the review → publish flow works

1. **Generate** — uploading photo(s)/notes only calls the AI provider and saves a row in your local
   SQLite DB. Nothing touches eBay at this point.
2. **Review/edit** — you can edit the title, description, price, condition, photos, and specifics
   directly in the dashboard before anything is sent anywhere. Add or remove photos at any point
   before publishing.
3. **Publish** — one button, gated behind a confirmation dialog that says publishing makes the
   listing live and visible to real buyers immediately. Under the hood this creates/updates the
   eBay inventory item, creates/updates its offer, and publishes it, all in one request.

Earlier versions of this app had a separate "push to eBay as an unpublished draft" step before
publishing. That was removed: eBay's own Seller Hub UI doesn't surface unpublished Inventory-API
offers anywhere useful (they don't show up under Seller Hub → Listings → Drafts, which is a
different, older mechanism), so the intermediate step added an eBay-side API call without a
matching way to actually review it there. The real review step is this dashboard, before you
click Publish.

**Retries are safe.** If a publish attempt fails after the item/offer were created (e.g. eBay
rejects the listing for a fixable reason), the app remembers that item's SKU and offer ID and
reuses them on your next attempt instead of creating a duplicate. Fix the issue and click Publish
again.

## Known things to double check before relying on this for real inventory

- **Condition**: the AI proposes a condition (New, New-Other, Used Excellent/Very Good/Good/
  Acceptable, or For Parts/Not Working) based on the photo and notes, editable in the dashboard
  before pushing. Still worth double-checking — condition assessment from a photo alone has real
  limits, and it directly affects buyer expectations and return risk.
- **Category**: the AI proposes a product-type search phrase per item (e.g. "hydraulic spin-on
  filter"), which the app looks up against eBay's real category tree via the Taxonomy API and
  stores the matching leaf category — shown and searchable/overridable in the dashboard. The
  automatic top match isn't always the most specific one (e.g. it may pick a generic "Filters"
  category over "Hydraulic Filters"), so it's worth checking before publishing. `EBAY_CATEGORY_ID`
  in `.env` is now only a fallback for drafts where the lookup didn't run or found nothing.
- **Access tokens**: the eBay service fetches a fresh access token on every request for
  simplicity. This works fine at low volume; if you start batch-pushing many items at once,
  you may want to cache the token for its ~2 hour lifetime.
- **Pricing**: the AI's price suggestions are rough estimates based on general knowledge, not
  live comps. Worth spot-checking against actual sold listings before publishing, especially
  for less common parts.
- **Photos require the R2 env vars to be filled in** — each photo is uploaded to your R2 bucket
  right before eBay is called, so publishing will fail if those credentials are missing or wrong.
  Up to 12 photos per listing (eBay's limit).

## Project structure

```
ebay-app/
├── server.js              # Express app entry point
├── db.js                  # SQLite schema/setup
├── routes/parts.js        # API routes: upload, list, edit, photos add/remove, publish
├── services/
│   ├── aiService.js       # Picks the AI provider below based on AI_PROVIDER
│   ├── kimiService.js     # Calls Kimi K2.6 (via NVIDIA NIM) to identify part + draft listing
│   ├── claudeService.js   # Calls Claude API to identify part + draft listing (fallback provider)
│   ├── ebayService.js     # Calls eBay Inventory API (create/update item+offer, publish)
│   └── r2Service.js       # Uploads photos to Cloudflare R2 for eBay's imageUrls
├── public/                # Dashboard (HTML/CSS/JS, no build step)
├── uploads/                # Uploaded part photos
└── data/app.db             # SQLite database (created on first run)
```
