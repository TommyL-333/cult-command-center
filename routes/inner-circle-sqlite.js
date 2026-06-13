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

    // Phone column (not in the original schema) — idempotent migration for the
    // signup flow. SQLite throws if the column already exists; that's fine.
    try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN phone TEXT`); } catch (_) { /* column exists */ }
    try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN password_hash TEXT`); } catch (_) { /* column exists */ }

    stmts = {
      creatorByEmail: db.prepare(
        `SELECT * FROM inner_circle_creators WHERE lower(email) = lower(?) AND status = 'active'`
      ),
      // Status-agnostic email lookup — duplicate check on signup must catch
      // paused/removed accounts too, not just active ones.
      creatorByEmailAny: db.prepare(
        `SELECT * FROM inner_circle_creators WHERE lower(email) = lower(?)`
      ),
      insertCreatorFull: db.prepare(
        `INSERT INTO inner_circle_creators
           (creator_handle, creator_name, email, phone, password_hash, status, cohort_start, cohort_end, videos_goal, commission_rate, ads_commission_rate)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 20, 0.50, 0.25)`
      ),
      setPassword: db.prepare(
        `UPDATE inner_circle_creators SET password_hash = ? WHERE id = ?`
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
      recordingsList: db.prepare(
        `SELECT id, title, scheduled_at, recording_url FROM inner_circle_calls
          WHERE recording_url IS NOT NULL AND recording_url != ''
          ORDER BY scheduled_at DESC LIMIT 50`
      ),
      getAssignment: db.prepare(
        `SELECT * FROM inner_circle_brand_assignments WHERE creator_id = ? AND shop_id = ?`
      ),
      insertAssignment: db.prepare(
        `INSERT INTO inner_circle_brand_assignments (creator_id, shop_id, shop_name) VALUES (?, ?, ?)`
      ),
      reactivateAssignment: db.prepare(
        `UPDATE inner_circle_brand_assignments SET active = 1, shop_name = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ?`
      ),
    };

    // ── Idempotent TEST creator seed (E2E testing; TEST-prefixed per task
    //    cleanup policy — flagged for Tommy, removable any time) ────────────��──
    const existing = queries.getCreatorByHandle.get('@test_sisyphus_ic');
    if (!existing) {
      queries.insertCreator.run(
        '@test_sisyphus_ic',
        'TEST Creator Sisyphus',
        'test.sisyphus@cultcontent.cc',
        'tt_test_sisyphus_001',
        '2026-06-10',
        '2026-07-31',
        20
      );
      console.log('[inner-circle-sqlite] seeded TEST creator @test_sisyphus_ic');
    }

    // ── Second TEST creator + distinct TEST brand assignment — data-isolation
    //    E2E (step 8). Assignment goes straight into inner_circle_brand_assignments;
    //    'test-brand-b-e2e' is NOT in brands.json so real creators never see it.
    //    TEST-prefixed per cleanup policy — removable any time. ────────────────
    let creator2 = queries.getCreatorByHandle.get('@test_sisyphus_ic2');
    if (!creator2) {
      queries.insertCreator.run(
        '@test_sisyphus_ic2',
        'TEST Creator Sisyphus Two',
        'test.sisyphus2@cultcontent.cc',
        'tt_test_sisyphus_002',
        '2026-06-10',
        '2026-07-31',
        20
      );
      creator2 = queries.getCreatorByHandle.get('@test_sisyphus_ic2');
      console.log('[inner-circle-sqlite] seeded TEST creator @test_sisyphus_ic2');
    }
    if (creator2 && !stmts.getAssignment.get(creator2.id, 'test-brand-b-e2e')) {
      stmts.insertAssignment.run(creator2.id, 'test-brand-b-e2e', 'TEST Brand B (E2E isolation)');
      console.log('[inner-circle-sqlite] seeded TEST brand assignment for @test_sisyphus_ic2');
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

  // Password hashing — scrypt with per-user salt, stored as "salt:hexhash"
  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return salt + ':' + hash;
  }
  function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    try {
      const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
    } catch (_) { return false; }
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
      let valid = false;
      if (creator.password_hash) {
        valid = verifyPassword(pw, creator.password_hash);
      } else {
        // Legacy fallback: accounts created before real passwords used the TikTok handle.
        const handle = creator.creator_handle || '';
        const handleNoAt = handle.replace(/^@/, '');
        valid = pw === handle || pw === handleNoAt || pw === '@' + handleNoAt;
        // Upgrade path: first successful legacy login sets their handle-password as a real hash
        if (valid) {
          try { stmts.setPassword.run(hashPassword(pw), creator.id); } catch (_) {}
        }
      }
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

  // ── POST /api/inner-circle/signup ───────────────────────────────────────────
  // Create Account flow. Body: {name, email, tiktok_handle, phone?}.
  // Stores creator_handle WITH a leading '@' — same format as existing rows;
  // login accepts the handle with or without '@' as the password either way.
  // Cohort 1 runs through end of July (see Active Context).
  const IC_COHORT_END = '2026-07-31';
  const IC_SIGNUP_DM_OPEN_ID = 'ou_c8f157f2f18a8c4ffe6a20d3971348e1';

  app.post('/api/inner-circle/signup', express.json(), (req, res) => {
    if (dbError) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const rawHandle = String(body.tiktok_handle || body.tiktokHandle || body.handle || '').trim();
      const password = String(body.password || '').trim();
      const phone = body.phone != null && String(body.phone).trim() !== '' ? String(body.phone).trim() : null;

      if (!name || !email || !rawHandle) {
        return res.status(400).json({ error: 'Name, email and TikTok handle are required' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      const handleNoAt = rawHandle.replace(/^@+/, '');
      if (!handleNoAt) return res.status(400).json({ error: 'Invalid TikTok handle' });
      const handle = '@' + handleNoAt;

      const existing = stmts.creatorByEmailAny.get(email);
      if (existing) {
        return res.status(409).json({ error: 'An account with this email already exists — try logging in instead' });
      }

      const today = new Date().toISOString().slice(0, 10);
      const info = stmts.insertCreatorFull.run(handle, name, email, phone, hashPassword(password), today, IC_COHORT_END);
      const creatorId = Number(info.lastInsertRowid);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19); // SQLite datetime format
      stmts.insertSession.run(token, creatorId, expiresAt);

      res.cookie('ic_session', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      // Fire-and-forget Lark notifications — a Lark failure must never block signup.
      try {
        const text = `🆕 Inner Circle Signup: ${name} (@${handleNoAt}) — ${email}`;
        icNotifyAlertChannel(text)
          .catch((e) => console.error('[inner-circle-sqlite] signup alert notify failed:', e.message));
        icNotifyDM(IC_SIGNUP_DM_OPEN_ID, text)
          .catch((e) => console.error('[inner-circle-sqlite] signup DM notify failed:', e.message));
      } catch (e) {
        console.error('[inner-circle-sqlite] signup notify dispatch failed:', e.message);
      }

      console.log(`[inner-circle-sqlite] signup: ${name} (${handle}) <${email}> id=${creatorId}`);
      return res.json({
        success: true,
        token,
        creator: {
          id: creatorId,
          name,
          email,
          tiktok_handle: handle,
          cohort_start: today,
          cohort_end: IC_COHORT_END,
          videos_goal: 20,
          commission_rate: 0.5,
          ads_commission_rate: 0.25,
        },
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] signup failed:', e.message);
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
        // Aliases matching the dashboard SPA (views/inner-circle.html)
        videosDelivered: b.videos_for_brand,
        earned: Math.round(b.gmv_for_brand * commissionRate * 100) / 100,
      }));

      let daysRemaining = null;
      if (c.cohort_end) {
        daysRemaining = Math.max(0, daysBetween(new Date(), new Date(c.cohort_end + 'T23:59:59Z')));
      }

      const call = stmts.nextCall.get();
      const nextCall = call
        ? { date: call.scheduled_at, title: call.title, link: call.lark_meeting_url || null }
        : null;

      // Call recordings library (the SPA renders data.recordings)
      let recordings = [];
      try {
        recordings = stmts.recordingsList.all().map((r) => ({
          id: r.id,
          title: r.title,
          date: r.scheduled_at ? String(r.scheduled_at).slice(0, 10) : '',
          duration: '',
          url: r.recording_url,
        }));
      } catch (e) {
        console.error('[inner-circle-sqlite] recordings query failed:', e.message);
      }

      return res.json({
        creator: {
          id: c.id,
          name: c.creator_name,
          firstName: String(c.creator_name || '').split(' ')[0],
          tiktokHandle: c.creator_handle,
          email: c.email,
          cohort: { start: c.cohort_start, end: c.cohort_end },
        },
        stats: {
          videosThisMonth,
          videosDelivered: videosThisMonth,
          videosGoal: c.videos_goal != null ? c.videos_goal : 20,
          commissionEarned,
          commissionRate,
          adsCommissionRate: c.ads_commission_rate != null ? c.ads_commission_rate : 0.25,
          daysRemaining,
          activeBrands: brands.length,
        },
        brands,
        nextCall,
        recordings,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] dashboard failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/recordings ────────────────────────────────────────
  // Shadows the legacy supabase-backed handler in dashboard-server.js (~line 1185),
  // which 500s in production (supabase client is undefined there). This module
  // mounts earlier in registration order, so this SQLite handler wins.
  app.get('/api/inner-circle/recordings', requireSqliteSession, (req, res) => {
    try {
      const recordings = stmts.recordingsList.all().map((r) => ({
        id: r.id,
        title: r.title,
        date: r.scheduled_at ? String(r.scheduled_at).slice(0, 10) : '',
        duration: '',
        url: r.recording_url,
        attended: null,
      }));
      return res.json({ recordings });
    } catch (e) {
      console.error('[inner-circle-sqlite] recordings failed:', e.message);
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
    { id: 'trusted-rituals', name: 'Trusted Rituals', logo: '/logos/trusted-rituals-white.svg', website: 'https://trustedrituals.com', brandColor: '#17A87B',
      description: 'Mullein honey sticks for respiratory health — 2,000mg per stick, Himalayan-sourced. Strong hooks around pollen season, quitting vaping, and daily wellness rituals.' },
    { id: 'diamandia', name: 'DIAMANDIA', logo: '/logos/diamandia-white.png', website: 'https://diamandia.com', brandColor: '#E5E4E2',
      description: 'DIAMANDIA TikTok Shop brand — 25% target collab commission on the hero product.' },
    { id: 'approved-science', name: 'Approved Science', logo: '/logos/approved-science.png', website: 'https://www.approvedscience.com', brandColor: '#1188DD',
      description: 'Science-backed supplements (Marketily / Lenea). Evidence-led content angles.' },
    { id: 'yuglo', name: 'Yuglo', logo: null, website: 'https://yugloskin.com', brandColor: '#F39976', // sourced from yugloskin.com homepage accent palette (peach, ~8:1 contrast vs #161823); dominant #108474 excluded — shared review-widget green seen across client sites
      description: 'Yuglo skincare — TikTok Shop brand.' },
    { id: 'roots-by-ga', name: 'Roots by GA', logo: null, website: 'https://www.rootsbyga.com', brandColor: null,
      description: 'Roots by GA — TikTok Shop brand (Carla Brenner).' },
    { id: 'lode-wtr', name: 'Lode WTR', logo: null, website: 'https://lodewtr.com', brandColor: '#CCFF00', // verified: dominant accent color on lodewtr.com (electric lime), ~14:1 contrast vs #161823
      description: 'Lode WTR — scalp care that replaces traditional shampoo. "Your shampoo is the problem" positioning; strong hooks around scalp health, hair loss, and ingredient honesty.' },
    { id: 'dissolvd', name: 'Dissolvd', logo: null, website: null, brandColor: '#A78BFA', // PLACEHOLDER — dissolvd.com is behind Cloudflare Access, no public site to source brand color (6.49:1 contrast vs #161823)
      description: 'Dissolvd — TikTok Shop brand.' },
    { id: 'the-perfect-haircare', name: 'The Perfect Haircare', logo: null, website: 'https://theperfecthaircare.com', brandColor: '#E35186', // verified: theme-color meta on theperfecthaircare.com, ~4.9:1 contrast vs #161823
      description: 'The Perfect Haircare — TikTok Shop haircare brand.' },
    { id: 'b-noor', name: 'B NOOR', logo: null, website: 'https://bnoor.com', brandColor: '#C9A24B', // placeholder gold accent (~6.8:1 contrast vs #161823); update when client uploads logo/color
      description: 'B NOOR — TikTok Shop brand.' },
  ];

  function icLoadBrandsFile() {
    try { return JSON.parse(fs.readFileSync(IC_BRANDS_FILE, 'utf8')); }
    catch (_) { return null; }
  }

  function icNormalizeWebsite(w) {
    const s = String(w || '').trim();
    if (!s) return null;
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
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
          website: icNormalizeWebsite(b.website || (cat && cat.website)),
          brandColor: b.brandColor || (cat && cat.brandColor) || null,
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

  // ── Admin: read + toggle Inner Circle brand enablement ──────────────────────
  // Env-key protected (IC_ADMIN_KEY). Lets ops flip brand.innerCircle in
  // brands.json in bulk without each client logging into their portal.
  //   GET  /api/inner-circle/admin/brands           ?key=...    -> all brands w/ innerCircle state
  //   POST /api/inner-circle/admin/toggle-brand      {key, brand, enabled}  brand = id or name
  function icCheckAdminKey(req) {
    const want = process.env.IC_ADMIN_KEY;
    if (!want) return false;
    const got = req.query.key || (req.body && req.body.key) || req.get('x-ic-admin-key');
    return typeof got === 'string' && got === want;
  }

  app.get('/api/inner-circle/admin/brands', (req, res) => {
    if (!icCheckAdminKey(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = icLoadBrandsFile();
    if (!data || !Array.isArray(data.clients)) return res.status(500).json({ error: 'brands.json unreadable' });
    const brands = data.clients.map((b) => ({
      id: b.id || null,
      name: b.name || null,
      innerCircle: !!b.innerCircle,
      hasCatalog: !!icCatalogFor(b.name),
      isTest: !!b.TEST,
    }));
    return res.json({ brands, enabledCount: brands.filter((b) => b.innerCircle).length });
  });

  app.post('/api/inner-circle/admin/toggle-brand', express.json(), (req, res) => {
    if (!icCheckAdminKey(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { brand, enabled } = req.body || {};
    if (!brand) return res.status(400).json({ error: 'brand (id or name) required' });
    const want = enabled === undefined ? true : !!enabled;
    const data = icLoadBrandsFile();
    if (!data || !Array.isArray(data.clients)) return res.status(500).json({ error: 'brands.json unreadable' });
    const key = String(brand).toLowerCase().trim();
    const slug = key.replace(/\s+/g, '-');
    const rec = data.clients.find((b) => b && ((b.id && String(b.id).toLowerCase() === key) || (b.id && String(b.id).toLowerCase() === slug) || (b.name && String(b.name).toLowerCase() === key)));
    if (!rec) return res.status(404).json({ error: 'brand not found in brands.json', brand });
    const before = !!rec.innerCircle;
    rec.innerCircle = want;
    try { fs.writeFileSync(IC_BRANDS_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { return res.status(500).json({ error: 'write failed: ' + e.message }); }
    if (before !== want) {
      icNotifyAlertChannel(`${want ? '🌀' : '🔕'} Inner Circle ${want ? 'ENABLED ✅' : 'DISABLED ❌'} for *${rec.name}* (admin toggle)`).catch(() => {});
    }
    return res.json({ ok: true, brand: rec.name, id: rec.id || null, innerCircle: want, changed: before !== want });
  });

  // ── POST /api/inner-circle/select-brand ────────────���────────────────────────
  // Creator selects an Inner Circle brand. Persists the creator→brand link in
  // inner_circle_brand_assignments (upsert: re-selecting reactivates), writes a
  // durable jsonl log, then notifies the Lark alert channel (relay primary,
  // direct Lark fallback — same proven pattern as the covenant route).
  const IC_RELAY_URL = (process.env.RAILWAY_URL || 'https://cultcontent-server-production.up.railway.app') + '/command';

  async function icGetLarkToken(axios) {
    try {
      const r = await axios.post(
        'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET },
        { timeout: 8000 }
      );
      return (r.data && r.data.tenant_access_token) || null;
    } catch (_) { return null; }
  }

  async function icNotifyAlertChannel(text) {
    let axios;
    try { axios = require('axios'); }
    catch (e) { console.error('[inner-circle-sqlite] axios unavailable:', e.message); return { notified: false, via: null }; }

    // 1) Relay → alert channel (primary, proven pattern)
    try {
      await axios.post(IC_RELAY_URL, {
        text,
        context: 'Inner Circle Brand Selection',
        source: 'Inner Circle Portal',
      }, { timeout: 8000 });
      return { notified: true, via: 'relay' };
    } catch (e) {
      console.error('[inner-circle-sqlite] relay notify failed:', e.response?.data || e.message);
    }

    // 2) Direct Lark → alert channel chat_id (fallback)
    try {
      const chatId = process.env.LARK_ALERT_CHAT_ID;
      const token = chatId ? await icGetLarkToken(axios) : null;
      if (token && chatId) {
        await axios.post(
          'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id',
          { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        return { notified: true, via: 'lark-chat' };
      }
    } catch (e) {
      console.error('[inner-circle-sqlite] direct chat notify failed:', e.response?.data || e.message);
    }
    return { notified: false, via: null };
  }

  // Direct Lark DM to a user open_id (used by signup notify). Function
  // declaration — hoisted, so routes registered earlier can call it.
  async function icNotifyDM(openId, text) {
    let axios;
    try { axios = require('axios'); }
    catch (e) { console.error('[inner-circle-sqlite] axios unavailable:', e.message); return { notified: false }; }
    try {
      const token = await icGetLarkToken(axios);
      if (!token || !openId) return { notified: false };
      await axios.post(
        'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
        { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
      );
      return { notified: true };
    } catch (e) {
      console.error('[inner-circle-sqlite] DM notify failed:', e.response?.data || e.message);
      return { notified: false };
    }
  }

  app.post('/api/inner-circle/select-brand', requireSqliteSession, express.json(), async (req, res) => {
    try {
      const c = req.icCreator;
      const { brandId, brandName } = req.body || {};
      if (!brandId && !brandName) return res.status(400).json({ error: 'brandId required' });

      // Validate against IC-enabled brands (brands.json is the source of truth).
      const data = icLoadBrandsFile();
      const enabled = ((data && data.clients) || []).filter((b) => b && b.innerCircle);
      const brand = enabled.find((b) =>
        (brandId != null && String(b.id) === String(brandId)) ||
        (brandName && String(b.name || '').toLowerCase().trim() === String(brandName).toLowerCase().trim())
      );
      if (!brand) return res.status(404).json({ error: 'Brand not found or not Inner Circle enabled' });

      // Upsert the creator→brand link.
      let action;
      const existing = stmts.getAssignment.get(c.id, brand.id);
      if (existing) {
        stmts.reactivateAssignment.run(brand.name, existing.id);
        action = 'updated';
      } else {
        stmts.insertAssignment.run(c.id, brand.id, brand.name);
        action = 'created';
      }
      const assignment = stmts.getAssignment.get(c.id, brand.id);

      // Durable log first — notify failure must never lose the selection.
      try {
        fs.appendFileSync(path.join(IC_DATA_DIR, 'inner-circle-brand-selections.jsonl'), JSON.stringify({
          at: new Date().toISOString(), creatorId: c.id, creatorName: c.creator_name,
          tiktokHandle: c.creator_handle, brandId: brand.id, brandName: brand.name, action,
        }) + '\n');
      } catch (e) { console.error('[inner-circle-sqlite] selection log write failed:', e.message); }

      const handle = String(c.creator_handle || '').replace(/^@/, '');
      const text = `🤝 Inner Circle Brand Selection: ${c.creator_name}${handle ? ` (@${handle})` : ''} selected ${brand.name} — send target collab invite`;
      const { notified, via } = await icNotifyAlertChannel(text);
      console.log(`[inner-circle-sqlite] select-brand ${c.creator_name} → ${brand.name} (${action}, notified: ${notified}${via ? ' via ' + via : ''})`);

      return res.json({ ok: true, action, assignment, notified });
    } catch (e) {
      console.error('[inner-circle-sqlite] select-brand failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ADMIN + CLIENT-PORTAL VIEWS (read-only) — added June 2026
  // ════════════════════════════════════════════════════════════════════════════

  // Build a normalized roster row for a creator, optionally scoped to one shop_id.
  // When scopeShopId is provided, videos/gmv reflect ONLY that brand.
  function icCreatorRoster(scopeShopId) {
    const creators = db.prepare(
      `SELECT id, creator_handle, creator_name, email, status, videos_goal,
              commission_rate, cohort_start, cohort_end, created_at
         FROM inner_circle_creators
        WHERE status != 'removed'
        ORDER BY created_at DESC`
    ).all();

    const out = [];
    for (const c of creators) {
      // Brand assignments (active)
      let assignments;
      if (scopeShopId != null) {
        assignments = db.prepare(
          `SELECT shop_id, shop_name FROM inner_circle_brand_assignments
            WHERE creator_id = ? AND active = 1 AND shop_id = ?`
        ).all(c.id, String(scopeShopId));
        // If scoping and this creator isn't assigned to the brand, skip them.
        if (!assignments.length) continue;
      } else {
        assignments = db.prepare(
          `SELECT shop_id, shop_name FROM inner_circle_brand_assignments
            WHERE creator_id = ? AND active = 1`
        ).all(c.id);
      }

      // Video count + GMV (scoped or total)
      let videoRow, gmvRow;
      if (scopeShopId != null) {
        videoRow = db.prepare(
          `SELECT COUNT(*) n FROM inner_circle_videos WHERE creator_id = ? AND shop_id = ?`
        ).get(c.id, String(scopeShopId));
        gmvRow = db.prepare(
          `SELECT COALESCE(SUM(gmv),0) g FROM inner_circle_videos WHERE creator_id = ? AND shop_id = ?`
        ).get(c.id, String(scopeShopId));
      } else {
        videoRow = db.prepare(`SELECT COUNT(*) n FROM inner_circle_videos WHERE creator_id = ?`).get(c.id);
        gmvRow = db.prepare(`SELECT COALESCE(SUM(gmv),0) g FROM inner_circle_videos WHERE creator_id = ?`).get(c.id);
      }

      const goal = c.videos_goal || 20;
      const videos = videoRow.n || 0;
      const gmv = Math.round((gmvRow.g || 0) * 100) / 100;

      out.push({
        id: c.id,
        name: c.creator_name || null,
        handle: c.creator_handle,
        email: c.email || null,
        status: c.status,
        brands: assignments.map((a) => ({ shopId: a.shop_id, name: a.shop_name })),
        videos,
        videosGoal: goal,
        videosRemaining: Math.max(0, goal - videos),
        progressPct: Math.min(100, Math.round((videos / goal) * 100)),
        gmv,
        joined: c.created_at,
      });
    }
    return out;
  }

  // ── GET /api/inner-circle/admin/creators?key=… ──────────────────────────────
  // Full roster across all brands. Env-key protected (IC_ADMIN_KEY).
  app.get('/api/inner-circle/admin/creators', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const want = process.env.IC_ADMIN_KEY;
    const got = req.query.key || req.get('x-ic-admin-key');
    const sessionAdmin = !!(req.session && req.session.isPortalAdmin);
    if (!sessionAdmin && (!want || got !== want)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const creators = icCreatorRoster(null);
      // Enrich each creator's brand list with per-brand video/gmv/progress.
      const goalOf = (c) => (c.videosGoal || 20);
      for (const c of creators) {
        for (const b of (c.brands || [])) {
          const vr = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(gmv),0) g FROM inner_circle_videos WHERE creator_id = ? AND shop_id = ?').get(c.id, String(b.shopId));
          const goal = goalOf(c);
          b.videos = vr.n || 0;
          b.gmv = Math.round((vr.g || 0) * 100) / 100;
          b.videosGoal = goal;
          b.progressPct = Math.min(100, Math.round(((vr.n || 0) / goal) * 100));
        }
      }
      // Brand-level aggregates across all creators.
      const bmap = new Map();
      for (const c of creators) {
        const goal = goalOf(c);
        for (const b of (c.brands || [])) {
          let agg = bmap.get(String(b.shopId));
          if (!agg) { agg = { shopId: b.shopId, name: b.name, creatorCount: 0, videos: 0, gmv: 0, goalSum: 0 }; bmap.set(String(b.shopId), agg); }
          agg.creatorCount += 1;
          agg.videos += (b.videos || 0);
          agg.gmv += (b.gmv || 0);
          agg.goalSum += goal;
        }
      }
      const brands = Array.from(bmap.values())
        .map((b) => ({ ...b, gmv: Math.round(b.gmv * 100) / 100 }))
        .sort((a, b) => b.videos - a.videos);
      // Attach brand logo/color from the IC catalog when available.
      try {
        const cat = (typeof IC_CATALOG !== 'undefined' && IC_CATALOG) ? IC_CATALOG : {};
        for (const b of brands) {
          for (const k in cat) {
            const e = cat[k];
            if (e && (String(e.shopId) === String(b.shopId) || (e.name && b.name && e.name.toLowerCase() === b.name.toLowerCase()))) {
              if (e.logoUrl) b.logoUrl = e.logoUrl;
              if (e.brandColor) b.brandColor = e.brandColor;
              break;
            }
          }
        }
      } catch (_) { /* catalog optional */ }
      const summary = {
        totalCreators: creators.length,
        totalVideos: creators.reduce((s, c) => s + c.videos, 0),
        totalGmv: Math.round(creators.reduce((s, c) => s + c.gmv, 0) * 100) / 100,
        totalBrands: brands.length,
      };
      return res.json({ ok: true, summary, brands, creators });
    } catch (e) {
      console.error('[inner-circle-sqlite] admin/creators failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/client/creators ───────────────────────────────────
  // Brand-scoped roster for the logged-in CLIENT (express-session, set by the
  // client portal login → req.session.clientBrandId). Returns only the IC
  // creators assigned to THIS client's brand. No cross-brand data leakage.
  app.get('/api/inner-circle/client/creators', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });
    try {
      // Resolve the brand's Reacher shopId from brands.json (same store the
      // client portal uses). DATA_DIR mirrors dashboard-server.js logic.
      const fs = require('fs');
      const path = require('path');
      const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
      let brandsData;
      try { brandsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brands.json'), 'utf8')); }
      catch (_) { brandsData = { clients: [] }; }
      const brand = (brandsData.clients || []).find((b) => b.id === clientBrandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const shopId = brand.shopId || brand.shop_id || null;
      const innerCircleOn = brand.innerCircle === true;

      if (!shopId) {
        return res.json({
          ok: true,
          brand: { id: brand.id, name: brand.name, innerCircle: innerCircleOn },
          note: 'No shopId linked to this brand yet — connect the TikTok Shop to see Inner Circle creators.',
          summary: { totalCreators: 0, totalVideos: 0, totalGmv: 0 },
          creators: [],
        });
      }

      const creators = icCreatorRoster(shopId);
      const summary = {
        totalCreators: creators.length,
        totalVideos: creators.reduce((s, c) => s + c.videos, 0),
        totalGmv: Math.round(creators.reduce((s, c) => s + c.gmv, 0) * 100) / 100,
      };
      return res.json({
        ok: true,
        brand: { id: brand.id, name: brand.name, shopId, innerCircle: innerCircleOn },
        summary,
        creators,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] client/creators failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /inner-circle/admin?key=… (PAGE) ────────────────────────────────────
  // Self-contained dark-themed admin roster page. Reads from the JSON endpoint.
  app.get('/inner-circle/admin', (req, res) => {
    const want = process.env.IC_ADMIN_KEY;
    const got = req.query.key;
    const sessionAdmin = !!(req.session && req.session.isPortalAdmin);
    if (!sessionAdmin && (!want || got !== want)) {
      return res.redirect('/portal-admin');
    }
    return res.sendFile(path.join(__dirname, '..', 'views', 'inner-circle-admin.html'));
  });

  // ── GET /inner-circle/dashboard (PAGE) ──────────────────────────────────────
  // Shadows the legacy supabase-checked page route in dashboard-server.js
  // (~line 1434), which could never succeed: `supabase` is undefined there and
  // req.cookies doesn't exist (no cookie-parser) — every creator got bounced
  // back to the login page. Registration order makes this route win.
  app.get('/inner-circle/dashboard', (req, res) => {
    if (dbError) return res.redirect('/inner-circle');
    const token = getSessionToken(req);
    if (!token) return res.redirect('/inner-circle');
    try {
      const row = stmts.sessionByToken.get(token);
      if (!row) return res.redirect('/inner-circle');
      return res.sendFile(path.join(__dirname, '..', 'views', 'inner-circle.html'));
    } catch (e) {
      console.error('[inner-circle-sqlite] dashboard page session check failed:', e.message);
      return res.redirect('/inner-circle');
    }
  });

  // Expose the working session middleware so other routes can adopt it later.
  return { requireSqliteSession };
};
