// ─── Inner Circle — Spark / Whitelisting (Partnership) Ads: BRAND-SIDE API ────
//
// The brand-facing counterpart to routes/inner-circle-spark.js (creator-side).
// Lets a logged-in CLIENT BRAND see which Inner Circle creators have authorized
// them to run Spark / partnership ads, and collect all the submitted Spark ad
// codes / TTCM item ids for export into TikTok Ads Manager.
//
// AUTH: client-session middleware (requireClientSession) — the SAME session
// gate used across dashboard-server.js client routes. It sets
// req.session.clientBrandId to the brands.json client id (a text slug). Every
// query in this module is SCOPED to that brandId so a brand can only ever see
// its own creators' authorizations — never another brand's. Unauthenticated
// requests get 401 from requireClientSession.
//
// Data source: the SQLite tables from migration 20260707_spark_authorizations.sql
//   spark_authorizations(id, creator_id, brand_id TEXT, brand_name, status,
//                        authorized_at, revoked_at, created_at, updated_at)
//   spark_ad_codes(id, authorization_id, tiktok_video_id, tiktok_video_url,
//                  ad_code, ttcm_item_id, verified INTEGER, submitted_at, ...)
// joined to inner_circle_creators(id, creator_handle, creator_name, email,
//                                 tiktok_user_id) for creator display info.
//
// spark_authorizations.brand_id keys on the brands.json text slug, which is the
// SAME value as req.session.clientBrandId — so scoping is a direct WHERE match.
//
// Mount from dashboard-server.js (dashboard-server.js is LOCKED — the require()
// line is flagged for a human; see the accompanying locked-file-changes note):
//   require('./routes/inner-circle-spark-brand')(app, { express, requireClientSession, loadBrands });
//
// Endpoints (all client-session gated, scoped to req.session.clientBrandId):
//   GET /api/inner-circle/spark/creators
//       → authorized creators for THIS brand + their submitted ad codes /
//         video links + status. { ok, brand, count, creators:[...] }
//   GET /api/inner-circle/spark/codes
//       → flat list of every Spark ad code / TTCM item id for THIS brand,
//         suitable for export. Supports ?verified=1|0 and ?format=csv.

'use strict';

const BASE = '/api/inner-circle/spark';

