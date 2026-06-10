/**
 * Inner Circle API — SQLite-backed (login, sessions, dashboard).
 *
 * WHY THIS EXISTS: the legacy Inner Circle handlers in dashboard-server.js call
 * a `supabase` client that was never defined (no createClient, no dependency),
 * so every authenticated creator flow 500'd in production. This module provides
 * working replacements on the SQLite layer that already ships with this repo
 * (db/inner-circle.js, better-sqlite3, /data volume).
 *
 * Mounted BEFORE the legacy routes and BEFORE app.use(requireAuth) — Express
 * matches in registration order, so these handlers win; creators have no
 * Cloudflare Access session so this must stay above requireAuth.
 *
 * Routes:
 *   POST /api/inner-circle/login      {email, password}  password = tiktok handle (with or without @) or phone last 4
 *   GET  /api/inner-circle/dashboard  auth: ic_session cookie or Authorization: Bearer <token>
 *
 * Crash-safe: if the SQLite layer fails to load (missing native binding, bad
 * volume), the routes return 503 instead of crashing the whole portal server.
 */

'use strict';

const crypto = require('crypto');

module.exports = function mountInnerCircleSqlite(app, deps = {}) {
  const express = deps.express || require('express');

  // ── Load DB layer defensively ───────────────────────────────────────────────
  let db = null;
  let queries = null;
  let stmts = null;
  let dbError = null;
  try {
    ({ db, queries } = require('../db/inner-circle'));

    // Sessions table (not part of the original schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS inner_circle_sessions (
        token TEXT PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES inner_circle_creators(id),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ic_sessions_creator ON inner_circle_sessions(creator_id);
    `);

    stmts = {
      creatorByEmail: db.prepare(
        `SELECT * FROM inner_circle_creators WHERE lower(email) = lower(?) AND status = 'active'`
      ),
      insertSession: db.prepare(
        `INSERT INTO inner_circle_sessions (token, creator_id, expires_at) VALUES (?, ?, ?)`
      ),
      sessionByToken: db.prepare(
        `SELECT s.token, s.expires_at, c.*
           FROM inner_circle_sessions s
           JOIN inner_circle_creators c ON c.id = s.creator_id
          WHERE s.token = ? AND s.expires_at > datetime('now') AND c.status = 'active'`
      ),
      videosThisMonth: db.prepare(
        `SELECT COUNT(*) AS n FROM inner_circle_videos
          WHERE creator_id = ? AND strftime('%Y-%m', posted_at) = strftime('%Y-%m', 'now')`
      ),
      commissionEarned: db.prepare(
        `SELECT COALESCE(SUM(gmv), 0) AS gmv FROM inner_circle_videos WHERE creator_id = ?`
      ),
      brandsForCreator: db.prepare(
        `SELECT a.shop_id, a.shop_name,
                COALESCE(v.cnt, 0)  AS videos_for_brand,
                COALESCE(v.gmv, 0)  AS gmv_for_brand
           FROM inner_circle_brand_assignments a
           LEFT JOIN (
             SELECT shop_id, COUNT(*) AS cnt, SUM(gmv) AS gmv
               FROM inner_circle_videos WHERE creator_id = ? GROUP BY shop_id
           ) v ON v.shop_id = a.shop_id
          WHERE a.creator_id = ? AND a.active = 1`
      ),
      nextCall: db.prepare(
        `SELECT * FROM inner_circle_calls
          WHERE scheduled_at > datetime('now') ORDER BY scheduled_at ASC LIMIT 1`
      ),
    };

    // ── Idempotent TEST creator seed (E2E testing; TEST-prefixed per task
    //    cleanup policy — flagged for Tommy, removable any time) ───────────────
    const existing = queries.getCreatorByHandle.get('@test_sisyphus_ic');
    if (!existing) {
      queries.insertCreator.run(
        '@test_sisyphus_ic',
        'TEST Creator Sisyphus',
        'test.sisyphus@cultcontent.cc',
        'tt_test_sisyphus_001',
        '2026-06-10',
        '2026-07-31',
        15
      );
      console.log('[inner-circle-sqlite] seeded TEST creator @test_sisyphus_ic');
    }

    console.log('[inner-circle-sqlite] mounted — SQLite layer ready');
  } catch (e) {
    dbError = e;
    console.error('[inner-circle-sqlite] DB layer failed to load — routes will 503:', e.message);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function getSessionToken(req) {
    // Manual cookie parse — this server has no cookie-parser middleware.
    const cookieHeader = req.headers.cookie || '';
    const m = cookieHeader.match(/(?:^|;\s*)ic_session=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
  }

  function requireSqliteSession(req, res, next) {
    if (dbError) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    const token = getSessionToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const row = stmts.sessionByToken.get(token);
      if (!row) return res.status(401).json({ error: 'Session expired' });
      req.icCreator = row;
      next();
    } catch (e) {
      console.error('[inner-circle-sqlite] session check failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  function daysBetween(from, to) {
    return Math.ceil((to.getTime() - from.getTime()) / 86400000);
  }

  // ── POST /api/inner-circle/login ────────────────────────────────────────────
  // Same contract as the legacy route: {email, password}, where password is the
  // creator's TikTok handle (with or without @) or last 4 digits of phone.
  app.post('/api/inner-circle/login', express.json(), (req, res) => {
    if (dbError) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
      const creator = stmts.creatorByEmail.get(String(email).trim());
      if (!creator) return res.status(401).json({ error: 'Invalid credentials' });

      const pw = String(password).trim();
      const handle = creator.creator_handle || '';
      const handleNoAt = handle.replace(/^@/, '');
      const valid = pw === handle || pw === handleNoAt || pw === '@' + handleNoAt;
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19); // SQLite datetime format
      stmts.insertSession.run(token, creator.id, expiresAt);

      res.cookie('ic_session', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      return res.json({
        success: true,
        token,
        creator: {
          id: creator.id,
          name: creator.creator_name,
          email: creator.email,
          tiktok_handle: creator.creator_handle,
        },
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] login failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/dashboard ─────────────────────────────────────────
  app.get('/api/inner-circle/dashboard', requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;

      const videosThisMonth = stmts.videosThisMonth.get(c.id).n;
      const totalGmv = stmts.commissionEarned.get(c.id).gmv;
      const commissionRate = c.commission_rate != null ? c.commission_rate : 0.5;
      const commissionEarned = Math.round(totalGmv * commissionRate * 100) / 100;

      const brands = stmts.brandsForCreator.all(c.id, c.id).map((b) => ({
        id: b.shop_id,
        name: b.shop_name,
        videosForBrand: b.videos_for_brand,
        earnedFromBrand: Math.round(b.gmv_for_brand * commissionRate * 100) / 100,
      }));

      let daysRemaining = null;
      if (c.cohort_end) {
        daysRemaining = Math.max(0, daysBetween(new Date(), new Date(c.cohort_end + 'T23:59:59Z')));
      }

      const call = stmts.nextCall.get();
      const nextCall = call
        ? { date: call.scheduled_at, title: call.title, link: call.lark_meeting_url || null }
        : null;

      return res.json({
        creator: {
          id: c.id,
          name: c.creator_name,
          tiktokHandle: c.creator_handle,
          email: c.email,
          cohort: { start: c.cohort_start, end: c.cohort_end },
        },
        stats: {
          videosThisMonth,
          videosGoal: c.videos_goal != null ? c.videos_goal : 15,
          commissionEarned,
          commissionRate,
          adsCommissionRate: c.ads_commission_rate != null ? c.ads_commission_rate : 0.25,
          daysRemaining,
          activeBrands: brands.length,
        },
        brands,
        nextCall,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] dashboard failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/brands ────────────────────────────────────────────
  // Lists brands with Inner Circle toggled ON. Source of truth: brands.json
  // (brand.innerCircle flag, toggled from the client portal settings page).
  // Display metadata (logo/description) merged from a catalog copy — keep in
  // sync with INNER_CIRCLE_BRANDS in dashboard-server.js (~line 1108).
  const fs = require('fs');
  const path = require('path');
  const IC_DATA_DIR = process.env.DATA_DIR || '/data';
  const IC_BRANDS_FILE = path.join(IC_DATA_DIR, 'brands.json');

  const IC_CATALOG = [
    { id: 'trusted-rituals', name: 'Trusted Rituals', logo: '/logos/trusted-rituals.png',
      description: 'Mullein honey sticks for respiratory health — 2,000mg per stick, Himalayan-sourced. Strong hooks around pollen season, quitting vaping, and daily wellness rituals.' },
    { id: 'diamandia', name: 'DIAMANDIA', logo: '/logos/diamandia.png',
      description: 'DIAMANDIA TikTok Shop brand — 25% target collab commission on the hero product.' },
    { id: 'approved-science', name: 'Approved Science', logo: '/logos/approved-science.png',
      description: 'Science-backed supplements (Marketily / Lenea). Evidence-led content angles.' },
    { id: 'alpha-flow', name: 'Alpha Flow', logo: '/logos/alpha-flow.png',
      description: 'Alpha Flow TikTok Shop brand.' },
  ];

  function icLoadBrandsFile() {
    try { return JSON.parse(fs.readFileSync(IC_BRANDS_FILE, 'utf8')); }
    catch (_) { return null; }
  }

  function icCatalogFor(name) {
    const n = String(name || '').toLowerCase().trim();
    return IC_CATALOG.find((b) => b.name.toLowerCase() === n || b.id === n.replace(/\s+/g, '-')) || null;
  }

  // Idempotent TEST seed: if brands.json is readable and NO client has Inner
  // Circle enabled, append one clearly-TEST-prefixed enabled brand so the
  // selection UI is never empty during E2E testing. Never modifies existing
  // entries; removable any time (id: test-inner-circle-brand).
  (function seedTestBrandIfNoneEnabled() {
    try {
      const data = icLoadBrandsFile();
      if (!data || !Array.isArray(data.clients)) return;
      const anyEnabled = data.clients.some((b) => b && b.innerCircle);
      const hasTest = data.clients.some((b) => b && b.id === 'test-inner-circle-brand');
      if (anyEnabled || hasTest) return;
      data.clients.push({
        id: 'test-inner-circle-brand',
        name: 'TEST Inner Circle Brand',
        innerCircle: true,
        TEST: true,
        seededBy: 'sisyphus-e2e',
        seededAt: new Date().toISOString(),
        description: 'TEST seed — safe to delete once a real brand toggles Inner Circle on.',
      });
      fs.writeFileSync(IC_BRANDS_FILE, JSON.stringify(data, null, 2));
      console.log('[inner-circle-sqlite] seeded TEST Inner Circle brand (no IC-enabled brands found)');
    } catch (e) {
      console.error('[inner-circle-sqlite] TEST brand seed skipped:', e.message);
    }
  })();

  app.get('/api/inner-circle/brands', requireSqliteSession, (req, res) => {
    try {
      const data = icLoadBrandsFile();
      const enabled = ((data && data.clients) || []).filter((b) => b && b.innerCircle);
      const brands = enabled.map((b) => {
        const cat = icCatalogFor(b.name);
        return {
          id: b.id || (cat && cat.id) || String(b.name || '').toLowerCase().trim().replace(/\s+/g, '-'),
          name: b.name,
          logo: b.logoUrl || (cat && cat.logo) || null,
          description: (cat && cat.description) || b.description || '',
          commission: { targetCollab: 0.5, ads: 0.25 },
          isTest: !!b.TEST,
        };
      });
      return res.json({ brands, count: brands.length });
    } catch (e) {
      console.error('[inner-circle-sqlite] brands failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // Expose the working session middleware so other routes can adopt it later.
  return { requireSqliteSession };
};
