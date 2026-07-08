# LOCKED FILE CHANGE NEEDED — mount inner-circle-spark-brand

`dashboard-server.js` is LOCKED. Sisyphus cannot add the require() line itself.
A human (Claude Code) needs to add **one line** to wire the brand-side Spark
Ads endpoints into the client portal.

## What to add

Place this alongside the other client-session route registrations (near the
`content-studio-gen` / `client-intercom-identity` registrations around line
1217–1222), i.e. AFTER `requireClientSession` and `loadBrands` are defined and
BEFORE any catch-all / 404 handler:

```js
try {
  require('./routes/inner-circle-spark-brand')(app, { express, requireClientSession, loadBrands });
} catch (e) { console.error('[inner-circle-spark-brand] registration failed:', e.message); }
```

## Why

- `routes/inner-circle-spark-brand.js` is the BRAND-facing counterpart to the
  already-mounted creator-facing `routes/inner-circle-spark.js`.
- It exposes:
  - `GET /api/inner-circle/spark/creators` — authorized creators for the logged-in
    brand + their submitted Spark ad codes / video links + status.
  - `GET /api/inner-circle/spark/codes` — flat, export-ready list of all Spark ad
    codes / TTCM item ids for the logged-in brand (supports `?verified=1|0` and
    `?format=csv`).
- Auth: uses the existing `requireClientSession` middleware. Every query is
  scoped to `req.session.clientBrandId`, so a brand only ever sees its own
  creators. Unauthenticated requests return 401.
- The brand paths (`/creators`, `/codes`) do NOT collide with the creator-side
  spark paths (`/authorizations`, `/authorize`, `/ad-code`, `/revoke`), so both
  routers can share the `/api/inner-circle/spark` base safely.

## Verification (already done in the build)

- `node -e "require('./routes/inner-circle-spark-brand')"` → loads clean.
- Express harness with a mock `requireClientSession`:
  - unauth `GET /creators` → **401** ✅
  - authed `GET /creators` → **200**, count=1, only the logged-in brand's creator ✅
  - cross-brand data does NOT leak (another brand's code absent from response) ✅
  - unauth `GET /codes` → **401** ✅
  - authed `GET /codes` → **200** JSON + `?format=csv` returns CSV with header row ✅