// ── DB access (better-sqlite3 via the shared Inner Circle DB layer) ───────────
// Loaded defensively: if the native binding is missing the routes return 503
// instead of crashing the portal, mirroring inner-circle-spark.js.
let db = null;
let dbError = null;
try {
  ({ db } = require('../db/inner-circle'));
  // Idempotent safety net — ensure the Spark tables exist even if this module
  // is mounted before the creator-side module / migration has run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS spark_authorizations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id    INTEGER NOT NULL REFERENCES inner_circle_creators(id),
      brand_id      TEXT    NOT NULL,
      brand_name    TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      authorized_at DATETIME,
      revoked_at    DATETIME,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spark_auth_creator ON spark_authorizations(creator_id);
    CREATE INDEX IF NOT EXISTS idx_spark_auth_brand   ON spark_authorizations(brand_id);
    CREATE INDEX IF NOT EXISTS idx_spark_auth_status  ON spark_authorizations(status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spark_auth_creator_brand
      ON spark_authorizations(creator_id, brand_id);

    CREATE TABLE IF NOT EXISTS spark_ad_codes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_id  INTEGER NOT NULL REFERENCES spark_authorizations(id),
      tiktok_video_id   TEXT,
      tiktok_video_url  TEXT,
      ad_code           TEXT,
      ttcm_item_id      TEXT,
      verified          INTEGER NOT NULL DEFAULT 0,
      submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spark_codes_auth     ON spark_ad_codes(authorization_id);
    CREATE INDEX IF NOT EXISTS idx_spark_codes_verified ON spark_ad_codes(verified);
    CREATE INDEX IF NOT EXISTS idx_spark_codes_video    ON spark_ad_codes(tiktok_video_id);
  `);
} catch (e) {
  dbError = e;
  console.error('[inner-circle-spark-brand] DB layer unavailable:', e.message);
}

// Fetch every ad code submitted under an authorization.
function codesForAuth(authId) {
  return db.prepare(
    `SELECT id, tiktok_video_id, tiktok_video_url, ad_code, ttcm_item_id,
            verified, submitted_at
       FROM spark_ad_codes
      WHERE authorization_id = ?
      ORDER BY submitted_at DESC`
  ).all(authId);
}

// Escape a value for CSV (RFC-4180-ish: wrap in quotes, double internal quotes).
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── The router factory ────────────────────────────────────────────────────────
module.exports = (app, deps = {}) => {
  const express = deps.express || require('express');
  const { requireClientSession, loadBrands } = deps;

  if (!app || !requireClientSession || !loadBrands) {
    throw new Error(
      '[inner-circle-spark-brand] missing deps: requires { express, requireClientSession, loadBrands }'
    );
  }

  const router = express.Router();

  // 503 guard used by every handler if the DB failed to load.
  function dbGuard(res) {
    if (dbError || !db) {
      res.status(503).json({ error: 'Inner Circle data layer unavailable' });
      return true;
    }
    return false;
  }

  // Resolve the logged-in brand slug + display name from session. The brand_id
  // stored on spark_authorizations IS this slug, so scoping is a direct match.
  function currentBrand(req) {
    const brandId = req.session && req.session.clientBrandId;
    if (!brandId) return null;
    let name = null;
    try {
      const brands = loadBrands();
      const c = (brands.clients || []).find(b => String(b.id) === String(brandId));
      name = c ? (c.name || null) : null;
    } catch (_) { /* name is best-effort */ }
    return { id: String(brandId), name };
  }

  // ── GET /creators ───────────────────────────────────────────────────────────
  // Authorized creators for THIS brand + their submitted ad codes / video links
  // + status. Scoped strictly to req.session.clientBrandId.
  router.get('/creators', requireClientSession, (req, res) => {
    if (dbGuard(res)) return;
    try {
      const brand = currentBrand(req);
      // requireClientSession already guarantees a session, but be defensive.
      if (!brand) return res.status(401).json({ error: 'Not authenticated' });

      // Optional status filter (?status=authorized) — default returns all rows
      // for the brand so the panel can show revoked/pending too.
      const statusFilter = (req.query.status || '').trim();

      let auths;
      if (statusFilter) {
        auths = db.prepare(
          `SELECT sa.*, c.creator_handle, c.creator_name, c.email, c.tiktok_user_id
             FROM spark_authorizations sa
             JOIN inner_circle_creators c ON c.id = sa.creator_id
            WHERE sa.brand_id = ? AND sa.status = ?
            ORDER BY sa.authorized_at DESC, sa.created_at DESC`
        ).all(brand.id, statusFilter);
      } else {
        auths = db.prepare(
          `SELECT sa.*, c.creator_handle, c.creator_name, c.email, c.tiktok_user_id
             FROM spark_authorizations sa
             JOIN inner_circle_creators c ON c.id = sa.creator_id
            WHERE sa.brand_id = ?
            ORDER BY sa.authorized_at DESC, sa.created_at DESC`
        ).all(brand.id);
      }

      const creators = auths.map(a => {
        const codes = codesForAuth(a.id);
        return {
          authorizationId: a.id,
          creatorId: a.creator_id,
          creatorHandle: a.creator_handle,
          creatorName: a.creator_name,
          email: a.email,
          tiktokUserId: a.tiktok_user_id,
          status: a.status,
          authorizedAt: a.authorized_at,
          revokedAt: a.revoked_at,
          adCodeCount: codes.length,
          verifiedCodeCount: codes.filter(c => !!c.verified).length,
          adCodes: codes.map(c => ({
            id: c.id,
            videoId: c.tiktok_video_id,
            videoUrl: c.tiktok_video_url,
            adCode: c.ad_code,
            ttcmItemId: c.ttcm_item_id,
            verified: !!c.verified,
            submittedAt: c.submitted_at,
          })),
        };
      });

      return res.json({
        ok: true,
        brand,
        count: creators.length,
        authorizedCount: creators.filter(c => c.status === 'authorized').length,
        creators,
      });
    } catch (e) {
      console.error('[inner-circle-spark-brand] GET /creators failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /codes ──────────────────────────────────────────────────────────────
  // Flat, export-ready list of every Spark ad code / TTCM item id for THIS
  // brand. Supports ?verified=1|0 to filter and ?format=csv for a CSV download.
  router.get('/codes', requireClientSession, (req, res) => {
    if (dbGuard(res)) return;
    try {
      const brand = currentBrand(req);
      if (!brand) return res.status(401).json({ error: 'Not authenticated' });

      // Only collect codes under an AUTHORIZED authorization for this brand —
      // revoked/pending grants must not leak boostable codes into export.
      const params = [brand.id];
      let verifiedClause = '';
      if (req.query.verified === '1' || req.query.verified === 'true') {
        verifiedClause = ' AND sc.verified = 1';
      } else if (req.query.verified === '0' || req.query.verified === 'false') {
        verifiedClause = ' AND sc.verified = 0';
      }

      const rows = db.prepare(
        `SELECT sc.id, sc.tiktok_video_id, sc.tiktok_video_url, sc.ad_code,
                sc.ttcm_item_id, sc.verified, sc.submitted_at,
                c.creator_handle, c.creator_name, sa.status AS auth_status
           FROM spark_ad_codes sc
           JOIN spark_authorizations sa ON sa.id = sc.authorization_id
           JOIN inner_circle_creators c ON c.id = sa.creator_id
          WHERE sa.brand_id = ? AND sa.status = 'authorized'${verifiedClause}
          ORDER BY sc.submitted_at DESC`
      ).all(...params);

      const codes = rows.map(r => ({
        id: r.id,
        creatorHandle: r.creator_handle,
        creatorName: r.creator_name,
        videoId: r.tiktok_video_id,
        videoUrl: r.tiktok_video_url,
        adCode: r.ad_code,
        ttcmItemId: r.ttcm_item_id,
        verified: !!r.verified,
        submittedAt: r.submitted_at,
      }));

      // CSV export path — for pasting straight into TikTok Ads Manager workflows.
      if ((req.query.format || '').toLowerCase() === 'csv') {
        const header = [
          'creator_handle', 'creator_name', 'video_id', 'video_url',
          'ad_code', 'ttcm_item_id', 'verified', 'submitted_at',
        ];
        const lines = [header.join(',')];
        for (const c of codes) {
          lines.push([
            csvCell(c.creatorHandle), csvCell(c.creatorName), csvCell(c.videoId),
            csvCell(c.videoUrl), csvCell(c.adCode), csvCell(c.ttcmItemId),
            csvCell(c.verified ? '1' : '0'), csvCell(c.submittedAt),
          ].join(','));
        }
        const safeBrand = String(brand.id).replace(/[^a-z0-9_-]/gi, '');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="spark-codes-${safeBrand}.csv"`
        );
        return res.send(lines.join('\r\n'));
      }

      return res.json({
        ok: true,
        brand,
        count: codes.length,
        codes,
      });
    } catch (e) {
      console.error('[inner-circle-spark-brand] GET /codes failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount under the base path on the shared app (proven cult-command-center
  // pattern). These brand paths (/creators, /codes) do not collide with the
  // creator-side spark paths (/authorizations, /authorize, /ad-code, /revoke).
  app.use(BASE, router);

  // Loader-compatibility metadata.
  router.path = BASE;
  router.auth = false; // client-session middleware handles auth per-route
  return { path: BASE, router, auth: false };
};

// Also expose the base + factory statically for tooling / tests.
module.exports.path = BASE;
module.exports.auth = false;
