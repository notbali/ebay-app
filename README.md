# Industrial Parts Listing Assistant

A small full-stack app: upload one or more photos/notes about a part (drag & drop supported) →
Claude identifies it and drafts a title, description, pricing, condition, and item specifics →
you review and edit everything in a dashboard → one explicit, confirmed click publishes it live
to eBay.

## Stack
- Backend: Node.js + Express
- DB: SQLite (via Node's built-in `node:sqlite`), file-based, no separate DB server needed
- Frontend: plain HTML/CSS/JS dashboard (no build step)
- AI: Anthropic Claude API (Claude Opus 5, vision + text, structured JSON output)
- Marketplace: eBay Inventory API

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

- **`ANTHROPIC_API_KEY`** — from your [Anthropic Console](https://console.anthropic.com/settings/keys)
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
- **`PUBLIC_BASE_URL`** — eBay's Inventory API fetches listing photos itself from a public HTTPS
  URL; it can never reach `localhost`. For local development, run `ngrok http 3000` in a separate
  terminal and paste the `https://...ngrok-free.app` URL it prints here (it changes each time you
  restart ngrok on the free tier — update `.env` and restart the server when it does). For a real
  deployment, use your app's actual public domain instead.

Start with `EBAY_ENV=sandbox` and eBay's sandbox credentials until you've tested the flow
end-to-end — this avoids any risk of pushing test data into your live store.

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000`.

## How the review → publish flow works

1. **Generate** — uploading photo(s)/notes only calls Claude and saves a row in your local
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

- **Condition**: Claude proposes a condition (New, New-Other, Used Excellent/Very Good/Good/
  Acceptable, or For Parts/Not Working) based on the photo and notes, editable in the dashboard
  before pushing. Still worth double-checking — condition assessment from a photo alone has real
  limits, and it directly affects buyer expectations and return risk.
- **Category ID**: `EBAY_CATEGORY_ID` in `.env` needs to match the real eBay category for each
  part type — relays and PLC modules may live in different categories. You may want to let
  Claude suggest a category per item, or maintain a small lookup table.
- **Access tokens**: the eBay service fetches a fresh access token on every request for
  simplicity. This works fine at low volume; if you start batch-pushing many items at once,
  you may want to cache the token for its ~2 hour lifetime.
- **Pricing**: Claude's price suggestions are rough estimates based on general knowledge, not
  live comps. Worth spot-checking against actual sold listings before publishing, especially
  for less common parts.
- **Photos require `PUBLIC_BASE_URL` to be set and reachable** — if you're using ngrok and it's
  not currently running (or the free-tier URL rotated since you last set it), publishing will
  fail with a clear error rather than a cryptic eBay one, but it'll still fail. Up to 12 photos
  per listing (eBay's limit).

## Project structure

```
ebay-app/
├── server.js              # Express app entry point
├── db.js                  # SQLite schema/setup
├── routes/parts.js        # API routes: upload, list, edit, photos add/remove, publish
├── services/
│   ├── claudeService.js   # Calls Claude API to identify part + draft listing
│   └── ebayService.js     # Calls eBay Inventory API (create/update item+offer, publish)
├── public/                # Dashboard (HTML/CSS/JS, no build step)
├── uploads/                # Uploaded part photos
└── data/app.db             # SQLite database (created on first run)
```
