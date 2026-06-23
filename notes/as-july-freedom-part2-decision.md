# AS July Freedom Challenge — Part 2 (Step 10) decision + handoff

**Date:** 2026-06-23
**Repo:** TommyL-333/cult-command-center
**Step 10 goal:** wire the client-dashboard incentive editor (Cashback/Leaderboard/Volume Bonus + a header text field + 2–3 Reacher link inputs + Publish) to the GET/PATCH store from Step 9, and make the public IC campaign page render from the same store (heading syncs with headerText; rewards/cashback/links reflect saved config). Constraint: **do NOT touch dashboard-server.js.**

## Live regression baseline (Part-1 result — DO NOT change)
Captured live from portal.cultcontent.cc/creators/approved-science (status 200):
- Reward cards (3): **20%** "commission on every sale you drive" · **$200 bonus** "post 10 videos and earn a one-time cash bonus" · **$1500 top prize** "monthly leaderboard — $1,000 min GMV — 2nd $250, 3rd $125"
- No "Freedom"/cashback/camp-btn copy currently rendered on the interest page (campaign CTA buttons render on the /welcome page from cp.campaigns.*Url).
These exact values must remain after any work.

## The contradiction (why Step 10 cannot be completed as literally written)
Step 1 recon (notes/as-july-freedom-recon.md) PROVED the live architecture:
- The public AS IC page is rendered by `renderCreatorPage` / `renderWelcomePage` **inside dashboard-server.js**, reading **`brands.json → creatorPage`** (`cp.headline`, `cp.incentives`, `cp.tcCommission`, `cp.campaigns.{blitzUrl,cashbackUrl,quantityVideoUrl,leaderboardUrl}`).
- The client editor (client-dashboard.html Cashback/Leaderboard/Volume Bonus blocks) **already** writes to that SAME store via `PATCH /api/client/settings` → `brand.creatorPage.incentives`. So "editor and public page render from the same store" is ALREADY TRUE for the incentive blocks.

Step 9 (routes/ic-campaign-admin.js) built a **separate, parallel** store: `ic-campaigns.json` (GET `/api/ic-campaign/:brandId`, PATCH `/portal-admin/ic-campaign/:brandId`). This store is:
- **NOT mounted** in dashboard-server.js (grep: 0 references), and
- **NOT read** by the public renderers (they read brands.json, not ic-campaigns.json).

To make the public page render from `ic-campaigns.json` you MUST edit the renderers / data read in **dashboard-server.js** — which is forbidden by this step and by the locked-file rule. And doing so would create a **dual source of truth** (ic-campaigns.json vs brands.json) — the exact anti-pattern MEMORY.md warns against ("single source of truth — CONFIRMED: brands.json").

## Missing pieces that are genuinely absent (the real gap)
The public renderer already reads `cp.headline` and `cp.campaigns.*Url`, but the **client editor has no UI and no write-path** for them:
- `PATCH /api/client/settings` (dashboard-server.js ~L3543) whitelists ONLY: `sampleBudget`, `compensation` (→creatorPage.incentives), `affiliatePageUrl`, `innerCircle`, `brandColor`, integration keys. It does **not** accept `headerText`/`headline` or `campaigns.*Url`.
- client-dashboard.html has no Campaign Headline input, no Reacher link inputs, no dedicated Publish button.

## Recommended architecture (single store, no parallel store)
Keep brands.json as the one store the public page already reads. Add the two missing editor fields and route them through the EXISTING `PATCH /api/client/settings`:
1. **Server (LOCKED — needs Claude Code):** extend the `PATCH /api/client/settings` whitelist to accept and persist:
   - `headline` (string) → `brand.creatorPage.headline`
   - `campaigns` (object) → shallow-merge into `brand.creatorPage.campaigns` (keys: blitzUrl, cashbackUrl, quantityVideoUrl, leaderboardUrl), each validated as empty-or-`https://`.
2. **Client (UNLOCKED — buildable now):** add to client-dashboard.html settings card a "Campaign Headline" text input + 4 Reacher link inputs, pre-populated from the dashboard payload's `brand.creatorPage`, and include `headline` + `campaigns` in the existing `saveSettings()` PATCH body. (The existing "Save Changes" is the Publish button; a separate Publish button is not needed and would fragment the save path.)

Deprecate routes/ic-campaign-admin.js + ic-campaigns.json (the Step-9 parallel store), since nothing reads it and adopting it would require editing the locked renderer.

## Why I did NOT ship client-only UI now
Adding the headline + Reacher inputs to client-dashboard.html WITHOUT the server whitelist change would be a **dishonest no-op**: the fields would render and "save" but silently drop on the server (un-whitelisted), and the public page would never change. Per the honesty rule, I will not ship UI that appears to work but does nothing. The client UI should land together with the server whitelist change.

## Status
- Part-1 AS values verified live and unchanged: **20% / $200 (10 videos) / $1500 leaderboard ($1,000 min, 2nd $250, 3rd $125)**. No regression introduced (no code changed).
- Blocked on a locked-file (dashboard-server.js) change. Flagged to Tommy/Claude Code with the exact whitelist diff. Part 2 is ready for review/decision.
