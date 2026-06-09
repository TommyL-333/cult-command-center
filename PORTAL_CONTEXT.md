# Cult Content — Client Portal: Engineering Context

This document is for the Sisyphus agent handling all design and engineering for the client portal. Read this fully before making any changes.

---

## What This Is

**Cult Content** is a TikTok Shop creator affiliate management agency. Tommy Lynch runs it. There are currently ~8 brand clients (DIAMANDIA, Approved Science, Trusted Rituals, Lode WTR, THE PERFECT HAIRCARE, Organic Social Marketing, Dissolvd, Yuglo).

The **client portal** is a web app where brand clients log in to see their dashboard, manage campaigns, use content tools, and view billing. It lives at `portal.cultcontent.cc`.

There is also a **portal admin** at `manifest.cultcontent.cc` (protected by Cloudflare Access) where Tommy manages all clients.

---

## Repository

- **Local:** `/Users/tommylynch/cult-command-center/`
- **GitHub:** `https://github.com/TommyL-333/cult-command-center`
- **Deployed on Railway** — auto-deploys from `main` branch push. Domain: `manifest.cultcontent.cc` (admin, CF Access protected) and `portal.cultcontent.cc` (public, client-facing).
- **Volume mounted at `/data`** — `brands.json` lives here. This is the primary database.

---

## Stack

- **Runtime:** Node.js 20 + Express
- **Single server file:** `dashboard-server.js` (~13,500 lines) — all routes, business logic, and HTML templates are in here
- **Frontend files:** `dashboard/` directory — static HTML files served by Express
- **Key dependencies:** `express`, `axios`, `bcryptjs`, `express-session`, `multer`, `stripe`, `fluent-ffmpeg`, `@anthropic-ai/sdk`
- **No build step** — vanilla HTML/CSS/JS, no bundler, no framework
- **Session auth** — `express-session` with in-memory store (MemoryStore), session keyed by `req.session.clientBrandId`
- **Data store** — `brands.json` on Railway volume (`/data/brands.json`). Loaded/saved with `loadBrands()` / `saveBrands()`

---

## Auth Model

There are three auth contexts:

| Context | How | Guards |
|---|---|---|
| **Cloudflare Access** | CF JWT header `cf-access-authenticated-user-email` | `requireAuth` middleware — applies to all routes after `app.use(requireAuth)` at line ~4258 |
| **Client portal session** | `express-session` cookie, `req.session.clientBrandId` | `requireClientSession` middleware |
| **Portal admin session** | `express-session` cookie, `req.session.isPortalAdmin` | `requirePortalAdmin` middleware |

**Important:** Routes registered **before** `app.use(requireAuth)` are accessible without CF Access. Client portal routes (`/client/*`, `/portal-admin/*`) are registered before that line so they work on `portal.cultcontent.cc` without CF Access.

---

## File Map

```
dashboard-server.js          — All server code (routes + inline HTML templates)
dashboard/
  client-login.html          — Client portal login + create account page
  client-dashboard.html      — Main client dashboard (Overview, Content Studio, Billing tabs)
  portal-admin.html          — Admin view of all clients with metrics
  portal-admin-login.html    — Admin password login
  onboard.html               — New client onboarding form (public)
  onboard-flow.html          — Alt onboarding flow
  segments.html              — Segments/analytics page
data/                        — Railway volume mount
  brands.json                — All client data (THE database)
  uploads/                   — Uploaded files (logos, videos, assets)
  chunks/                    — Chunked upload temp files
  stale-brands-*.json        — Auto-backups
```

---

## brands.json Schema

Each client in `brands.clients[]`:

```json
{
  "id": "mocxn2q2ocgg",
  "name": "DIAMANDIA",
  "loginEmail": "diamandia@diamandia.com",
  "passwordHash": "bcrypt hash",
  "createdAt": "ISO string",
  "contactName": "...",
  "website": "...",
  "billingEmail": "...",
  "retainer": 1500,
  "commissionRate": 0.10,
  "proratedFirstRetainer": 1250,
  "sampleBudget": 50,
  "innerCircle": false,
  "logoUrl": "https://...",
  "affiliatePageUrl": "https://portal.cultcontent.cc/creators/slug",
  "stripeCustomerId": "cus_...",
  "lastInvoicedAt": 1780000000000,
  "lastInvoiceId": "in_...",
  "tiktokShopToken": { "access_token": "...", "shop_cipher": "...", "expires_at": 1780000000000 },
  "shopId": 8595,
  "storistaApiKey": "...",
  "storistaConnected": true,
  "storistaQueue": [ /* scheduled video jobs */ ],
  "bufferToken": "...",
  "bufferConnected": true,
  "contentAssets": [ { "id": "uuid", "productId": "...", "url": "...", "type": "image|video", "name": "...", "createdAt": "..." } ],
  "cachedNetGmv": 12500.00,
  "cachedGmvAt": "ISO string",
  "creatorPage": {
    "slug": "diamandia",
    "active": true,
    "headline": "...",
    "pitch": "...",
    "accentColor": "#00f2ea",
    "incentives": {
      "cashback": { "enabled": true, "amount": "100", "target": "100" },
      "leaderboard": { "enabled": true, "threshold": "1000", "places": ["500","300","150"] },
      "volumeBonus": { "enabled": true, "quantity": "10", "bonus": "100" }
    },
    "usps": ["..."],
    "products": [...],
    "tiktokHandle": "..."
  },
  "tasks": [ { "id": "...", "task": "...", "assignee": "...", "priority": "high|medium|low", "done": false, "client": "..." } ],
  "referrals": [...],
  "referralCode": "...",
  "resources": []
}
```

---

## Key API Routes (Client Portal)

All routes under `/api/client/*` require `requireClientSession`.

| Method | Path | Description |
|---|---|---|
| GET | `/client/dashboard` | Returns full brand data as JSON (the main data fetch) |
| PATCH | `/api/client/settings` | Update sampleBudget, compensation, innerCircle, affiliatePageUrl, integration keys |
| POST | `/api/client/logo` | Upload brand logo (after `imageUpload` definition ~line 12444) |
| DELETE | `/api/client/logo` | Remove logo |
| GET | `/api/client/products` | TikTok Shop products for brand |
| GET | `/api/client/assets` | Brand content assets |
| POST | `/api/client/assets/upload` | Upload image/video asset |
| DELETE | `/api/client/assets/:id` | Remove asset |
| POST | `/api/client/overlay/render` | FFmpeg render with text/logo overlays |
| GET | `/api/client/storista/accounts` | Storista TikTok accounts |
| GET | `/api/client/storista/products/:account` | Products for Storista |
| POST | `/api/client/storista/upload` | Upload video to Storista |
| POST | `/api/client/storista/schedule` | Schedule Storista posts (+ Buffer cross-post) |
| GET | `/api/client/storista/queue` | View scheduled queue |
| POST | `/api/client/storista/generate-caption` | AI caption from video |
| GET | `/api/client/buffer/channels` | Buffer social channels |
| POST | `/api/client/referrals` | Add referral |

### Portal Admin Routes

All under `requirePortalAdmin`, accessible at `portal.cultcontent.cc/portal-admin/*`.

| Method | Path | Description |
|---|---|---|
| GET | `/portal-admin/clients` | List all clients with GMV/billing data |
| POST | `/portal-admin/impersonate` | Log in as a client brand |
| POST | `/portal-admin/billing/send/:brandId` | Create + send Stripe invoice |
| GET | `/portal-admin/shop-metrics/:brandId` | WoW GMV + analytics metrics |
| POST | `/portal-admin/set-email` | Set client login email |
| POST | `/portal-admin/clear-tiktok/:brandId` | Wipe TikTok token |
| POST | `/portal-admin/clear-password` | Reset client password |

### Admin Backdoor (no CF Access needed)

