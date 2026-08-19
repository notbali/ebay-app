# Industrial Parts Listing Assistant

A small full-stack app: upload one or more photos/notes about a part (drag & drop supported) →
AI identifies it and drafts a title, description, pricing, condition, and item specifics →
you review and edit everything in a dashboard → one explicit, confirmed click publishes it live
to eBay.

Multi-user: each person creates their own account and connects their **own** eBay seller account
(via eBay's OAuth consent flow) - nobody shares anyone else's eBay credentials, and everyone only
ever sees and publishes their own drafts.

## Stack
- Backend: Node.js + Express
- Accounts: hand-rolled sessions (Node's built-in `crypto` - scrypt password hashing, signed
  session cookies), no session/auth framework dependency
- DB: SQLite (via Node's built-in `node:sqlite`), file-based, no separate DB server needed
- Frontend: plain HTML/CSS/JS dashboard (no build step)
- AI: pluggable via `AI_PROVIDER` (`services/aiService.js`) - defaults to Kimi K2.6 via NVIDIA's
  free NIM tier (vision + text, structured JSON output), or Anthropic Claude as a fallback. Shared
  across all sellers (not per-user).
- Marketplace: eBay Inventory API, authorized per-seller via 3-legged OAuth
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
- **Accounts** — `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`, each a random 32-byte secret:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Run it twice for two different values. Keep `TOKEN_ENCRYPTION_KEY` especially safe and backed
  up - it's what decrypts every seller's stored eBay refresh token; losing it means everyone has
  to reconnect their eBay account.
- **`PUBLIC_BASE_URL`** — the public HTTPS origin this app is reachable at once deployed (see
  "Exposing this for other sellers" below). Used for the `Secure` cookie flag and the eBay OAuth
  callback URL. Leave unset for pure `localhost` development.
- **eBay app credentials** — from your eBay Developer account (developer.ebay.com):
  - `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — your app's keys. These identify the app itself and
    are shared by every seller who connects - they are **not** a stand-in for any one seller's
    own selling authorization.
  - `EBAY_OAUTH_REDIRECT_URI` — see "Exposing this for other sellers" below; each seller
    authorizes their own account via the in-app "Connect eBay Account" flow (Settings), there is
    no env var for an individual seller's token anymore.
  - `EBAY_CATEGORY_ID` — fallback eBay category ID, only used for drafts where the per-listing
    category lookup found nothing (verify the exact ID for your product type at eBay's category
    lookup)
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
end-to-end — this avoids any risk of pushing test data into a real store.

**Each seller's own business policies** (shipping, payment, returns, warehouse location) are
configured per-account in the dashboard's Settings modal after they connect their eBay account,
not in `.env` - paste them in from that seller's own eBay Seller Hub → Business Policies.

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000`, create the first account (it automatically inherits any parts
already sitting in the local dev database from before accounts existed), then connect an eBay
account from the gate screen or Settings.

## Exposing this for other sellers

The eBay OAuth consent flow needs the app reachable at a **stable** public HTTPS URL - eBay
redirects the seller's browser back to a pre-registered callback URL after they approve access,
so a URL that changes on every restart (like a Cloudflare *quick* tunnel's random
`trycloudflare.com` hostname) will break reconnecting later. Use a Cloudflare **named** tunnel
bound to a fixed hostname on a domain in your Cloudflare account instead, pointed at this app's
local port.

Then, one-time, in your eBay Developer Account (Application Keys → "eBay Redirect URL"):
register (or reuse) a RuName whose Accept URL is `<your fixed tunnel hostname>/api/ebay/callback`,
and set `EBAY_OAUTH_REDIRECT_URI` in `.env` to that RuName (it's a token eBay issues, not the
literal URL itself) and `PUBLIC_BASE_URL` to the tunnel's HTTPS origin.

## How the review → publish flow works

0. **Sign in and connect eBay** — create an account (or log in), then authorize your own eBay
   seller account via the "Connect eBay Account" gate. Every draft you create afterward belongs
   only to your account, and publishing always goes to your eBay store - never anyone else's.
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
- **`/uploads` is not access-controlled** — filenames are randomized but the static route itself
  doesn't check who's asking, so anyone with a direct file URL can view that photo. Fine for a
  small beta; worth proxying through an authenticated route before a wider rollout.
- **Sessions use hand-rolled HMAC-signed cookies**, not a vetted library like `express-session` -
  deliberate, to avoid new dependencies, but worth a second look before scaling past a beta.

## Project structure

```
ebay-app/
├── server.js                  # Express app entry point
├── db.js                      # SQLite schema/setup (users, sessions, ebay_connections, parts)
├── middleware/auth.js         # Session cookie parsing/signing, requireAuth, getSessionUser
├── routes/
│   ├── auth.js                # Signup / login / logout / me
│   ├── ebayAuth.js            # Per-seller eBay OAuth: connect, callback, status, settings
│   └── parts.js                # API routes: upload, list, edit, photos add/remove, publish
│                                 (every route scoped to the logged-in seller)
├── services/
│   ├── authService.js         # Password hashing, session tokens, cookie signing (no deps)
│   ├── cryptoService.js       # AES-256-GCM encrypt/decrypt for stored eBay refresh tokens
│   ├── ebayAccountService.js  # Reads/writes each seller's eBay connection + policy settings
│   ├── aiService.js           # Picks the AI provider below based on AI_PROVIDER
│   ├── kimiService.js         # Calls Kimi K2.6 (via NVIDIA NIM) to identify part + draft listing
│   ├── claudeService.js       # Calls Claude API to identify part + draft listing (fallback provider)
│   ├── ebayService.js         # Calls eBay Inventory API (create/update item+offer, publish)
│   └── r2Service.js           # Uploads photos to Cloudflare R2 for eBay's imageUrls, per-seller keys
├── public/                    # Dashboard (HTML/CSS/JS, no build step)
├── uploads/                    # Uploaded part photos
└── data/app.db                 # SQLite database (created on first run)
```
