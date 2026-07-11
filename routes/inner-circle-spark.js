// ─── Inner Circle — Spark / Whitelisting (Partnership) Ads: CREATOR-SIDE API ────
//
// Creator-facing counterpart to routes/inner-circle-spark-brand.js (brand-side).
// Lets a logged-in CREATOR see which brands they have authorized to run Spark /
// partnership ads, submit ad codes / video links, and revoke authorizations.
//
// AUTH: Bearer token (Authorization header) validated by requireSqliteSession.
// Tokens are issued on login and stored in inner_circle_sessions table. Every
// query in this module is SCOPED to req.icCreator (the authenticated creator)
// so a creator can only ever see their own authorizations — never another
// creator's. Unauthenticated requests get 401 from requireSqliteSession.
//
// Data source: the SQLite tables from migration 20260707_spark_authorizations.sql
//   spark_authorizations(id, creator_id, brand_id TEXT, brand_name, status,
//                        authorized_at, revoked_at, created_at, updated_at)
//   spark_ad_codes(id, authorization_id, tiktok_video_id, tiktok_video_url,
//                  ad_code, ttcm_item_id, verified INTEGER, submitted_at, ...)
//
// spark_authorizations.creator_id keys on req.icCreator.id — so scoping is a
// direct WHERE match. Brand partners query via routes/inner-circle-spark-brand.js
// on the client portal side, WHERE spark_authorizations.brand_id matches their
// session's clientBrandId (from brands.json).
//
// Mount from dashboard-server.js (one line in the inner-circle route registration,
// AFTER requireSqliteSession is defined):
//   require('./routes/inner-circle-spark')(app, { express, requireSqliteSession });
//
// Endpoints (all creator-session gated, scoped to req.icCreator.id):
//   GET /api/inner-circle/spark/authorizations
//       → all brand authorizations for THIS creator (pending, authorized, revoked).
//         { ok, creator, count, authorizations:[...] }
//   POST /api/inner-circle/spark/authorize
//       → creator grants a brand permission to run Spark ads. { brandId }
//         On success: { ok, authorization }
//   POST /api/inner-circle/spark/revoke
//       → creator revokes a brand's ad-running permission. { brandId }
//   POST /api/inner-circle/spark/ad-code
//       → submit an ad code / TTCM item id under an authorization. 
//         { brandId, videoUrl, adCode, ttcmItemId?, videoDuration? }

'use strict';

const BASE = '/api/inner-circle/spark';

