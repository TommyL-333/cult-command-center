# Client Portal Redesign — October 2026

## Nav (final order)
Profile · Short Video Management · Creator Management · Financial Calculator · Support

## Phase 1 — Structure (immediate)
- [x] Rename "Content Studio" → "Short Video Management"
- [x] Rename "Profit Simulator" → "Financial Calculator"
- [x] Hide: Inner Circle, Creator Marketplace, Tasks, Reports (keep in DOM, display:none)
- [x] Rename "Overview" → "Profile"
- [x] Clean up Profile tab (see below)
- [x] Add Creator Management tab (shell + CRM table)

## Profile tab — what stays / what goes
KEEP:
- TikTok connect / reconnect banners
- Brand Logo upload
- Brand Color picker (move out of Campaign Controls card)
- Affiliate Collaboration Page card (recruit creators link)
- Referral Program card (referral links + commission)
- "Manage Billing" button → "Contact us to manage billing" mailto or placeholder

REMOVE:
- Campaign Controls card (cashback, leaderboard, volume bonus, inner circle toggles)
- Task Feed / Program Progress section
- TikTok stats row (GMV / Orders / AOV / Active Creators) — move to Creator Management

LAYOUT: 2 sections
  Row 1: Brand Identity (logo + color) | Billing
  Row 2: Affiliate page link | Referral Program

## Creator Management tab — Phase 2 (build today)
4-stat header row:
  - Total Creators
  - With Contact Info (phone on file)
  - Generating GMV (gmv > 0)
  - Awaiting Samples

Table columns: Handle · Followers · GMV · Videos · Sample Status · Phone · [Text] [View]
Data source: /api/client/reacher (existing) + brands.json creators array (local store)

Phone numbers stored in brands.json under brand.creators[].phone
Text button: opens sms:// link for now (Twilio proper in Phase 3)

## Short Video Management — Phase 3 (tomorrow or later)
Same pipeline as manifest.cultcontent.cc:
Upload → Transcribe → Caption → Review → Post (Buffer)
Already exists in content-studio — just needs label rename + possible UX cleanup

## Twilio Affiliate SMS — Phase 4
- Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to Railway env
- POST /api/client/creators/:id/sms — sends message via Twilio
- Thread view per creator on click

## Billing — placeholder
"To update your billing, email billing@cultcontent.cc"
Future: Stripe Customer Portal link when Stripe is wired
