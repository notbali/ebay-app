# Industrial Parts Listing Assistant

A small full-stack app: upload a photo/notes about a part → Gemini identifies it and drafts a
title, description, pricing, and item specifics → you review and edit in a dashboard → one click
pushes it to eBay as an **unpublished draft offer**. Nothing goes live on eBay until you take a
separate, explicit publish action.

## Stack
- Backend: Node.js + Express
- DB: SQLite (via `better-sqlite3`), file-based, no separate DB server needed
- Frontend: plain HTML/CSS/JS dashboard (no build step)
- AI: Google Gemini API (vision + text, free tier)
- Marketplace: eBay Inventory API

## 1. Install

```bash
npm install
```

## 2. Configure credentials

Copy the example env file and fill in your real values:

```bash
cp .env.example .env
```

You'll need:

- **`GEMINI_API_KEY`** — a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
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

Start with `EBAY_ENV=sandbox` and eBay's sandbox credentials until you've tested the flow
end-to-end — this avoids any risk of pushing test data into your live store.

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000`.

## How the review/draft safety works

1. **Generate** — uploading a photo/notes only calls Claude and saves a row in your local
   SQLite DB. Nothing touches eBay at this point.
2. **Review/edit** — you can edit the title, description, price, and specifics directly in the
   dashboard before anything is sent anywhere.
3. **Push to eBay** — this calls eBay's Inventory API to create the item and an **offer**, but
   deliberately never calls `publishOffer`. The listing exists in your Seller Hub as a draft,
   invisible to buyers.
4. **Publish** — a separate route (`POST /api/parts/:id/publish`) exists in `routes/parts.js`
   but is intentionally **not wired to a button** in the dashboard yet. That's on purpose — add
   the button yourself once you're comfortable, or just publish drafts manually from Seller Hub.

## Known things to double check before relying on this for real inventory

- **Condition mapping**: the eBay push currently hardcodes `condition: 'USED_EXCELLENT'`. Your
  parts likely span multiple real conditions (used, refurbished, new-surplus, for-parts). You'll
  want to add a condition field to the dashboard and pass it through instead of hardcoding it.
- **Category ID**: `EBAY_CATEGORY_ID` in `.env` needs to match the real eBay category for each
  part type — relays and PLC modules may live in different categories. You may want to let
  Claude suggest a category per item, or maintain a small lookup table.
- **Access tokens**: the eBay service fetches a fresh access token on every request for
  simplicity. This works fine at low volume; if you start batch-pushing many items at once,
  you may want to cache the token for its ~2 hour lifetime.
- **Pricing**: Claude's price suggestions are rough estimates based on general knowledge, not
  live comps. Worth spot-checking against actual sold listings before publishing, especially
  for less common parts.
- **Photos**: only single-photo upload is wired up. eBay listings support multiple images —
  worth extending `multer` to accept an array of files if that matters to you.

## Project structure

```
ebay-app/
├── server.js              # Express app entry point
├── db.js                  # SQLite schema/setup
├── routes/parts.js        # API routes: upload, list, edit, push-to-ebay, publish
├── services/
│   ├── geminiService.js   # Calls Gemini API to identify part + draft listing
│   └── ebayService.js     # Calls eBay Inventory API (draft-only)
├── public/                # Dashboard (HTML/CSS/JS, no build step)
├── uploads/                # Uploaded part photos
└── data/app.db             # SQLite database (created on first run)
```