`POST /client/admin` with body `{"token": "cc-admin-2026", "action": "..."}`:
- `list-brands` — all brands
- `create-brand` — create new brand
- `set-creds` — set email/password on brand
- `update-brand` — merge fields onto brand
- `merge-and-delete` — copy fields from stubId → keepId, delete stub
- `delete-brand` — remove brand

---

## Client Dashboard HTML (`dashboard/client-dashboard.html`)

Single-page app with three tabs: **Overview**, **Content Studio**, **Billing**.

### Overview Tab
- GMV + rev share stats
- Campaign Controls card: sampleBudget, Cashback/Leaderboard/VolumeBonus toggles, Inner Circle toggle, Logo upload
- Affiliate URL display
- Program Progress (tasks from meeting notes, AI-parsed)
- Connections (Buffer, Arcads, Storista)
- Referral program

### Content Studio Tab
- Connections (Buffer, Arcads, Storista)
- **Brand Assets** — TikTok Shop product images + uploaded assets, searchable dropdown filter by product
- **Create** — product picker → format selector (Text Overlay, Carousel coming, Talking Head coming) → Text Overlay editor with FFmpeg render
- **AI Video Generator** — Arcads 5-step wizard (brand analysis → ideas → scripting → actor selection → scheduling)
- **Content Publishing** — Storista batch uploader with Buffer cross-post channels

### Billing Tab
- Plan tier display
- Invoice history from Stripe
- "Add Payment Method" (Stripe Customer Portal link)

---

## External Integrations

| Service | Purpose | Env Var |
|---|---|---|
| TikTok Shop | Product catalog, orders, analytics | `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET` |
| TikTok Display API | Creator OAuth | `CREATOR_TIKTOK_CLIENT_KEY`, `CREATOR_TIKTOK_CLIENT_SECRET` |
| Buffer | Social scheduling | `BUFFER_ACCESS_TOKEN` (global) or `brand.bufferToken` |
| Storista | TikTok Shop video posting | Per-brand `storistaApiKey` |
| Stripe | Billing | `STRIPE_SECRET_KEY` |
| OpenAI | Caption generation (Whisper + GPT) | `OPENAI_API_KEY` |
| Anthropic | AI scripting, captions | `ANTHROPIC_API_KEY` |
| Reacher | Creator affiliate platform | `RAILWAY_SERVER_URL` proxies to cultcontent-server |
| GHL (GoHighLevel) | CRM | `GHL_API_KEY`, `GHL_LOC_ID` |
| Lark | Team comms | `LARK_APP_ID`, `LARK_APP_SECRET` |
| Fireflies | Meeting transcripts | `FIREFLIES_API_KEY` |
| FAL.ai | (Planned) Seedance AI video | Not yet integrated |

---

## TikTok Shop API Patterns

All brand-scoped TikTok Shop calls use:

```javascript
ttsBrandGet(brand, brands, brandIdx, '/path', queryParams)
ttsBrandPost(brand, brands, brandIdx, '/path', body, queryParams)
```

These auto-refresh the brand's `tiktokShopToken` if expired and sign requests with HMAC-SHA256.

**Key endpoints discovered:**
- Products: `POST /product/202309/products/search` (page_size as query param, not body)
- Product detail: `GET /product/202309/products/:id` — returns `main_images[].urls[]` and `main_images[].thumb_urls[]`
- Orders: `POST /order/202309/orders/search`
- Shop performance: `GET /analytics/202509/shop/performance` — params: `start_date_ge`, `end_date_lt` (YYYY-MM-DD)
- Product analytics: `GET /analytics/202605/shop_products/performance` — same date params, returns `products[].total_performance.{product_impressions, ctr}`
- Video analytics: `GET /analytics/202605/shop_videos/performance` — returns `videos[].{views, click_through_rate, gmv}`

---

## Onboarding Pipeline