let db = null;
let dbError = null;
try {
  ({ db } = require('../db/inner-circle'));
  // Idempotent safety net — ensure the Spark tables exist (same as brand-side).
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
  console.error('[inner-circle-spark] DB layer unavailable:', e.message);
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

// ── The router factory ────────────────────────────────────────────────────────
module.exports = (app, deps = {}) => {
  const express = deps.express || require('express');
  const { requireSqliteSession } = deps;

  if (!app || !requireSqliteSession) {
    throw new Error('[inner-circle-spark] missing deps: requires { express, requireSqliteSession }');
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

  // ── GET /authorizations ──────────────────────────────────────────────────────
  // All brand authorizations for THIS creator (pending, authorized, revoked).
  // Scoped strictly to req.icCreator.id.
  router.get('/authorizations', requireSqliteSession, (req, res) => {
    if (dbGuard(res)) return;
    try {
      const creatorId = req.icCreator.id;
      if (!creatorId) return res.status(401).json({ error: 'Not authenticated' });

      const auths = db.prepare(
        `SELECT id, creator_id, brand_id, brand_name, status, authorized_at,
                revoked_at, created_at, updated_at
           FROM spark_authorizations
          WHERE creator_id = ?
          ORDER BY created_at DESC`
      ).all(creatorId);

      const authorizations = auths.map(a => {
        const codes = codesForAuth(a.id);
        return {
          id: a.id,
          brandId: a.brand_id,
          brandName: a.brand_name,
          status: a.status,
          authorizedAt: a.authorized_at,
          revokedAt: a.revoked_at,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
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
        creator: {
          id: req.icCreator.id,
          name: req.icCreator.creator_name,
          email: req.icCreator.email,
          handle: req.icCreator.creator_handle,
        },
        count: authorizations.length,
        authorizedCount: authorizations.filter(a => a.status === 'authorized').length,
        authorizations,
      });
    } catch (e) {
      console.error('[inner-circle-spark] GET /authorizations failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /authorize ──────────────────────────────────────────────────────────
  // Creator grants a brand permission to run Spark ads. Creates or reactivates
  // the spark_authorizations row. Status is set to 'pending' initially; the brand
  // must accept via the client portal to move to 'authorized'.
  router.post('/authorize', requireSqliteSession, express.json(), (req, res) => {
    if (dbGuard(res)) return;
    try {
      const creatorId = req.icCreator.id;
      if (!creatorId) return res.status(401).json({ error: 'Not authenticated' });

      const { brandId, brandName } = req.body || {};
      if (!brandId) return res.status(400).json({ error: 'brandId required' });

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Upsert: if a revoked authorization exists, reactivate it. Otherwise insert.
      let auth = db.prepare(
        `SELECT id, status FROM spark_authorizations
          WHERE creator_id = ? AND brand_id = ?`
      ).get(creatorId, String(brandId));

      if (auth) {
        // Already exists — update status and timestamp
        db.prepare(
          `UPDATE spark_authorizations
             SET status = 'pending', revoked_at = NULL, updated_at = ?
            WHERE id = ?`
        ).run(now, auth.id);
      } else {
        // New authorization
        db.prepare(
          `INSERT INTO spark_authorizations
             (creator_id, brand_id, brand_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`
        ).run(creatorId, String(brandId), String(brandName || ''), now, now);

        auth = db.prepare(
          `SELECT id FROM spark_authorizations
            WHERE creator_id = ? AND brand_id = ?`
        ).get(creatorId, String(brandId));
      }

      const updated = db.prepare(
        `SELECT id, creator_id, brand_id, brand_name, status, authorized_at,
                revoked_at, created_at, updated_at
           FROM spark_authorizations WHERE id = ?`
      ).get(auth.id);

      return res.json({
        ok: true,
        authorization: {
          id: updated.id,
          brandId: updated.brand_id,
          brandName: updated.brand_name,
          status: updated.status,
          authorizedAt: updated.authorized_at,
          revokedAt: updated.revoked_at,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      });
    } catch (e) {
      console.error('[inner-circle-spark] POST /authorize failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /revoke ─────────────────────────────────────────────────────────────
  // Creator revokes a brand's ad-running permission. Soft-delete: marks the
  // authorization as 'revoked' with a timestamp.
  router.post('/revoke', requireSqliteSession, express.json(), (req, res) => {
    if (dbGuard(res)) return;
    try {
      const creatorId = req.icCreator.id;
      if (!creatorId) return res.status(401).json({ error: 'Not authenticated' });

      const { brandId } = req.body || {};
      if (!brandId) return res.status(400).json({ error: 'brandId required' });

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      const auth = db.prepare(
        `SELECT id FROM spark_authorizations
          WHERE creator_id = ? AND brand_id = ? AND status != 'revoked'`
      ).get(creatorId, String(brandId));

      if (!auth) {
        return res.status(404).json({ error: 'Authorization not found or already revoked' });
      }

      db.prepare(
        `UPDATE spark_authorizations
           SET status = 'revoked', revoked_at = ?, updated_at = ?
          WHERE id = ?`
      ).run(now, now, auth.id);

      return res.json({ ok: true });
    } catch (e) {
      console.error('[inner-circle-spark] POST /revoke failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /ad-code ────────────────────────────────────────────────────────────
  // Submit an ad code / TTCM item id under an authorization. Requires the
  // authorization to exist and be active.
  router.post('/ad-code', requireSqliteSession, express.json(), (req, res) => {
    if (dbGuard(res)) return;
    try {
      const creatorId = req.icCreator.id;
      if (!creatorId) return res.status(401).json({ error: 'Not authenticated' });

      const { brandId, videoUrl, adCode, ttcmItemId } = req.body || {};
      if (!brandId || !videoUrl || !adCode) {
        return res.status(400).json({ error: 'brandId, videoUrl, adCode required' });
      }

      // Find the active authorization for this creator+brand
      const auth = db.prepare(
        `SELECT id FROM spark_authorizations
          WHERE creator_id = ? AND brand_id = ? AND (status = 'authorized' OR status = 'pending')`
      ).get(creatorId, String(brandId));

      if (!auth) {
        return res.status(403).json({ error: 'No active authorization for this brand' });
      }

      // Extract video ID from URL (basic TikTok patterns)
      let videoId = null;
      const m = String(videoUrl).match(/(?:vm\.tiktok\.com|vt\.tiktok\.com|tiktok\.com)\/([a-zA-Z0-9]+)/);
      if (m) videoId = m[1];

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Insert the ad code submission
      const result = db.prepare(
        `INSERT INTO spark_ad_codes
           (authorization_id, tiktok_video_id, tiktok_video_url, ad_code, ttcm_item_id, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        auth.id,
        videoId,
        String(videoUrl),
        String(adCode),
        String(ttcmItemId || ''),
        now,
        now,
        now
      );

      const code = db.prepare(
        `SELECT id, tiktok_video_id, tiktok_video_url, ad_code, ttcm_item_id, verified, submitted_at
           FROM spark_ad_codes WHERE id = ?`
      ).get(result.lastInsertRowid);

      return res.json({
        ok: true,
        adCode: {
          id: code.id,
          videoId: code.tiktok_video_id,
          videoUrl: code.tiktok_video_url,
          adCode: code.ad_code,
          ttcmItemId: code.ttcm_item_id,
          verified: !!code.verified,
          submittedAt: code.submitted_at,
        },
      });
    } catch (e) {
      console.error('[inner-circle-spark] POST /ad-code failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount under the base path on the shared app (proven cult-command-center
  // pattern). These creator paths (/authorizations, /authorize, /revoke, /ad-code)
  // do not collide with the brand-side spark paths (/creators, /codes).
  app.use(BASE, router);

  // Loader-compatibility metadata.
  router.path = BASE;
  router.auth = 'requireSqliteSession'; // creator-session middleware per-route
};
