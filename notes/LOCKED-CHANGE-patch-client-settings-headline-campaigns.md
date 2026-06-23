# LOCKED-FILE CHANGE NEEDED (Claude Code) — extend PATCH /api/client/settings

**File:** dashboard-server.js (LOCKED — Sisyphus cannot edit)
**Handler:** `app.patch('/api/client/settings', ...)` — currently ~line 3543–3590.
**Why:** The public AS IC creator page (renderCreatorPage/renderWelcomePage) already reads `creatorPage.headline` and `creatorPage.campaigns.*Url` from brands.json, but the client editor has no write-path for them. This is the ONLY server change required to let the new client-dashboard.html fields (Campaign Headline + Reacher links) actually persist and show on the live page. Single source of truth stays brands.json — no parallel store.

## Exact change
Inside the handler, after the existing destructure:
```js
const { sampleBudget, compensation, affiliatePageUrl, innerCircle, brandColor } = req.body || {};
```
add `headline` and `campaigns` to the destructure:
```js
const { sampleBudget, compensation, affiliatePageUrl, innerCircle, brandColor, headline, campaigns } = req.body || {};
```

Then, AFTER the existing `if (compensation && typeof compensation === 'object') { ... brand.creatorPage.incentives = compensation; }` block (so creatorPage is guaranteed to exist), insert:

```js
// Campaign headline (hero <h1> on the creator page) — persisted to creatorPage.headline
if (headline !== undefined) {
  if (!brand.creatorPage) brand.creatorPage = {};
  brand.creatorPage.headline = headline === null ? null : String(headline).slice(0, 200);
}

// Reacher campaign CTA links (rendered on the /welcome page) — only http(s) URLs accepted
if (campaigns && typeof campaigns === 'object') {
  if (!brand.creatorPage) brand.creatorPage = {};
  if (!brand.creatorPage.campaigns) brand.creatorPage.campaigns = {};
  const URL_KEYS = ['blitzUrl', 'cashbackUrl', 'quantityVideoUrl', 'leaderboardUrl'];
  for (const k of URL_KEYS) {
    if (campaigns[k] === undefined) continue;
    const v = campaigns[k];
    if (v === '' || v === null) { brand.creatorPage.campaigns[k] = ''; continue; } // allow clearing
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) {
      return res.status(400).json({ error: `${k} must be empty or an http(s) URL` });
    }
    brand.creatorPage.campaigns[k] = v.trim();
  }
}
```
(Place this BEFORE `brands.clients[idx] = brand; saveBrands(brands);`.)

## After this ships
Sisyphus will land the matching client-dashboard.html UI (Campaign Headline input + 4 Reacher link inputs, pre-populated from the dashboard payload, sent in the existing saveSettings() PATCH body). client-dashboard.html is also LOCKed historically per MEMORY — if so, that UI diff will need Claude Code too; spec will follow in the same PR. No separate Publish button — existing "Save Changes" is the publish action.

## Also expose creatorPage in the client dashboard payload (if not already)
The GET that feeds `render()` must include `brand.creatorPage` (headline + campaigns) so the new inputs can pre-populate. Confirm the `/api/client/me` (or equivalent) brand payload includes `creatorPage.headline` and `creatorPage.campaigns`; if not, add them to the projection.