When a brand submits `POST /api/onboard/submit`, `runOnboardingPipeline(formData)` runs async:
1. Scrapes Shopify/Amazon product data
2. Creates GHL contact
3. Generates AI content (creator pitch, brand voice, USPs)
4. Creates/finds brand in `brands.json` with `loginEmail` set to form email
5. Creates creator page at `portal.cultcontent.cc/creators/{slug}`
6. Sends Lark alert to Tommy

After submit, the user is redirected to `/client/login?new=1&email=...` which auto-opens the "Create Account" form. If the pipeline is still running, `set-password` returns "being set up" and the page polls every 10s for up to 3 minutes.

---

## Creator Pages

Public pages at `portal.cultcontent.cc/creators/{slug}`. Brand-specific creator signup forms with:
- TikTok OAuth connect (redirect flow, not popup) → on return, form restored from sessionStorage
- Campaign incentive display
- GHL contact creation on submit
- Discord role assignment
- Lark group creation

---

## Known Issues / Gotchas

1. **MemoryStore sessions** — sessions are lost on server restart. Fine for now, will need Redis for scale.
2. **brands.json is the only DB** — all reads/writes go through `loadBrands()` / `saveBrands()`. No concurrency protection. Fine for current scale.
3. **imageUpload multer** defined at line ~12297 — any route using `imageUpload` must be registered AFTER that line, or use lazy `require('multer')` inline.
4. **`app.use(requireAuth)` at line ~4258** — routes registered AFTER this line require CF Access. Client portal routes must be before this line.
5. **TikTok Shop tokens** — per-brand, stored in `brand.tiktokShopToken`. Auto-refresh via `refreshBrandShopToken()`.
6. **Uploads directory** — `UPLOAD_DIR = path.join(DATA_DIR, 'uploads')`. Public URL: `${PUBLIC_BASE_URL}/uploads/filename`. Never use `UPLOAD_BASE_URL` — it doesn't exist, use `PUBLIC_BASE_URL`.
7. **Storista video files** — kept in UPLOAD_DIR after Storista upload (for Buffer cross-posting). Need periodic cleanup of old files.

---

## Pending / Planned Features

- **FAL.ai / Seedance integration** — replace Pikes AI and Arcads with direct FAL.ai calls (Seedance for video, FLUX for images). Usage tracked per brand, billed monthly.
- **Resources section** in client dashboard — links, PDFs, brand briefs, creator briefs
- **Program Progress redesign** — In Progress/Open at top sorted by recency, done items collapsed, per-task update threads
- **Weekly goals** — specific weekly/daily goals set by Tommy, visible to client in portal
- **Campaign controls explainer** — tooltip/modal explaining what each toggle does in plain English
- **Content Studio onboarding** — first-run flow explaining Storista + content creation tools
- **Carousel format** in Create tab
- **Talking Head format** in Create tab (11labs voice + Seedance)
- **Lark group auto-creation** on onboarding form submit
- **Logo in GHL** — store brand logo URL in GHL custom field

---

## Design System

CSS variables used throughout:
```css
--bg:     #12101a   /* dark background */
--card:   #1c1828   /* card background */
--border: #2a2540   /* borders */
--teal:   #00f2ea   /* primary accent (Cult Content brand) */
--gold:   #c9a84c   /* secondary accent */
--green:  #00d27a   /* success */
--red:    #ff3b30   /* error */
--text:   #e2e8f0   /* body text */
--muted:  #64748b   /* secondary text */
```

Font: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif`

Style: Dark mode only. Minimal, clean. Card-based layout. No external CSS frameworks.

---

## Git / Deploy Workflow

```bash
git add <files>
git commit -m "description"
git push origin main   # triggers Railway auto-deploy (~90s)
```

Railway project: `refreshing-curiosity` (a36f832a-4e05-4250-b979-fff2651c77c4)  
Service: `cult-command-center` (11dcb2db-99e4-4b08-9248-a23f7395b747)  
Volume: `/data` (mounts brands.json, uploads, etc.)

After pushing, verify deploy via `railway logs --tail 20`.
