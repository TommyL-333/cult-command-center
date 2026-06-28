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

  // ── Load DB layer defensively ─────────────────────────────────����─────────────
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

    // Additional TikTok handles — one creator can link multiple handles.
    // The PRIMARY handle stays on inner_circle_creators.creator_handle.
    db.exec(`
      CREATE TABLE IF NOT EXISTS inner_circle_handles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id INTEGER NOT NULL REFERENCES inner_circle_creators(id),
        handle TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(handle)
      );
      CREATE INDEX IF NOT EXISTS idx_ic_handles_creator ON inner_circle_handles(creator_id);
    `);

    // Phone column (not in the original schema) — idempotent migration for the
    // signup flow. SQLite throws if the column already exists; that's fine.
    try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN phone TEXT`); } catch (_) { /* column exists */ }
    try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN password_hash TEXT`); } catch (_) { /* column exists */ }

    // DB-level backstop against duplicate Inner Circle accounts by email.
    // Partial UNIQUE index on the normalized email (lower+trim) so that
    // legacy rows with NULL/empty email (password=handle) are exempt, while
    // any two real emails that normalize equal are rejected with
    // SQLITE_CONSTRAINT. Wrapped in its own try/catch so that (a) it is
    // idempotent on every deploy and (b) if pre-dedup duplicates still exist
    // the failure to create the index does NOT abort the rest of schema
    // migration — the de-dup endpoint clears collisions, then this succeeds
    // on the next deploy.
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_ic_creators_email
        ON inner_circle_creators(lower(trim(email)))
        WHERE email IS NOT NULL AND email != ''`);
    } catch (e) {
      console.error('[inner-circle-sqlite] ux_ic_creators_email not created (likely residual duplicate emails — run dedup endpoint):', e.message);
    }

    // Password reset tokens — single-use, time-limited. Idempotent create.
    db.exec(`
      CREATE TABLE IF NOT EXISTS inner_circle_resets (
        token TEXT PRIMARY KEY,
        creator_id INTEGER NOT NULL REFERENCES inner_circle_creators(id),
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ic_resets_creator ON inner_circle_resets(creator_id);
    `);

    // Creator self-set rates for the retainer marketplace. One row per creator.
    // All monetary values stored as integer cents. Idempotent create.
    db.exec(`
      CREATE TABLE IF NOT EXISTS creator_rates (
        creator_id INTEGER PRIMARY KEY REFERENCES inner_circle_creators(id),
        per_video_cents INTEGER,
        retainer_monthly_cents INTEGER,
        package_label TEXT,
        package_videos INTEGER,
        package_price_cents INTEGER,
        available INTEGER DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ── Retainer offers (brand → creator) ────────────────────────────────────
    // One row per offer. amount_cents stored as integer cents. Idempotent create.
    db.exec(`
      CREATE TABLE IF NOT EXISTS retainer_offers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id TEXT NOT NULL,
        brand_name TEXT,
        creator_id INTEGER NOT NULL REFERENCES inner_circle_creators(id),
        offer_type TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        videos INTEGER,
        terms TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retainer_offers_brand ON retainer_offers(brand_id);
      CREATE INDEX IF NOT EXISTS idx_retainer_offers_creator ON retainer_offers(creator_id);
    `);

    // responded_at — when the creator accepted/declined. Idempotent migration.
    try { db.exec(`ALTER TABLE retainer_offers ADD COLUMN responded_at DATETIME`); } catch (_) { /* column exists */ }

    // videos_delivered — brand-reported delivery progress against the
    // agreement's videos_committed. Idempotent migration. No payment data here;
    // money movement is escalated to a human, never executed by the API.
    try { db.exec(`ALTER TABLE retainer_agreements ADD COLUMN videos_delivered INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* column exists */ }

    // ── Retainer agreements (created on offer accept) ────────────────────────
    // One row per accepted offer. Mirrors the offer's economics at accept time.
    db.exec(`
      CREATE TABLE IF NOT EXISTS retainer_agreements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL REFERENCES retainer_offers(id),
        brand_id TEXT NOT NULL,
        creator_id INTEGER NOT NULL REFERENCES inner_circle_creators(id),
        amount_cents INTEGER NOT NULL,
        videos_committed INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_retainer_agreements_offer ON retainer_agreements(offer_id);
      CREATE INDEX IF NOT EXISTS idx_retainer_agreements_brand ON retainer_agreements(brand_id);
      CREATE INDEX IF NOT EXISTS idx_retainer_agreements_creator ON retainer_agreements(creator_id);
    
      CREATE TABLE IF NOT EXISTS inner_circle_commitments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id INTEGER NOT NULL,
        brand_id TEXT NOT NULL,
        brand_name TEXT,
        videos_per_month INTEGER DEFAULT 20,
        weekly_call INTEGER DEFAULT 1,
        committed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(creator_id, brand_id)
      );
    `);

    stmts = {
      getCommitment: db.prepare(
        `SELECT * FROM inner_circle_commitments WHERE creator_id = ? AND brand_id = ?`
      ),
      upsertCommitment: db.prepare(
        `INSERT INTO inner_circle_commitments (creator_id, brand_id, brand_name, videos_per_month, weekly_call, committed_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(creator_id, brand_id) DO UPDATE SET
           brand_name = excluded.brand_name,
           videos_per_month = excluded.videos_per_month,
           weekly_call = excluded.weekly_call,
           committed_at = CURRENT_TIMESTAMP`
      ),
      creatorByEmail: db.prepare(
        `SELECT * FROM inner_circle_creators WHERE lower(email) = lower(?) AND status = 'active'`
      ),
      // Status-agnostic email lookup — duplicate check on signup must catch
      // paused/removed accounts too, not just active ones.
      creatorByEmailAny: db.prepare(
        `SELECT * FROM inner_circle_creators WHERE lower(email) = lower(?)`
      ),
      // Additional-handle statements (multi-handle support)
      handlesForCreator: db.prepare(
        `SELECT id, handle, created_at FROM inner_circle_handles WHERE creator_id = ? ORDER BY id`
      ),
      handleOwnerAny: db.prepare(
        `SELECT id FROM inner_circle_creators WHERE lower(creator_handle) = lower(?)
         UNION
         SELECT creator_id AS id FROM inner_circle_handles WHERE lower(handle) = lower(?)`
      ),
      insertHandle: db.prepare(
        `INSERT INTO inner_circle_handles (creator_id, handle) VALUES (?, ?)`
      ),
      deleteHandle: db.prepare(
        `DELETE FROM inner_circle_handles WHERE id = ? AND creator_id = ?`
      ),
      insertCreatorFull: db.prepare(
        `INSERT INTO inner_circle_creators
           (creator_handle, creator_name, email, phone, password_hash, status, cohort_start, cohort_end, videos_goal, commission_rate, ads_commission_rate)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 20, 0.50, 0.25)`
      ),
      setPassword: db.prepare(
        `UPDATE inner_circle_creators SET password_hash = ? WHERE id = ?`
      ),
      // Password-reset token statements (single-use, time-limited).
      insertReset: db.prepare(
        `INSERT INTO inner_circle_resets (token, creator_id, expires_at) VALUES (?, ?, ?)`
      ),
      resetByToken: db.prepare(
        `SELECT r.token, r.creator_id, r.expires_at, c.*
           FROM inner_circle_resets r
           JOIN inner_circle_creators c ON c.id = r.creator_id
          WHERE r.token = ? AND r.used = 0 AND r.expires_at > datetime('now')`
      ),
      markResetUsed: db.prepare(
        `UPDATE inner_circle_resets SET used = 1 WHERE token = ?`
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
      activeAssignmentCount: db.prepare(
        `SELECT COUNT(*) AS n FROM inner_circle_brand_assignments WHERE creator_id = ? AND active = 1`
      ),
      activeAssignmentsList: db.prepare(
        `SELECT id, shop_id, shop_name, assigned_at FROM inner_circle_brand_assignments WHERE creator_id = ? AND active = 1 ORDER BY assigned_at ASC`
      ),
      // ── Creator retainer-marketplace rates ──────────────────────────────────
      getRates: db.prepare(
        `SELECT creator_id, per_video_cents, retainer_monthly_cents, package_label,
                package_videos, package_price_cents, available, updated_at
           FROM creator_rates WHERE creator_id = ?`
      ),
      upsertRates: db.prepare(
        `INSERT INTO creator_rates
           (creator_id, per_video_cents, retainer_monthly_cents, package_label,
            package_videos, package_price_cents, available, updated_at)
         VALUES (@creator_id, @per_video_cents, @retainer_monthly_cents, @package_label,
                 @package_videos, @package_price_cents, @available, CURRENT_TIMESTAMP)
         ON CONFLICT(creator_id) DO UPDATE SET
           per_video_cents        = excluded.per_video_cents,
           retainer_monthly_cents = excluded.retainer_monthly_cents,
           package_label          = excluded.package_label,
           package_videos         = excluded.package_videos,
           package_price_cents    = excluded.package_price_cents,
           available              = excluded.available,
           updated_at             = CURRENT_TIMESTAMP`
      ),
      // Marketplace: IC creators who have a rates row AND are available.
      marketplaceCreators: db.prepare(
        `SELECT c.id AS creator_id, c.creator_name, c.creator_handle,
                r.per_video_cents, r.retainer_monthly_cents, r.package_label,
                r.package_videos, r.package_price_cents, r.available
           FROM creator_rates r
           JOIN inner_circle_creators c ON c.id = r.creator_id
          WHERE r.available = 1 AND c.status != 'removed'
          ORDER BY c.creator_name COLLATE NOCASE ASC`
      ),
      // ── Retainer offers ──────────────────────────────────────────────────────
      creatorByIdBasic: db.prepare(
        `SELECT id, creator_name, creator_handle FROM inner_circle_creators WHERE id = ?`
      ),
      insertOffer: db.prepare(
        `INSERT INTO retainer_offers
           (brand_id, brand_name, creator_id, offer_type, amount_cents, videos, terms, status)
         VALUES (@brand_id, @brand_name, @creator_id, @offer_type, @amount_cents, @videos, @terms, 'pending')`
      ),
      getOfferById: db.prepare(
        `SELECT * FROM retainer_offers WHERE id = ?`
      ),
      offersForBrand: db.prepare(
        `SELECT o.*, c.creator_name, c.creator_handle
           FROM retainer_offers o
           JOIN inner_circle_creators c ON c.id = o.creator_id
          WHERE o.brand_id = ?
          ORDER BY o.created_at DESC`
      ),
      // Creator-side: every offer made TO this creator (pending + historical).
      offersForCreator: db.prepare(
        `SELECT * FROM retainer_offers
          WHERE creator_id = ?
          ORDER BY (status = 'pending') DESC, created_at DESC`
      ),
      // Accept/decline an offer — sets status + responded_at. responded_at NULL
      // guard keeps this idempotent (only a still-unanswered offer transitions).
      respondToOffer: db.prepare(
        `UPDATE retainer_offers
            SET status = @status, responded_at = CURRENT_TIMESTAMP
          WHERE id = @id AND creator_id = @creator_id AND status = 'pending'`
      ),
      insertAgreement: db.prepare(
        `INSERT INTO retainer_agreements
           (offer_id, brand_id, creator_id, amount_cents, videos_committed, status)
         VALUES (@offer_id, @brand_id, @creator_id, @amount_cents, @videos_committed, 'active')`
      ),
      getAgreementByOfferId: db.prepare(
        `SELECT * FROM retainer_agreements WHERE offer_id = ?`
      ),
      getAgreementById: db.prepare(
        `SELECT * FROM retainer_agreements WHERE id = ?`
      ),
      // Creator-side agreements: every agreement where this creator is the
      // counterparty. Joins the offer for brand_name + offer_type context.
      agreementsForCreator: db.prepare(
        `SELECT a.*, o.brand_name AS o_brand_name, o.offer_type AS o_offer_type
           FROM retainer_agreements a
           JOIN retainer_offers o ON o.id = a.offer_id
          WHERE a.creator_id = ?
          ORDER BY (a.status = 'active') DESC, a.created_at DESC`
      ),
      // Brand-side agreements: every agreement for this brand. Joins creator
      // for the counterparty name/handle.
      agreementsForBrand: db.prepare(
        `SELECT a.*, c.creator_name, c.creator_handle, o.offer_type AS o_offer_type
           FROM retainer_agreements a
           JOIN inner_circle_creators c ON c.id = a.creator_id
           JOIN retainer_offers o ON o.id = a.offer_id
          WHERE a.brand_id = ?
          ORDER BY (a.status = 'active') DESC, a.created_at DESC`
      ),
      // Set delivered to an absolute value + recompute status. Guarded by
      // brand_id so a brand can only progress its OWN agreements (IDOR-safe).
      // status auto-flips to 'completed' when delivered >= committed (and
      // committed is known/>0); otherwise stays 'active'.
      setAgreementDelivered: db.prepare(
        `UPDATE retainer_agreements
            SET videos_delivered = @videos_delivered,
                status = CASE
                  WHEN @videos_delivered >= videos_committed AND videos_committed IS NOT NULL AND videos_committed > 0
                    THEN 'completed' ELSE 'active' END
          WHERE id = @id AND brand_id = @brand_id`
      ),
    };

    // ── Idempotent TEST creator seed (E2E testing; TEST-prefixed per task
    //    cleanup policy — flagged for Tommy, removable any time) ────────��───�����─
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

  // ── Password reset: GHL email helper ──────────────────────────────────────��─
  // Sends a reset link to a creator via GHL (find contact → upsert conversation →
  // send Email message). Mirrors the confirmed pattern used in dashboard-server.js.
  // Returns { ok, reason? } and NEVER throws — callers wrap in try/catch anyway.
  const IC_PORTAL_BASE = process.env.IC_BASE_URL || 'https://portal.cultcontent.cc';

  async function icSendResetEmail(creator, resetUrl) {
    let axios;
    try { axios = require('axios'); }
    catch (e) { console.error('[inner-circle-sqlite] axios unavailable:', e.message); return { ok: false, reason: 'no-axios' }; }

    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOC_ID;
    if (!apiKey || !locationId) {
      console.error('[inner-circle-sqlite] reset email: GHL_API_KEY / GHL_LOC_ID not configured');
      return { ok: false, reason: 'ghl-not-configured' };
    }
    const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
    const email = String(creator.email || '').trim();
    if (!email) return { ok: false, reason: 'no-email' };

    // 1) Find the GHL contact by email
    let contactId = null;
    try {
      const sr = await axios.get('https://services.leadconnectorhq.com/contacts/', {
        headers, params: { locationId, query: email, limit: 1 }, timeout: 10000,
      });
      const found = (sr.data && sr.data.contacts) ? sr.data.contacts[0] : null;
      if (found && (found.email || '').toLowerCase() === email.toLowerCase()) contactId = found.id;
      else if (found) contactId = found.id; // best-effort: query returned the contact
    } catch (e) {
      console.error('[inner-circle-sqlite] reset email: contact lookup failed:', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
    }
    if (!contactId) return { ok: false, reason: 'contact-not-found' };

    // 2) Create / get a conversation for this contact
    let conversationId = null;
    try {
      const cr = await axios.post('https://services.leadconnectorhq.com/conversations/', {
        locationId, contactId,
      }, { headers, timeout: 10000 });
      conversationId = cr.data && (cr.data.conversationId || cr.data.id);
    } catch (ce) {
      // GHL returns non-2xx when the conversation already exists but still gives the ID
      conversationId = ce.response && ce.response.data && ce.response.data.conversationId;
      if (!conversationId) {
        console.error('[inner-circle-sqlite] reset email: conversation create failed:', ce.response && ce.response.data ? JSON.stringify(ce.response.data) : ce.message);
        return { ok: false, reason: 'conversation-failed' };
      }
    }

    // 3) Send the Email message containing the reset link (valid 1 hour)
    const firstName = (creator.creator_name || '').trim().split(/\s+/)[0] || 'there';
    const subject = 'Reset your Inner Circle password';
    const html = [
      `<p>Hi ${firstName},</p>`,
      `<p>We received a request to reset your Cult Content Inner Circle password.</p>`,
      `<p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#00f2ea;color:#161823;border-radius:8px;text-decoration:none;font-weight:600;">Reset my password</a></p>`,
      `<p>Or paste this link into your browser:<br><a href="${resetUrl}">${resetUrl}</a></p>`,
      `<p>This link is valid for <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>`,
      `<p>— Cult Content</p>`,
    ].join('\n');
    const text = `Hi ${firstName},\n\nReset your Inner Circle password using this link (valid 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n— Cult Content`;

    try {
      await axios.post('https://services.leadconnectorhq.com/conversations/messages', {
        type: 'Email',
        contactId,
        conversationId,
        subject,
        html,
        message: text,
        emailFrom: process.env.GHL_EMAIL_FROM || undefined,
      }, { headers, timeout: 10000 });
      return { ok: true, contactId, conversationId };
    } catch (me) {
      console.error('[inner-circle-sqlite] reset email: send failed:', me.response && me.response.data ? JSON.stringify(me.response.data) : me.message);
      return { ok: false, reason: 'send-failed' };
    }
  }

  // ── POST /api/inner-circle/forgot-password ──────────────────────────────────
  // Body: {email}. ALWAYS returns {ok:true} (no account enumeration). If a matching
  // active creator exists, mint a single-use 1-hour token, store it, and email a
  // reset link via GHL. GHL send is wrapped in try/catch — failures are logged,
  // never surfaced to the caller.
  app.post('/api/inner-circle/forgot-password', express.json(), async (req, res) => {
    if (dbError) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    const email = String((req.body && req.body.email) || '').trim();
    // Always respond ok:true regardless of outcome — prevents account enumeration.
    if (!email) return res.json({ ok: true });

    try {
      const creator = stmts.creatorByEmail.get(email);
      if (creator) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
          .toISOString().replace('T', ' ').slice(0, 19); // SQLite datetime, +1h
        stmts.insertReset.run(token, creator.id, expiresAt);
        const resetUrl = `${IC_PORTAL_BASE}/inner-circle/reset?token=${token}`;
        try {
          const r = await icSendResetEmail(creator, resetUrl);
          if (!r.ok) console.error('[inner-circle-sqlite] forgot-password: email not sent:', r.reason);
        } catch (e) {
          console.error('[inner-circle-sqlite] forgot-password: email send threw:', e.message);
        }
      }
    } catch (e) {
      // Log but never leak — caller always gets ok:true.
      console.error('[inner-circle-sqlite] forgot-password failed:', e.message);
    }
    return res.json({ ok: true });
  });

  // ── POST /api/inner-circle/reset-password ───────────────────────────────────
  // Body: {token, password}. Completes the forgot-password flow. Validates the
  // single-use token (resetByToken already filters used=0 AND not expired), sets
  // a new scrypt password hash (same format login's verifyPassword expects — NOT
  // bcrypt, or login would break), and marks the token used. Generic error on a
  // bad/expired/used token; no account enumeration.
  app.post('/api/inner-circle/reset-password', express.json(), (req, res) => {
    if (dbError) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    const token = String((req.body && req.body.token) || '').trim();
    const password = String((req.body && req.body.password) || '');

    if (!token) return res.status(400).json({ error: 'Reset link is invalid or expired' });
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const row = stmts.resetByToken.get(token);
      if (!row) return res.status(400).json({ error: 'Reset link is invalid or expired' });

      stmts.setPassword.run(hashPassword(password), row.creator_id);
      stmts.markResetUsed.run(token);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[inner-circle-sqlite] reset-password failed:', e.message);
      return res.status(400).json({ error: 'Reset link is invalid or expired' });
    }
  });

  // ── GET /inner-circle/reset?token=… (PAGE) ──────────────────────────
  // Self-contained password-reset page. Always returns 200 (even for an invalid
  // or missing token) so the emailed link never 404s. Token validity is enforced
  // server-side by POST /api/inner-circle/reset-password. The page reads the
  // token from the URL client-side, so no templating is needed here.
  app.get('/inner-circle/reset', (req, res) => {
    const _path = require('path');
    return res.sendFile(_path.join(__dirname, '..', 'views', 'inner-circle-reset.html'));
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
      // Race condition: two concurrent signups with the same email can both
      // pass the app-level creatorByEmailAny check above and race to INSERT.
      // The DB-level partial UNIQUE index (ux_ic_creators_email) is the
      // backstop — the loser of the race throws SQLITE_CONSTRAINT_UNIQUE.
      // Surface that as the SAME friendly 409 the app-level check returns,
      // not a generic 500. Match the email index by code + message so a
      // handle/other UNIQUE collision isn't mislabeled as an email dup.
      const msg = String(e && e.message || '');
      const isUnique = (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') || msg.includes('UNIQUE');
      const isEmailUnique = isUnique && (
        msg.includes('ux_ic_creators_email') ||
        /inner_circle_creators\.email/i.test(msg) ||
        // Generic UNIQUE on the creators table with no other unique column in
        // the INSERT — treat as the email collision (the only enforced unique).
        (!/handle/i.test(msg))
      );
      if (isEmailUnique) {
        console.warn('[inner-circle-sqlite] signup: duplicate-email UNIQUE race caught, returning 409:', msg);
        return res.status(409).json({ error: 'An account with this email already exists — try logging in or resetting your password' });
      }
      console.error('[inner-circle-sqlite] signup failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ─�� Additional TikTok handles ─────────────────────────
  // Creators may link more than one TikTok handle. Primary lives on the
  // creators row; extras live in inner_circle_handles. Never delete primary.
  function icNormalizeHandle(raw) {
    const noAt = String(raw || '').trim().replace(/^@+/, '');
    return noAt ? '@' + noAt : '';
  }

  function icHandlesList(c) {
    let extras = [];
    try {
      extras = stmts.handlesForCreator.all(c.id).map((h) => ({
        id: h.id, handle: h.handle, primary: false,
      }));
    } catch (e) {
      console.error('[inner-circle-sqlite] handles query failed:', e.message);
    }
    return [
      { id: null, handle: c.creator_handle, primary: true },
      ...extras,
    ];
  }

  app.get('/api/inner-circle/handles', requireSqliteSession, (req, res) => {
    try {
      return res.json({ handles: icHandlesList(req.icCreator) });
    } catch (e) {
      console.error('[inner-circle-sqlite] GET handles failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/inner-circle/handles', express.json(), requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;
      const handle = icNormalizeHandle((req.body || {}).handle);
      if (!handle || handle === '@') {
        return res.status(400).json({ error: 'A TikTok handle is required' });
      }
      if (String(c.creator_handle || '').toLowerCase() === handle.toLowerCase()) {
        return res.status(409).json({ error: 'That is already your primary handle' });
      }
      const owner = stmts.handleOwnerAny.get(handle, handle);
      if (owner) {
        return res.status(409).json({ error: 'That TikTok handle is already linked to an account' });
      }
      stmts.insertHandle.run(c.id, handle);
      return res.json({ ok: true, handles: icHandlesList(c) });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ error: 'That TikTok handle is already linked to an account' });
      }
      console.error('[inner-circle-sqlite] POST handles failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  app.delete('/api/inner-circle/handles/:id', requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid handle id' });
      const info = stmts.deleteHandle.run(id, c.id);
      if (!info.changes) return res.status(404).json({ error: 'Handle not found' });
      return res.json({ ok: true, handles: icHandlesList(c) });
    } catch (e) {
      console.error('[inner-circle-sqlite] DELETE handle failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Creator retainer-marketplace rates ──────────────────────────────────────
  // Helper: coerce to a non-negative integer or null. Returns {ok, val}.
  function intOrNull(v) {
    if (v === null || v === undefined || v === '') return { ok: true, val: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return { ok: false, val: null };
    return { ok: true, val: n };
  }

  const RATE_FIELDS = {
    perVideoCents: 'per_video_cents',
    retainerMonthlyCents: 'retainer_monthly_cents',
    packageVideos: 'package_videos',
    packagePriceCents: 'package_price_cents',
  };

  function ratesPayload(row) {
    // em-dash / null defaults when no row exists yet.
    if (!row) {
      return {
        perVideoCents: null,
        retainerMonthlyCents: null,
        packageLabel: '—',
        packageVideos: null,
        packagePriceCents: null,
        available: true,
        updatedAt: null,
      };
    }
    return {
      perVideoCents: row.per_video_cents,
      retainerMonthlyCents: row.retainer_monthly_cents,
      packageLabel: (row.package_label && row.package_label.length) ? row.package_label : '—',
      packageVideos: row.package_videos,
      packagePriceCents: row.package_price_cents,
      available: row.available !== 0,
      updatedAt: row.updated_at || null,
    };
  }

  app.get('/api/inner-circle/my-rates', requireSqliteSession, (req, res) => {
    try {
      const row = stmts.getRates.get(req.icCreator.id);
      return res.json({ rates: ratesPayload(row) });
    } catch (e) {
      console.error('[inner-circle-sqlite] GET my-rates failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/inner-circle/my-rates', express.json(), requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;
      const b = req.body || {};

      // Validate each integer-cents/count field: non-negative integer or null.
      const params = { creator_id: c.id };
      for (const [key, col] of Object.entries(RATE_FIELDS)) {
        const r = intOrNull(b[key]);
        if (!r.ok) {
          return res.status(400).json({ error: key + ' must be a non-negative integer or empty' });
        }
        params[col] = r.val;
      }

      // Package label: optional string, strip junk, cap length at 80.
      let label = b.packageLabel;
      if (label === null || label === undefined) {
        label = null;
      } else {
        label = String(label).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
        if (label === '' || label === '—') label = null;
      }
      params.package_label = label;

      // available: boolean-ish -> 0/1. Default available (1) when omitted.
      let avail = b.available;
      if (avail === undefined || avail === null) avail = true;
      params.available = (avail === true || avail === 1 || avail === 'true' || avail === '1') ? 1 : 0;

      stmts.upsertRates.run(params);
      const row = stmts.getRates.get(c.id);
      return res.json({ ok: true, rates: ratesPayload(row) });
    } catch (e) {
      console.error('[inner-circle-sqlite] POST my-rates failed:', e.message);
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
        handles: icHandlesList(c),
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
    // Optional per-brand filter. Accepts ?shop_id= (INTEGER, canonical brand key
    // matching inner_circle_videos / brand_assignments) and/or ?brand_id= (TEXT,
    // brands.json client id). No param => all recordings (unchanged behavior).
    const shopIdRaw = req.query.shop_id;
    const brandIdRaw = req.query.brand_id;
    const shopId =
      shopIdRaw !== undefined && shopIdRaw !== '' && !Number.isNaN(Number(shopIdRaw))
        ? Number(shopIdRaw)
        : null;
    const brandId =
      brandIdRaw !== undefined && String(brandIdRaw).trim() !== ''
        ? String(brandIdRaw).trim()
        : null;

    try {
      let rows;
      if (shopId !== null || brandId !== null) {
        // Build filtered query lazily so the shop_id/brand_id columns are only
        // referenced when actually filtering. If the brand migration hasn't run
        // yet, this throws and we fall back to an empty set below.
        const conds = ["recording_url IS NOT NULL", "recording_url != ''"];
        const params = [];
        if (shopId !== null) { conds.push('shop_id = ?'); params.push(shopId); }
        if (brandId !== null) { conds.push('brand_id = ?'); params.push(brandId); }
        try {
          rows = db
            .prepare(
              `SELECT id, title, scheduled_at, recording_url FROM inner_circle_calls
                WHERE ${conds.join(' AND ')}
                ORDER BY scheduled_at DESC LIMIT 50`
            )
            .all(...params);
        } catch (colErr) {
          // brand columns not present yet (pre-migration) — degrade gracefully:
          // a brand-scoped request on an unmigrated DB returns an empty set
          // rather than 500ing or leaking other brands' recordings.
          console.warn('[inner-circle-sqlite] recordings brand filter unavailable:', colErr.message);
          rows = [];
        }
      } else {
        rows = stmts.recordingsList.all();
      }

      const recordings = rows.map((r) => ({
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

  // ── GET /api/inner-circle/call-schedule ──────────────────────────────────────
  // Returns the weekly creator-call schedule for the brands this creator is
  // assigned to. Schedule data is sourced from the Ops Engine Clients Lark base
  // (Weekly Call Day/Time + Creator Call Meeting Link), mirrored here as a static
  // map keyed by brand slug so the endpoint stays fast and dependency-free.
  const IC_CALL_SCHEDULE = {
    // when + meetingLink mirrored from Ops Engine Clients Lark base.
    // color = brand creator-page accent (single source of truth, no runtime scraping).
    'approved-science':     { when: 'Tuesdays · 12:00 PM ET',   meetingLink: 'https://vc-usttp.larksuite.com/j/438787376', color: '#00a3a3', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=307k275f-3285-42f1-9592-412t6oj62r7r' },
    'diamandia':            { when: 'Fridays · 4:00 PM ET',     meetingLink: 'https://vc-usttp.larksuite.com/j/438787376', color: '#E5E4E2', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=076ged1c-bef5-43e3-a7f4-6dakfqi85p6k' },
    'lode-wtr':             { when: 'Fridays · 12:00 PM ET',    meetingLink: 'https://vc-usttp.larksuite.com/j/781105654', color: '#ccff00', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=5d9h0434-928d-49dd-bccd-51fnaqt64h0u' },
    'trusted-rituals':      { when: 'Tuesdays · 10:00 AM ET',   meetingLink: 'https://vc-usttp.larksuite.com/j/295587698', color: '#108474', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=b2eq4bf0-bdb1-4ed5-b011-f52p4im57mfg' },
    'the-perfect-haircare': { when: 'Tuesdays · 10:30 AM ET',   meetingLink: 'https://vc-usttp.larksuite.com/j/475877234', color: '#e35186', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=ff2v0f33-82fa-470f-a8c5-627g0on18kfu' },
    'dissolvd':             { when: 'Wednesdays · 10:00 AM ET',  meetingLink: 'https://vc-usttp.larksuite.com/j/764870287', color: '#ffbc00', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=506jd69b-fb5f-4846-bd8b-5a4h3mt35l3j' },
    'yuglo':                { when: 'Wednesdays · 10:30 AM ET',  meetingLink: 'https://vc-usttp.larksuite.com/j/387170441', color: '#f39976', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=297h04f4-30b1-4920-8e9b-586s6ssedq9h' },
    'b-noor':               { when: 'Thursdays · 10:00 AM ET',   meetingLink: 'https://vc-usttp.larksuite.com/j/361089866', color: '#c9a84c', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=a16of81b-9217-4651-a7c6-cf8h8lqc3g6r' },
    'roots-by-ga':          { when: 'Thursdays · 10:30 AM ET',   meetingLink: 'https://vc-usttp.larksuite.com/j/687799951', color: '#f4efe6', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=9bcp4885-b1a3-4a2f-b625-0f5s9vq94iev' },
    'dear-miss-gina':       { when: 'Fridays · 10:30 AM ET',    meetingLink: 'https://vc-usttp.larksuite.com/j/257394728', color: '#e8449c', chatLink: 'https://applink.larksuite.com/client/chat/chatter/add_by_link?link_token=406qe0ba-6d25-4924-8e74-a95q0lm43k1p' },
  };

  // Weekday + 24h time per slug, for building .ics calendar events.
  const IC_CALL_ICS = {
    'approved-science':     { day: 2, h: 12, m: 0 },
    'diamandia':            { day: 5, h: 16, m: 0 },
    'lode-wtr':             { day: 5, h: 12, m: 0 },
    'trusted-rituals':      { day: 2, h: 10, m: 0 },
    'the-perfect-haircare': { day: 2, h: 10, m: 30 },
    'dissolvd':             { day: 3, h: 10, m: 0 },
    'yuglo':                { day: 3, h: 10, m: 30 },
    'b-noor':               { day: 4, h: 10, m: 0 },
    'roots-by-ga':          { day: 4, h: 10, m: 30 },
    'dear-miss-gina':       { day: 5, h: 10, m: 30 },
  };

  app.get('/api/inner-circle/call-schedule', requireSqliteSession, (req, res) => {
    try {
      // Which brands is THIS creator enrolled in? (shop_id = brand slug)
      let rows = [];
      try { rows = stmts.brandsForCreator.all(req.icCreator.id, req.icCreator.id) || []; }
      catch (_) { rows = []; }
      const enrolledSlugs = new Set(rows.map(r => String(r.shop_id || '').trim()).filter(Boolean));

      // Display names from brands.json when available.
      let clients = [];
      try { const bf = icLoadBrandsFile(); clients = (bf && bf.clients) || []; } catch (_) {}
      const nameBySlug = {};
      for (const c of clients) { if (c && c.id) nameBySlug[c.id] = c.name || c.id; }

      // Return ALL brands that have a weekly call, flag the creator's own.
      const calls = Object.keys(IC_CALL_SCHEDULE).map(slug => {
        const sched = IC_CALL_SCHEDULE[slug] || {};
        return {
          slug,
          brand: nameBySlug[slug] || slug,
          when: sched.when || null,
          meetingLink: sched.meetingLink || null,
          color: sched.color || '#00f2ea',
          chatLink: sched.chatLink || null,
          enrolled: enrolledSlugs.has(slug),
        };
      });
      // Enrolled first; then by weekday so the list reads like a week.
      const dayOf = (slug) => (IC_CALL_ICS[slug] ? IC_CALL_ICS[slug].day : 9);
      const minOf = (slug) => (IC_CALL_ICS[slug] ? IC_CALL_ICS[slug].h * 60 + IC_CALL_ICS[slug].m : 9999);
      calls.sort((a, b) => {
        if (a.enrolled !== b.enrolled) return a.enrolled ? -1 : 1;
        const dd = dayOf(a.slug) - dayOf(b.slug); if (dd) return dd;
        return minOf(a.slug) - minOf(b.slug);
      });
      return res.json({ calls });
    } catch (e) {
      console.error('[inner-circle-sqlite] GET call-schedule failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/calls.ics ──────────────────────────────────────────
  // Downloadable calendar (RFC 5545) of every weekly creator call, as recurring
  // weekly events. Public-ish but harmless — no creator data, just the schedule.
  app.get('/api/inner-circle/calls.ics', (req, res) => {
    try {
      const DAYNAME = ['SU','MO','TU','WE','TH','FR','SA'];
      // Anchor the first occurrence to the next matching weekday from a fixed
      // recent Monday so DTSTART is stable across requests.
      const baseMonday = new Date(Date.UTC(2026, 5, 29, 0, 0, 0)); // 2026-06-29 = Monday
      const pad = (n) => String(n).padStart(2, '0');
      // ET is UTC-4 (EDT) in summer; store events in UTC by adding 4h.
      const fmtUTC = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
        'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z';

      let lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cult Content//Inner Circle Calls//EN',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Cult Content — Weekly Calls',
      ];
      for (const slug of Object.keys(IC_CALL_ICS)) {
        const ics = IC_CALL_ICS[slug];
        const sched = IC_CALL_SCHEDULE[slug] || {};
        const brand = (function () {
          try { const bf = icLoadBrandsFile(); const c = ((bf && bf.clients) || []).find(x => x && x.id === slug); return c ? (c.name || slug) : slug; }
          catch (_) { return slug; }
        })();
        // First occurrence: baseMonday + (day-1) days, at h:m ET (+4h => UTC).
        const start = new Date(baseMonday.getTime());
        start.setUTCDate(start.getUTCDate() + (ics.day - 1));
        start.setUTCHours(ics.h + 4, ics.m, 0, 0);
        const endD = new Date(start.getTime() + 30 * 60000);
        lines.push('BEGIN:VEVENT');
        lines.push('UID:cc-call-' + slug + '@cultcontent.cc');
        lines.push('DTSTAMP:' + fmtUTC(new Date()));
        lines.push('DTSTART:' + fmtUTC(start));
        lines.push('DTEND:' + fmtUTC(endD));
        lines.push('RRULE:FREQ=WEEKLY;BYDAY=' + DAYNAME[ics.day]);
        lines.push('SUMMARY:' + brand + ' — Creator Call');
        if (sched.meetingLink) { lines.push('LOCATION:' + sched.meetingLink); lines.push('URL:' + sched.meetingLink); }
        lines.push('DESCRIPTION:Weekly ' + brand + ' creator call. Join: ' + (sched.meetingLink || 'TBA'));
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      const body = lines.join('\r\n');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="cult-content-calls.ics"');
      return res.send(body);
    } catch (e) {
      console.error('[inner-circle-sqlite] GET calls.ics failed:', e.message);
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
      description: 'Roots by GA ���� TikTok Shop brand (Carla Brenner).' },
    { id: 'lode-wtr', name: 'Lode WTR', logo: null, website: 'https://lodewtr.com', brandColor: '#CCFF00', // verified: dominant accent color on lodewtr.com (electric lime), ~14:1 contrast vs #161823
      description: 'Lode WTR ��� scalp care that replaces traditional shampoo. "Your shampoo is the problem" positioning; strong hooks around scalp health, hair loss, and ingredient honesty.' },
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

  // ── Brand → Lark chat_id routing (Ops Engine base = source of truth) ───────
  // The Ops Engine Clients base holds each brand's "Creator Chat ID" (the oc_…
  // id needed to POST messages via the Lark API — the human invite *link*
  // cannot be used to send). We load the map from the base at startup + on a
  // 10-min interval and cache it. BRAND_CHAT_FALLBACK is the embedded safety
  // net: if the base read fails or a brand row is missing its chat id, we fall
  // back to this constant and log a warning — a Lark outage or a fat-fingered
  // base edit can never silently send a commitment notification into the void.
  const OPS_BASE_APP_TOKEN = process.env.OPS_ENGINE_APP_TOKEN || 'EsfBbIqfkauKozsxMHMuilDztod';
  const OPS_CLIENTS_TABLE_ID = process.env.OPS_ENGINE_CLIENTS_TABLE || 'tblgM1L7myeAfYQm';
  const BRAND_CHAT_FALLBACK = {
    'approved-science': 'oc_35c8179c0e156a643e23f7981f50bd2c',
    'b-noor': 'oc_4fe3c15d30ef7900e046e1b426624cb8',
    'dear-miss-gina': 'oc_a058282a4fc8bbcf196718b39c71a973',
    'diamandia': 'oc_ef2b3e823ae7a5de0fc48fd73b46c8ad',
    'dissolvd': 'oc_88ec974690c18323fab18cdafa729a3a',
    'lode-wtr': 'oc_be48b3b11e5ca6484060b7325130a3e7',
    'roots-by-ga': 'oc_9cbdf9cab3f129ff51b48156575d31b9',
    'the-perfect-haircare': 'oc_4c6994ef6ae2c704c1efb0d837962b63',
    'trusted-rituals': 'oc_5e113890fa729e692be260464be10b3b',
    'yuglo': 'oc_2e62d2f056fa43b07200dec3d3a729f4',
  };
  // brand name → slug, matching the canonical IC slug rules.
  function _brandSlugify(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  let _brandChatCache = null;       // { slugOrName: oc_id }
  let _brandChatLoadedAt = 0;

  async function loadBrandChatIdsFromBase() {
    let axios; try { axios = require('axios'); } catch (_) { return; }
    try {
      const token = await icGetLarkToken(axios);
      if (!token) { console.warn('[ic-commitment] base chat load: no Lark token, keeping cache/fallback'); return; }
      const map = {};
      let pageToken = '';
      for (let i = 0; i < 5; i++) {
        const url = 'https://open.larksuite.com/open-apis/bitable/v1/apps/' + OPS_BASE_APP_TOKEN +
          '/tables/' + OPS_CLIENTS_TABLE_ID + '/records?page_size=100' + (pageToken ? '&page_token=' + pageToken : '');
        const r = await axios.get(url, { headers: { Authorization: 'Bearer ' + token }, timeout: 8000 });
        const items = (r.data && r.data.data && r.data.data.items) || [];
        for (const it of items) {
          const f = it.fields || {};
          const brandName = (typeof f['Brand'] === 'string') ? f['Brand']
            : (Array.isArray(f['Brand']) && f['Brand'][0] && (f['Brand'][0].text || f['Brand'][0].name)) || '';
          let chatId = f['Creator Chat ID'];
          if (Array.isArray(chatId)) chatId = chatId[0] && (chatId[0].text || chatId[0]);
          chatId = (typeof chatId === 'string') ? chatId.trim() : '';
          if (brandName && chatId && /^oc_/.test(chatId)) {
            map[_brandSlugify(brandName)] = chatId;
            map[String(brandName).toLowerCase().trim()] = chatId;
          }
        }
        const more = r.data && r.data.data && r.data.data.has_more;
        pageToken = (r.data && r.data.data && r.data.data.page_token) || '';
        if (!more || !pageToken) break;
      }
      if (Object.keys(map).length) {
        _brandChatCache = map;
        _brandChatLoadedAt = Date.now();
        console.log('[ic-commitment] loaded ' + Object.keys(map).length + ' brand chat ids from Ops base');
      } else {
        console.warn('[ic-commitment] base returned no chat ids — keeping fallback');
      }
    } catch (e) {
      console.warn('[ic-commitment] base chat load failed (' + (e.response?.status || e.message) + ') — using fallback');
    }
  }

  // Resolve a brand to its oc_ chat id: cache (base) → fallback constant.
  function getBrandChatId(brandId, brandName) {
    const slug = brandId ? _brandSlugify(brandId) : _brandSlugify(brandName);
    const nameKey = String(brandName || '').toLowerCase().trim();
    if (_brandChatCache) {
      const hit = _brandChatCache[slug] || (nameKey && _brandChatCache[nameKey]);
      if (hit) return hit;
    }
    const fb = BRAND_CHAT_FALLBACK[slug];
    if (fb) {
      if (_brandChatCache) console.warn('[ic-commitment] base missing chat id for "' + slug + '" — using fallback constant');
      return fb;
    }
    console.warn('[ic-commitment] NO chat id (base or fallback) for brand "' + (brandId || brandName) + '"');
    return null;
  }

  // Post a text message directly to a brand's creator-call chat by chat_id.
  async function icNotifyBrandChat(chatId, text) {
    if (!chatId) return { notified: false, via: null };
    let axios; try { axios = require('axios'); } catch (_) { return { notified: false, via: null }; }
    try {
      const token = await icGetLarkToken(axios);
      if (!token) return { notified: false, via: null };
      await axios.post(
        'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id',
        { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        { headers: { Authorization: 'Bearer ' + token }, timeout: 8000 }
      );
      return { notified: true, via: 'brand-chat' };
    } catch (e) {
      console.error('[ic-commitment] brand chat notify failed:', e.response?.data || e.message);
      return { notified: false, via: null };
    }
  }

  // Kick off the initial base load + periodic refresh (non-blocking).
  loadBrandChatIdsFromBase().catch(() => {});
  setInterval(() => { loadBrandChatIdsFromBase().catch(() => {}); }, 10 * 60 * 1000);


  // ── slug → numeric Reacher/TikTok shop_id ──────────────────────────────────
  // brands.json shape: { clients: [ { id: <slug>, shopId: <number>, ... } ] }.
  // Reuses IC_BRANDS_FILE + icLoadBrandsFile() (defined above) — no new imports,
  // no redeclared consts. Returns the numeric shopId or null if unmapped.
  function resolveNumericShopId(slug) {
    if (!slug) return null;
    const data = icLoadBrandsFile();
    if (!data || !Array.isArray(data.clients)) return null;
    const rec = data.clients.find(c => c && c.id === slug);
    if (!rec) return null;
    const n = Number(rec.shopId);
    return Number.isFinite(n) && n > 0 ? n : null;
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
      // Show EVERY live client brand — the script generator is available to all.
      // The Inner Circle commitment (50% commission) is offered only on brands
      // where the client has toggled Inner Circle on (brand.innerCircle).
      const allClients = ((data && data.clients) || []).filter((b) => b && b.name && !b.TEST);
      const brands = allClients.map((b) => {
        const cat = icCatalogFor(b.name);
        const slug = b.id || (cat && cat.id) || String(b.name || '').toLowerCase().trim().replace(/\s+/g, '-');
        return {
          id: slug,
          slug,
          name: b.name,
          logo: b.logoUrl || (cat && cat.logo) || null,
          description: (cat && cat.description) || b.description || '',
          website: icNormalizeWebsite(b.website || (cat && cat.website)),
          brandColor: b.brandColor || (cat && cat.brandColor) || null,
          innerCircle: !!b.innerCircle,
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

  // ── GET /api/inner-circle/brands/:brandId/products ───────────────────────────
  // IC Content Engine — product catalog for a creator's assigned brand, used by
  // the "Create your next videos" wizard. Returns proper JSON 401/403 (not the
  // global plain-text auth wall) so the SPA never false-logs-out on open.
  //   401 → requireSqliteSession rejects (no/expired session)
  //   403 → authenticated but NOT actively assigned to this brand
  //   200 → { products:[{ productId, name, image }] }
  app.get('/api/inner-circle/brands/:brandId/products', requireSqliteSession, async (req, res) => {
    try {
      const c = req.icCreator;
      const brandId = req.params.brandId != null ? String(req.params.brandId).trim() : '';
      if (!brandId) return res.status(400).json({ error: 'brandId required' });

      // Authorization (403) — must hold an ACTIVE assignment to this brand.
      let assignment = null;
      try { assignment = stmts.getAssignment.get(c.id, brandId); }
      catch (e) { return res.status(500).json({ error: 'Server error' }); }
      if (!assignment || !assignment.active) {
        return res.status(403).json({ error: 'Not assigned to this brand' });
      }

      // Resolve the brand record (source of truth: brands.json) → numeric shopId.
      const data = icLoadBrandsFile();
      const brand = ((data && data.clients) || []).find((b) =>
        b && (String(b.id) === brandId || String(b.name || '').toLowerCase().trim() === brandId.toLowerCase())
      );
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      const numericShopId = brand.shopId || brand.shop_id || brand.shopID || null;
      if (numericShopId == null) return res.json({ products: [] });

      // Fetch the live catalog via the same resolver generate-scripts uses.
      let resolver = null;
      try { resolver = require('../lib/product-resolver'); } catch (_) { resolver = null; }
      let catalog = [];
      if (resolver && typeof resolver.fetchCatalog === 'function') {
        try { catalog = await resolver.fetchCatalog(numericShopId); } catch (_) { catalog = []; }
      }

      const products = (Array.isArray(catalog) ? catalog : []).filter(Boolean).map((p) => ({
        productId: (p.product_id != null ? p.product_id : (p.productId != null ? p.productId : (p.id != null ? p.id : ''))),
        name: (p.product_name != null ? p.product_name : (p.name != null ? p.name : (p.title != null ? p.title : ''))),
        image: (p.main_image || p.image || p.imageUrl || p.thumbnail || '')
      }));

      // Enrich missing thumbnails from TikTok Shop (per-brand token).
      // Never throws — on any failure the dropdown still renders (names only).
      try {
        const needImages = products.some((p) => !p.image);
        if (needImages && brand.tiktokShopToken && brand.tiktokShopToken.access_token) {
          const tts = require('../lib/tts-product-images');
          if (tts && typeof tts.fetchProductImages === 'function') {
            const imgMap = await tts.fetchProductImages(brand);
            for (const p of products) {
              if (!p.image) {
                const imgs = imgMap[String(p.productId)];
                if (imgs && imgs.length) p.image = imgs[0];
              }
            }
          }
        }
      } catch (_) { /* image enrichment is best-effort */ }

      return res.json({ products });
    } catch (e) {
      console.error('[inner-circle-sqlite] brand-products error:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /api/inner-circle/generate-scripts ──────────────────────────────────
  // IC Content Engine — generate TikTok Shop affiliate scripts for a creator's
  // assigned brand + a chosen product. Auth/authorization contract (Step 8):
  //   401 → requireSqliteSession rejects (no/expired session)
  //   403 → creator IS authenticated but is NOT actively assigned to brandId
  //   404 → assigned, but productId does not resolve in the brand's catalog
  //   200 → { scripts:[...] }  (each annotated with violations/clean)
  // The LLM call is the swappable connector (lib/ic-script-generator.js).
  app.post('/api/inner-circle/generate-scripts', requireSqliteSession, express.json(), async (req, res) => {
    try {
      const c = req.icCreator;
      const body = req.body || {};
      const brandId = body.brandId != null ? String(body.brandId).trim() : '';
      const productId = body.productId != null ? String(body.productId).trim() : '';
      if (!brandId) return res.status(400).json({ error: 'brandId required' });
      if (!productId) return res.status(400).json({ error: 'productId required' });

      // ── AUTHORIZATION (403) — must hold an ACTIVE assignment to this brand ────
      // Assignments store brand.id in the shop_id column (see select-brand).
      let assignment = null;
      try { assignment = stmts.getAssignment.get(c.id, brandId); }
      catch (e) { return res.status(500).json({ error: 'Server error' }); }
      if (!assignment || !assignment.active) {
        return res.status(403).json({ error: 'Not assigned to this brand' });
      }

      // Resolve the brand record (source of truth: brands.json) → numeric shopId.
      const data = icLoadBrandsFile();
      const brand = ((data && data.clients) || []).find((b) =>
        b && (String(b.id) === brandId || String(b.name || '').toLowerCase().trim() === brandId.toLowerCase())
      );
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      const numericShopId = brand.shopId || brand.shop_id || brand.shopID || null;

      // ── PRODUCT RESOLUTION (404) — productId must exist in the brand catalog ──
      let resolver = null;
      try { resolver = require('../lib/product-resolver'); } catch (_) { resolver = null; }
      let catalog = [];
      if (resolver && typeof resolver.fetchCatalog === 'function' && numericShopId != null) {
        try { catalog = await resolver.fetchCatalog(numericShopId); } catch (_) { catalog = []; }
      }
      const product = Array.isArray(catalog)
        ? catalog.find((p) => p && String(p.product_id) === productId)
        : null;
      if (!product) {
        return res.status(404).json({ error: 'Product not found for this brand', productId });
      }

      // ── BUILD productContext + GENERATE (swappable connector) ────────────────
      const productContext = {
        brandName: brand.name,
        productName: product.name || product.title || '',
        productId: String(product.product_id),
        shopId: numericShopId,
        products: brand.products || '',
        audience: brand.audience || '',
        voice: brand.voice || '',
        proofPoints: brand.proofPoints || '',
        cta: brand.cta || '',
        avoidTopics: brand.avoidTopics || '',
        contentPillars: brand.contentPillars || '',
        extraContext: brand.extraContext || '',
      };

      let gen;
      try { gen = require('../lib/ic-script-generator'); }
      catch (e) { return res.status(500).json({ error: 'Script engine unavailable' }); }

      let result;
      try {
        result = await gen.generateScripts(body, productContext);
      } catch (e) {
        const code = (e && e.code) || 'GENERATION_FAILED';
        const status = code === 'NO_API_KEY' ? 503 : 502;
        console.error('[inner-circle-sqlite] generate-scripts failed:', code, e && e.message);
        return res.status(status).json({ error: 'Script generation failed', code });
      }

      const scripts = gen.runViolationChecks((result && result.scripts) || []);

      // ── FIRE-AND-FORGET Bitable mirror (non-blocking) ────────────────────────
      // Mirror each generated script to Lark Base for unified team visibility.
      // The SQLite store remains the source of truth; a Bitable failure must
      // NEVER delay or alter the creator's response. We therefore build the
      // records, kick off the writes WITHOUT awaiting, and guard with .catch()
      // so an unexpected rejection can never surface as an unhandled rejection.
      try {
        const bitable = require('../lib/ic-script-bitable');
        const nowMs = Date.now();
        const records = (scripts || []).map((s, i) => ({
          hook: s && s.hook,
          credibility: s && s.credibility,
          problem: s && s.problem,
          proofStack: s && (s.proofStack || s.proof_stack),
          cta: s && s.cta,
          visualHookIdeas: s && (s.visualHookIdeas || s.visual_hook_ideas),
          fullScript: s && (s.fullScript || s.full_script || s.script),
          funnelStages: s && (s.funnelStages || s.funnelStage || s.funnel_stage),
          scriptIndex: i,
          creatorHandle: (c && (c.tiktok_handle || c.handle || c.name)) || '',
          creatorName: (c && c.creator_name) || (c && c.name) || '',
          creatorEmail: (c && c.email) || '',
          brand: brand.name,
          product: productContext.productName,
          generatedAt: nowMs,
        }));
        if (records.length) {
          // Non-awaited: returns immediately; failures are logged inside the lib
          // (persistScriptsToBitable never throws) and the extra .catch() is a
          // belt-and-suspenders guard against any synchronous throw on call.
          Promise.resolve()
            .then(() => bitable.persistScriptsToBitable(records))
            .then((summary) => {
              if (summary && summary.attempted) {
                console.log('[inner-circle-sqlite] bitable mirror:', summary.persisted, '/', summary.attempted, 'scripts persisted');
              }
            })
            .catch((e) => console.warn('[inner-circle-sqlite] bitable mirror failed (non-blocking):', e && e.message));
        }
      } catch (e) {
        // Module load or record-build failure: log and continue. Never blocks.
        console.warn('[inner-circle-sqlite] bitable mirror skipped (non-blocking):', e && e.message);
      }

      return res.json({
        scripts,
        brand: brand.name,
        product: productContext.productName,
        count: scripts.length,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] generate-scripts error:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/my-scripts ──────────────────��──────────────────────
  // Return the generated scripts for the LOGGED-IN creator, read from the Lark
  // Base (Bitable) mirror. The creator identity comes ENTIRELY from the session
  // (req.icCreator) — never from query params — so a creator can only ever see
  // their own scripts (IDOR-safe).
  //
  // We resolve the creator's email AND tiktok handle from the session row and
  // ask the Bitable helper to filter on "Creator Email" / "Creator Handle".
  // Fields are mapped back to camelCase by the helper.
  //
  // HONEST CONTRACT: on any Bitable error we return 200 with an EMPTY array plus
  // an `error` string — we NEVER fabricate scripts and never 500 the creator's
  // dashboard over a mirror outage. (A 200 + empty array is acceptable.)
  app.get('/api/inner-circle/my-scripts', requireSqliteSession, async (req, res) => {
    const c = req.icCreator || {};
    const email = String(c.email || '').trim();
    const handle = String(c.creator_handle || c.tiktok_handle || c.handle || '').trim();

    let bitable;
    try {
      bitable = require('../lib/ic-script-bitable');
    } catch (e) {
      console.warn('[inner-circle-sqlite] my-scripts: bitable lib load failed:', e && e.message);
      return res.json({ ok: false, scripts: [], error: 'bitable-unavailable' });
    }

    try {
      const result = await bitable.fetchScriptsFromBitable({ email, handle, limit: 200 });
      if (result && result.ok) {
        const scripts = Array.isArray(result.scripts) ? result.scripts : [];
        return res.json({ ok: true, scripts });
      }
      // Honest failure: surface the reason, return an empty array (200).
      return res.json({
        ok: false,
        scripts: [],
        error: (result && (result.reason || result.msg)) || 'bitable-error',
      });
    } catch (e) {
      // Defensive — the helper is contracted never to throw, but guard anyway.
      console.warn('[inner-circle-sqlite] my-scripts failed:', e && e.message);
      return res.json({ ok: false, scripts: [], error: 'exception' });
    }
  });

  // ── POST /api/inner-circle/commitment ───────────────────────────────────────
  // Creator pledges to a brand: 20 videos/month + weekly call attendance.
  // Allowed for ANY client brand (the dashboard now shows all 10 cards), not
  // just IC-toggled ones. Upserts one row per creator+brand, logs to jsonl,
  // and notifies BOTH the brand's creator-call chat (via Ops base routing)
  // and the main alert channel. Notify failure never loses the commitment.
  app.post('/api/inner-circle/commitment', requireSqliteSession, express.json(), async (req, res) => {
    try {
      const c = req.icCreator;
      const { brandId, brandName, videosPerMonth, weeklyCall, signature } = req.body || {};
      if (!brandId && !brandName) return res.status(400).json({ error: 'brandId required' });

      // Resolve the brand against brands.json (any client brand is valid).
      const data = icLoadBrandsFile();
      const clients = (data && data.clients) || [];
      const brand = clients.find((b) =>
        (brandId != null && String(b.id) === String(brandId)) ||
        (brandName && String(b.name || '').toLowerCase().trim() === String(brandName).toLowerCase().trim())
      );
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const videos = Number.isFinite(Number(videosPerMonth)) && Number(videosPerMonth) > 0
        ? Math.round(Number(videosPerMonth)) : 20;
      const callPledge = (weeklyCall === false || weeklyCall === 0) ? 0 : 1;

      const existing = stmts.getCommitment.get(c.id, brand.id);
      stmts.upsertCommitment.run(c.id, brand.id, brand.name, videos, callPledge);
      const action = existing ? 'updated' : 'created';

      // Durable log first — notify failure must never lose the commitment.
      try {
        fs.appendFileSync(path.join(IC_DATA_DIR, 'inner-circle-commitments.jsonl'), JSON.stringify({
          at: new Date().toISOString(), creatorId: c.id, creatorName: c.creator_name,
          tiktokHandle: c.creator_handle, brandId: brand.id, brandName: brand.name,
          videosPerMonth: videos, weeklyCall: !!callPledge, action,
        }) + '\n');
      } catch (e) { console.error('[ic-commitment] log write failed:', e.message); }

      // Persist the signed covenant to the dedicated Inner Circle Commitments Lark base.
      // Fire-and-forget — a base/token hiccup must never lose the commitment (already logged above).
      try {
        let _bx; try { _bx = require("axios"); } catch (_) { _bx = null; }
        const token = _bx ? await icGetLarkToken(_bx) : null;
        if (token && _bx) {
          const COMMIT_BASE = process.env.IC_COMMITMENTS_BASE || 'IqWBbhn9EaG3bYsfX7wu0uCqtwb';
          const COMMIT_TABLE = process.env.IC_COMMITMENTS_TABLE || 'tblgr9dPO5kmy5rx';
          const fields = {
            'Creator': c.creator_name || ('Creator #' + c.id),
            'Creator Name': c.creator_name || '',
            'TikTok Handle': c.creator_handle ? ('@' + String(c.creator_handle).replace(/^@/, '')) : '',
            'Email': c.email || '',
            'Brand': brand.name,
            'Videos / Month': videos,
            'Weekly Call Pledge': callPledge ? 'Yes' : 'No',
            'Signature (typed name)': (signature && String(signature).trim()) || (c.creator_name || ''),
            'Committed At': Date.now(),
            'Contract Version': 'covenant-v1',
          };
          await _bx.post(
            'https://open.larksuite.com/open-apis/bitable/v1/apps/' + COMMIT_BASE + '/tables/' + COMMIT_TABLE + '/records',
            { fields },
            { headers: { Authorization: 'Bearer ' + token }, timeout: 8000 }
          );
        }
      } catch (e) { console.error('[ic-commitment] base write failed:', e.response?.data || e.message); }

      // Notify the brand's creator-call chat (base-routed) + the alert channel.
      const pledgeText = '🔥 *Inner Circle Commitment* — ' + (c.creator_name || 'A creator') +
        (c.creator_handle ? ' (@' + c.creator_handle + ')' : '') +
        ' just committed to *' + brand.name + '*: ' + videos + ' videos/month' +
        (callPledge ? ' + weekly call attendance' : '') + '. 👁️';
      let brandChatNotified = false;
      try {
        const chatId = getBrandChatId(brand.id, brand.name);
        const r = await icNotifyBrandChat(chatId, pledgeText);
        brandChatNotified = !!(r && r.notified);
      } catch (e) { console.error('[ic-commitment] brand chat notify error:', e.message); }
      try { await icNotifyAlertChannel(pledgeText); } catch (_) {}

      console.log('[ic-commitment] ' + (c.creator_name || c.id) + ' → ' + brand.name +
        ' (' + action + ', ' + videos + ' vids, brandChat: ' + brandChatNotified + ')');

      return res.json({
        ok: true, success: true, action,
        brand: { id: brand.id, name: brand.name },
        videosPerMonth: videos, weeklyCall: !!callPledge,
        brandChatNotified,
      });
    } catch (e) {
      console.error('[ic-commitment] failed:', e.message);
      return res.status(500).json({ error: 'Could not save commitment' });
    }
  });

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

      // Enforce max 3 active brands per creator. Re-selecting an already-active
      // brand is always allowed (idempotent); only NEW selections beyond the cap
      // are rejected. (existing && existing.active) means it's already counted.
      const MAX_IC_BRANDS = 3;
      const alreadyActive = !!(existing && existing.active);
      if (!alreadyActive) {
        const activeCount = stmts.activeAssignmentCount.get(c.id).n;
        if (activeCount >= MAX_IC_BRANDS) {
          const current = stmts.activeAssignmentsList.all(c.id).map((a) => ({
            id: a.shop_id, name: a.shop_name, assignedAt: a.assigned_at,
          }));
          return res.status(400).json({
            success: false,
            error: `You can select at most ${MAX_IC_BRANDS} brands. Remove one before adding another.`,
            brands: current,
          });
        }
      }

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

      const brands = stmts.activeAssignmentsList.all(c.id).map((a) => ({
        id: a.shop_id, name: a.shop_name, assignedAt: a.assigned_at,
      }));
      return res.json({ success: true, ok: true, action, assignment, brands, notified });
    } catch (e) {
      console.error('[inner-circle-sqlite] select-brand failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ════════════════════════════════════��═════════════════════════════════════���═
  // ADMIN + CLIENT-PORTAL VIEWS (read-only) — added June 2026
  // ════════════════════════════════════════════════════════════════════════════

  // ── Shared admin gate for BOTH admin routes (JSON + HTML) ───────────────────
  // Accepts ANY of: (a) portal-admin express-session (req.session.isPortalAdmin),
  // (b) the IC_ADMIN_KEY shared secret via ?key= / x-ic-admin-key header, or
  // (c) a Cloudflare Access identity header (cf-access-authenticated-user-email),
  // which dashboard-server.js enforces upstream when CF_ACCESS_AUD is set.
  // NOTE (for Tommy): confirm the intended auth model. Today any request that
  // already carries cf-access-authenticated-user-email (i.e. passed Cloudflare
  // Access) is treated as an authenticated admin here. If IC admin should be
  // restricted to a specific allow-list of CF Access emails, set IC_ADMIN_EMAILS
  // (comma-separated) and this gate will enforce membership.
  function icAdminGate(req) {
    if (req.session && req.session.isPortalAdmin) return true;
    const want = process.env.IC_ADMIN_KEY;
    const got = (req.query && req.query.key) || (req.body && req.body.key) || req.get('x-ic-admin-key');
    if (want && typeof got === 'string' && got === want) return true;
    const cfEmail = req.get('cf-access-authenticated-user-email');
    if (cfEmail) {
      const allow = (process.env.IC_ADMIN_EMAILS || '').split(',').map(function(e){return e.trim().toLowerCase();}).filter(Boolean);
      if (!allow.length) return true; // no allow-list configured → any CF-authenticated user is admin
      return allow.indexOf(String(cfEmail).toLowerCase()) !== -1;
    }
    return false;
  }

  // Build a normalized roster row for a creator, optionally scoped to one shop_id.
  // When scopeShopId is provided, videos/gmv reflect ONLY that brand.
  function icCreatorRoster(scope) {
    // scope can be: null (all creators, total videos),
    //   a string/number (legacy: same id used for membership + videos), or
    //   { membershipId, shopId } where membershipId matches
    //   inner_circle_brand_assignments.shop_id (actually the brand.id) and
    //   shopId matches inner_circle_videos.shop_id (the TikTok shopId).
    let membershipId = null, videoShopId = null;
    if (scope != null && typeof scope === 'object') {
      membershipId = scope.membershipId != null ? String(scope.membershipId) : null;
      videoShopId = scope.shopId != null ? String(scope.shopId) : null;
    } else if (scope != null) {
      membershipId = String(scope);
      videoShopId = String(scope);
    }
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
      if (membershipId != null) {
        assignments = db.prepare(
          `SELECT shop_id, shop_name FROM inner_circle_brand_assignments
            WHERE creator_id = ? AND active = 1 AND shop_id = ?`
        ).all(c.id, membershipId);
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
      if (videoShopId != null) {
        videoRow = db.prepare(
          `SELECT COUNT(*) n FROM inner_circle_videos WHERE creator_id = ? AND shop_id = ?`
        ).get(c.id, videoShopId);
        gmvRow = db.prepare(
          `SELECT COALESCE(SUM(gmv),0) g FROM inner_circle_videos WHERE creator_id = ? AND shop_id = ?`
        ).get(c.id, videoShopId);
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

  // ── GET /api/inner-circle/admin/creators?key=… ─────────��────────────────────
  // Full roster across all brands. Env-key protected (IC_ADMIN_KEY).
  app.get('/api/inner-circle/admin/creators', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    if (!icAdminGate(req)) return res.status(401).json({ error: 'Unauthorized' });
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

  // ── DELETE /api/inner-circle/admin/creators/:id?key=… ──────────────���─��──────
  // Key-protected hard delete of a single creator + their child rows
  // (videos, extra handles, brand assignments). Used for test-row cleanup and
  // removing accidental dupes. Env-key protected (IC_ADMIN_KEY) or portal admin
  // session — same gate as the roster endpoint above. Runs in a transaction.
  app.delete('/api/inner-circle/admin/creators/:id', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    if (!icAdminGate(req)) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid creator id' });
    try {
      const row = db.prepare('SELECT id, creator_name, email FROM inner_circle_creators WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Creator not found' });
      const tx = db.transaction((cid) => {
        let videos = 0, handles = 0, assignments = 0;
        try { videos = db.prepare('DELETE FROM inner_circle_videos WHERE creator_id = ?').run(cid).changes; } catch (_) {}
        try { handles = db.prepare('DELETE FROM inner_circle_handles WHERE creator_id = ?').run(cid).changes; } catch (_) {}
        try { assignments = db.prepare('DELETE FROM inner_circle_brand_assignments WHERE creator_id = ?').run(cid).changes; } catch (_) {}
        const creator = db.prepare('DELETE FROM inner_circle_creators WHERE id = ?').run(cid).changes;
        return { videos, handles, assignments, creator };
      });
      const deleted = tx(id);
      console.log(`[inner-circle-sqlite] admin delete creator id=${id} <${row.email}> ->`, JSON.stringify(deleted));
      return res.json({ ok: true, deletedId: id, email: row.email, name: row.creator_name, deleted });
    } catch (e) {
      console.error('[inner-circle-sqlite] admin delete creator failed:', e.message);
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

      const creators = icCreatorRoster({ membershipId: brand.id, shopId });
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
    if (!icAdminGate(req)) {
      return res.redirect('/portal-admin');
    }
    return res.sendFile(path.join(__dirname, '..', 'views', 'inner-circle-admin.html'));
  });

  // ── GET /inner-circle/dashboard (PAGE) ───────────────────────────��───────���──
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

  // ── GET /api/inner-circle/marketplace ───────────────────────────────────────
  // Brand-side creator marketplace for the logged-in CLIENT (express-session,
  // set by the client portal login → req.session.clientBrandId — same auth gate
  // the /api/inner-circle/client/* routes use). Returns every IC creator who has
  // published a rates row AND is currently available. 401 if no client session.
  app.get('/api/inner-circle/marketplace', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const rows = stmts.marketplaceCreators.all();
      const creators = rows.map((row) => ({
        creatorId: row.creator_id,
        name: row.creator_name || null,
        tiktokHandle: row.creator_handle,
        rates: {
          perVideo: row.per_video_cents,
          retainerMonthly: row.retainer_monthly_cents,
          package: {
            label: (row.package_label && row.package_label.length) ? row.package_label : null,
            videos: row.package_videos,
            priceCents: row.package_price_cents,
          },
        },
        available: row.available !== 0,
      }));
      return res.json({ ok: true, count: creators.length, creators });
    } catch (e) {
      console.error('[inner-circle-sqlite] marketplace failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /api/inner-circle/offers ─────────────��───��──────────────────────────
  // Brand (logged-in CLIENT via express-session → req.session.clientBrandId)
  // makes a retainer/per-video/package/custom offer to an IC creator. Durable
  // jsonl log is written BEFORE the Lark notify so a notify failure can never
  // lose the offer. Lark notify failure never fails the request.
  const IC_VALID_OFFER_TYPES = ['per_video', 'retainer', 'package', 'custom'];
  app.post('/api/inner-circle/offers', express.json(), async (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });

    const { creatorId, offerType, amountCents, videos, terms } = req.body || {};

    // Validate offer type
    if (!offerType || !IC_VALID_OFFER_TYPES.includes(String(offerType))) {
      return res.status(400).json({ error: 'Invalid offerType', valid: IC_VALID_OFFER_TYPES });
    }
    // Validate amount (integer cents, >= 0)
    const amt = Number(amountCents);
    if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt < 0) {
      return res.status(400).json({ error: 'amountCents must be a non-negative integer (cents)' });
    }
    // Validate creatorId
    const cid = Number(creatorId);
    if (!Number.isInteger(cid) || cid <= 0) {
      return res.status(400).json({ error: 'creatorId required' });
    }
    // Optional videos must be a non-negative integer if provided
    let vids = null;
    if (videos !== undefined && videos !== null && videos !== '') {
      vids = Number(videos);
      if (!Number.isInteger(vids) || vids < 0) {
        return res.status(400).json({ error: 'videos must be a non-negative integer' });
      }
    }

    try {
      // Resolve brand from session (brands.json is source of truth).
      const data = icLoadBrandsFile();
      const brand = ((data && data.clients) || []).find((b) => b && b.id === clientBrandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found for session' });

      // Verify creator exists.
      const creator = stmts.creatorByIdBasic.get(cid);
      if (!creator) return res.status(404).json({ error: 'Creator not found' });

      // Insert offer (status='pending').
      const info = stmts.insertOffer.run({
        brand_id: String(brand.id),
        brand_name: brand.name || null,
        creator_id: cid,
        offer_type: String(offerType),
        amount_cents: amt,
        videos: vids,
        terms: (terms != null && String(terms).length) ? String(terms) : null,
      });
      const offer = stmts.getOfferById.get(info.lastInsertRowid);

      // Durable log FIRST — notify failure must never lose the offer.
      try {
        fs.appendFileSync(path.join(IC_DATA_DIR, 'ic-retainer-offers.jsonl'), JSON.stringify({
          at: new Date().toISOString(),
          offerId: offer.id,
          brandId: brand.id,
          brandName: brand.name || null,
          creatorId: cid,
          creatorName: creator.creator_name || null,
          tiktokHandle: creator.creator_handle || null,
          offerType: String(offerType),
          amountCents: amt,
          videos: vids,
          terms: offer.terms,
          status: 'pending',
        }) + '\n');
      } catch (e) {
        console.error('[inner-circle-sqlite] offer log write failed:', e.message);
      }

      // Lark notify (relay primary, direct LARK_ALERT_CHAT_ID fallback).
      const handle = String(creator.creator_handle || '').replace(/^@/, '');
      const dollars = (amt / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const termsText = offer.terms || `${offerType}${vids != null ? ' / ' + vids + ' videos' : ''}`;
      const text = `💼 Retainer Offer: ${brand.name || brand.id} offered @${handle} ${dollars} for ${termsText}`;
      let notified = false, via = null;
      try {
        const r = await icNotifyAlertChannel(text);
        notified = !!(r && r.notified);
        via = r && r.via;
      } catch (e) {
        console.error('[inner-circle-sqlite] offer notify threw:', e.message);
      }
      console.log(`[inner-circle-sqlite] offer #${offer.id} ${brand.name} → @${handle} ${dollars} (notified: ${notified}${via ? ' via ' + via : ''})`);

      return res.json({
        ok: true,
        offer: {
          id: offer.id,
          brandId: offer.brand_id,
          brandName: offer.brand_name,
          creatorId: offer.creator_id,
          creatorName: creator.creator_name || null,
          tiktokHandle: creator.creator_handle || null,
          offerType: offer.offer_type,
          amountCents: offer.amount_cents,
          videos: offer.videos,
          terms: offer.terms,
          status: offer.status,
          createdAt: offer.created_at,
        },
        notified,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] create offer failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/offers ─────────────────────────────────────────────
  // Lists every offer this brand (client session) has sent. 401 if no session.
  app.get('/api/inner-circle/offers', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const rows = stmts.offersForBrand.all(String(clientBrandId));
      const offers = rows.map((o) => ({
        id: o.id,
        brandId: o.brand_id,
        brandName: o.brand_name,
        creatorId: o.creator_id,
        creatorName: o.creator_name || null,
        tiktokHandle: o.creator_handle || null,
        offerType: o.offer_type,
        amountCents: o.amount_cents,
        videos: o.videos,
        terms: o.terms,
        status: o.status,
        createdAt: o.created_at,
      }));
      return res.json({ ok: true, count: offers.length, offers });
    } catch (e) {
      console.error('[inner-circle-sqlite] list offers failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/my-offers ──────────────────────────────────────────
  // Creator-side: pending + historical offers made TO the logged-in creator.
  // IDOR-safe: creator_id comes from the session (req.icCreator.id), never params.
  app.get('/api/inner-circle/my-offers', requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;
      const rows = stmts.offersForCreator.all(c.id);
      const offers = rows.map((o) => ({
        id: o.id,
        brandId: o.brand_id,
        brandName: o.brand_name,
        offerType: o.offer_type,
        amountCents: o.amount_cents,
        videos: o.videos,
        terms: o.terms,
        status: o.status,
        createdAt: o.created_at,
        respondedAt: o.responded_at || null,
      }));
      const pending = offers.filter((o) => o.status === 'pending').length;
      return res.json({ ok: true, count: offers.length, pending, offers });
    } catch (e) {
      console.error('[inner-circle-sqlite] my-offers failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── POST /api/inner-circle/offers/:id/respond ────────────────────���────────────
  // Creator accepts or declines an offer. Body: {action: 'accept'|'decline'}.
  // IDOR-safe: ownership enforced by creator_id from the session. The offer must
  // belong to this creator (404 otherwise) and still be pending (409 otherwise).
  // On accept, a retainer_agreements row is inserted (status='active'). Both
  // sides are notified via the Lark alert channel. Notify failure never fails
  // the response — the status change is already committed.
  app.post('/api/inner-circle/offers/:id/respond', requireSqliteSession, express.json(), async (req, res) => {
    try {
      const c = req.icCreator;
      const offerId = parseInt(req.params.id, 10);
      if (!Number.isFinite(offerId)) return res.status(400).json({ error: 'Invalid offer id' });

      const action = String((req.body && req.body.action) || '').trim().toLowerCase();
      if (action !== 'accept' && action !== 'decline') {
        return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
      }

      const offer = stmts.getOfferById.get(offerId);
      if (!offer) return res.status(404).json({ error: 'Offer not found' });
      // IDOR guard: the offer must belong to THIS creator. 403 — exists but not yours.
      if (Number(offer.creator_id) !== Number(c.id)) {
        return res.status(403).json({ error: 'This offer does not belong to you' });
      }
      if (offer.status !== 'pending') {
        return res.status(409).json({ error: 'Offer is no longer pending', status: offer.status });
      }

      const newStatus = action === 'accept' ? 'accepted' : 'declined';

      // Transactional: flip the offer status, and on accept insert the agreement.
      const apply = db.transaction(() => {
        const info = stmts.respondToOffer.run({ id: offerId, creator_id: c.id, status: newStatus });
        if (!info.changes) {
          // Lost a race — someone already responded. Signal 409 to the caller.
          const e = new Error('NOT_PENDING');
          e.code = 'NOT_PENDING';
          throw e;
        }
        let agreement = null;
        if (action === 'accept') {
          stmts.insertAgreement.run({
            offer_id: offerId,
            brand_id: String(offer.brand_id),
            creator_id: c.id,
            amount_cents: offer.amount_cents,
            videos_committed: offer.videos,
          });
          agreement = stmts.getAgreementByOfferId.get(offerId);
        }
        return agreement;
      });

      let agreement = null;
      try {
        agreement = apply();
      } catch (e) {
        if (e && e.code === 'NOT_PENDING') {
          const fresh = stmts.getOfferById.get(offerId);
          return res.status(409).json({ error: 'Offer is no longer pending', status: fresh ? fresh.status : null });
        }
        throw e;
      }

      const updated = stmts.getOfferById.get(offerId);

      // Lark notify (relay primary, direct LARK_ALERT_CHAT_ID fallback). Both sides.
      const handle = String(c.creator_handle || '').replace(/^@/, '');
      const brandName = offer.brand_name || offer.brand_id;
      const dollars = (offer.amount_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const text = `${action === 'accept' ? '✅' : '❌'} Offer ${newStatus}: @${handle} ${action}ed ${brandName} ${dollars}`;
      let notified = false, via = null;
      try {
        const r = await icNotifyAlertChannel(text);
        notified = !!(r && r.notified);
        via = r && r.via;
      } catch (e) {
        console.error('[inner-circle-sqlite] respond notify threw:', e.message);
      }
      console.log(`[inner-circle-sqlite] offer #${offerId} ${newStatus} by @${handle} (notified: ${notified}${via ? ' via ' + via : ''})`);

      return res.json({
        ok: true,
        action: newStatus,
        offer: {
          id: updated.id,
          brandId: updated.brand_id,
          brandName: updated.brand_name,
          creatorId: updated.creator_id,
          offerType: updated.offer_type,
          amountCents: updated.amount_cents,
          videos: updated.videos,
          terms: updated.terms,
          status: updated.status,
          createdAt: updated.created_at,
          respondedAt: updated.responded_at || null,
        },
        agreement: agreement ? {
          id: agreement.id,
          offerId: agreement.offer_id,
          brandId: agreement.brand_id,
          creatorId: agreement.creator_id,
          amountCents: agreement.amount_cents,
          videosCommitted: agreement.videos_committed,
          status: agreement.status,
          createdAt: agreement.created_at,
        } : null,
        notified,
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] respond offer failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/my-agreements ──────────────────────────────────────
  // Creator-side: active + completed retainer agreements where the logged-in
  // creator is the counterparty. IDOR-safe: creator_id comes from the session
  // (req.icCreator.id), never params. Read-only; no payment data is exposed.
  app.get('/api/inner-circle/my-agreements', requireSqliteSession, (req, res) => {
    try {
      const c = req.icCreator;
      const rows = stmts.agreementsForCreator.all(c.id);
      const agreements = rows.map((a) => ({
        id: a.id,
        counterpartyName: a.o_brand_name || a.brand_id,
        amount: a.amount_cents,
        videosCommitted: a.videos_committed,
        videosDelivered: a.videos_delivered || 0,
        status: a.status,
      }));
      const active = agreements.filter((a) => a.status === 'active').length;
      return res.json({ ok: true, count: agreements.length, active, agreements });
    } catch (e) {
      console.error('[inner-circle-sqlite] my-agreements failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/inner-circle/agreements ─────────────────────────────────────────
  // Brand-side (client session → req.session.clientBrandId): every retainer
  // agreement for this brand. 401 if no client session. Read-only.
  app.get('/api/inner-circle/agreements', (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const rows = stmts.agreementsForBrand.all(String(clientBrandId));
      const agreements = rows.map((a) => ({
        id: a.id,
        counterpartyName: a.creator_name || a.creator_handle || ('creator#' + a.creator_id),
        amount: a.amount_cents,
        videosCommitted: a.videos_committed,
        videosDelivered: a.videos_delivered || 0,
        status: a.status,
      }));
      const active = agreements.filter((a) => a.status === 'active').length;
      return res.json({ ok: true, count: agreements.length, active, agreements });
    } catch (e) {
      console.error('[inner-circle-sqlite] agreements failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ���─ POST /api/inner-circle/agreements/:id/progress ───────────────────────────
  // Brand owner reports delivery progress. Body: {videosDelivered} — absolute
  // count (not an increment) of videos delivered so far. Guarded to the brand
  // that owns the agreement (client session → req.session.clientBrandId); later
  // admin may also be allowed. status auto-flips to 'completed' when delivered
  // >= committed. NO PAYMENT MOVEMENT — money is always escalated to a human.
  // 401 no session / 403 not your agreement / 404 unknown id.
  app.post('/api/inner-circle/agreements/:id/progress', express.json(), (req, res) => {
    if (dbError) return res.status(503).json({ error: 'IC database unavailable' });
    const clientBrandId = req.session && req.session.clientBrandId;
    if (!clientBrandId) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const agreementId = parseInt(req.params.id, 10);
      if (!Number.isFinite(agreementId)) return res.status(400).json({ error: 'Invalid agreement id' });

      const delivered = Number(req.body && req.body.videosDelivered);
      if (!Number.isInteger(delivered) || delivered < 0) {
        return res.status(400).json({ error: 'videosDelivered must be a non-negative integer' });
      }

      const agreement = stmts.getAgreementById.get(agreementId);
      if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
      // Ownership guard: the agreement must belong to THIS brand. 403 — exists
      // but not yours.
      if (String(agreement.brand_id) !== String(clientBrandId)) {
        return res.status(403).json({ error: 'This agreement does not belong to you' });
      }

      const info = stmts.setAgreementDelivered.run({
        id: agreementId,
        brand_id: String(clientBrandId),
        videos_delivered: delivered,
      });
      if (!info.changes) return res.status(404).json({ error: 'Agreement not found' });

      const updated = stmts.getAgreementById.get(agreementId);
      console.log('[inner-circle-sqlite] agreement #' + agreementId + ' progress ' + (updated.videos_delivered || 0) + '/' + updated.videos_committed + ' (' + updated.status + ')');

      return res.json({
        ok: true,
        agreement: {
          id: updated.id,
          counterpartyName: null,
          amount: updated.amount_cents,
          videosCommitted: updated.videos_committed,
          videosDelivered: updated.videos_delivered || 0,
          status: updated.status,
        },
      });
    } catch (e) {
      console.error('[inner-circle-sqlite] agreement progress failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  });


  // ── getIcFunnel(shopId) ──────────────────────────────────────────────────
  // Exported so dashboard-server.js's /api/inner-circle/admin/funnel and
  // /api/inner-circle/funnel routes can build the brand-scoped IC funnel.
  // shopId = the NUMERIC TikTok shop_id (e.g. 10021). We resolve it to the
  // brand slug (brand.id) via /data/brands.json, then call icCreatorRoster
  // with the dual-ID scope { membershipId: slug, shopId: numericShopId }.
  // Returns { summary, creators }. On a missing/unknown brand we still return
  // an empty-but-valid funnel (NOT an error) so the route renders cleanly.
  async function getIcFunnel(shopId) {
    if (dbError) return { error: 'IC database unavailable', summary: null, creators: [] };
    const numericShopId = shopId != null ? String(shopId) : null;
    if (!numericShopId) return { error: 'shopId required', summary: null, creators: [] };

    // Resolve numeric shopId -> brand slug from canonical brands.json.
    let slug = null, brandName = null;
    try {
      const data = icLoadBrandsFile();
      const rec = data && Array.isArray(data.clients)
        ? data.clients.find((c) => c && String(c.shopId) === numericShopId)
        : null;
      if (rec) { slug = rec.id; brandName = rec.name || rec.id; }
    } catch (_) { /* fall through to empty funnel */ }

    // If we can't map the shopId to a brand, return an empty valid funnel
    // rather than 503 — the brand may simply not be IC-enabled yet.
    if (!slug) {
      return {
        summary: { shopId: numericShopId, brand: null, creatorCount: 0, totalVideos: 0, totalGmv: 0, videosGoalSum: 0, progressPct: 0 },
        creators: [],
      };
    }

    let creators = [];
    try {
      creators = icCreatorRoster({ membershipId: slug, shopId: numericShopId }) || [];
    } catch (e) {
      return { error: e.message, summary: null, creators: [] };
    }

    let totalVideos = 0, totalGmv = 0, goalSum = 0;
    for (const c of creators) {
      totalVideos += (c.videos || 0);
      totalGmv += (c.gmv || 0);
      goalSum += (c.videosGoal || 20);
    }
    totalGmv = Math.round(totalGmv * 100) / 100;

    return {
      summary: {
        shopId: numericShopId,
        brand: brandName,
        slug,
        creatorCount: creators.length,
        totalVideos,
        totalGmv,
        videosGoalSum: goalSum,
        progressPct: goalSum > 0 ? Math.min(100, Math.round((totalVideos / goalSum) * 100)) : 0,
      },
      creators,
    };
  }


  // ── Cult Meetings recordings auto-sync ──────────────────────────────────────
  // Pulls ended Lark VC meetings, matches "<Brand> Weekly Creator Call" topics to
  // a brand (brands.json client), fetches the recording URL via the meeting
  // INSTANCE id (the recurring meeting_id 404s — recordings are keyed by
  // meeting_instance_id), and upserts into inner_circle_calls so the Cult
  // Meetings recordings library populates automatically. No manual entry.
  //
  // HONEST CONSTRAINT (2026-06-27): this app currently lacks the Lark `minutes`
  // scope, so it CANNOT make the recording links publicly viewable. Links play
  // for anyone in the Cult Content Lark org (and creators added to Lark). To make
  // them public for external creators, grant the app minutes + drive permission
  // scopes, then flip RECORDINGS_PUBLICIZE = true below — the share step is
  // already wired and will activate with zero further code changes.
  const RECORDINGS_PUBLICIZE = false;
  try {
    const _httpsRec = require('https');
    const _LARK_HOST = 'https://open.larksuite.com';

    function _larkTenantToken() {
      return new Promise((resolve) => {
        const body = JSON.stringify({
          app_id: process.env.LARK_APP_ID,
          app_secret: process.env.LARK_APP_SECRET,
        });
        const r = _httpsRec.request(
          _LARK_HOST + '/open-apis/auth/v3/tenant_access_token/internal',
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { resolve(JSON.parse(d).tenant_access_token); } catch (_) { resolve(null); } }); }
        );
        r.on('error', () => resolve(null));
        r.write(body); r.end();
      });
    }

    function _larkGet(token, p) {
      return new Promise((resolve) => {
        _httpsRec.get(_LARK_HOST + p, { headers: { Authorization: 'Bearer ' + token } }, (x) => {
          let d = ''; x.on('data', (c) => (d += c));
          x.on('end', () => { try { resolve({ status: x.statusCode, json: JSON.parse(d) }); } catch (_) { resolve({ status: x.statusCode, json: null }); } });
        }).on('error', () => resolve({ status: 0, json: null }));
      });
    }

    // Ensure the table exists (idempotent) so a fresh DB doesn't 500 on sync.
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS inner_circle_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          scheduled_at TEXT,
          recording_url TEXT,
          shop_id TEXT,
          brand_id TEXT,
          lark_meeting_url TEXT,
          lark_instance_id TEXT UNIQUE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      // Best-effort add of newer columns if table predates them.
      try { db.exec('ALTER TABLE inner_circle_calls ADD COLUMN lark_instance_id TEXT'); } catch (_) {}
      try { db.exec('ALTER TABLE inner_circle_calls ADD COLUMN brand_id TEXT'); } catch (_) {}
      try { db.exec('ALTER TABLE inner_circle_calls ADD COLUMN shop_id TEXT'); } catch (_) {}
    } catch (e) { console.warn('[ic-recordings] ensure table failed:', e.message); }

    function _brandForTopic(topic) {
      if (!topic) return null;
      const m = String(topic).match(/^(.*?)\s+weekly creator call\s*$/i);
      const brandName = m ? m[1].trim() : null;
      if (!brandName) return null;
      let clients = [];
      try { const bf = icLoadBrandsFile(); clients = (bf && bf.clients) || []; } catch (_) {}
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const c = clients.find((x) => x && norm(x.name) === norm(brandName));
      if (!c) return null;
      return { brandId: c.id, shopId: c.shopId != null ? String(c.shopId) : null, name: c.name };
    }

    async function _maybePublicize(token, recUrl) {
      if (!RECORDINGS_PUBLICIZE) return;
      const mt = String(recUrl).match(/minutes\/([A-Za-z0-9]+)/);
      if (!mt) return;
      const minToken = mt[1];
      await new Promise((resolve) => {
        const body = JSON.stringify({ link_share_entity: 'anyone_readable', external_access_entity: 'open' });
        const r = _httpsRec.request(
          _LARK_HOST + '/open-apis/drive/v2/permissions/' + minToken + '/public?type=minutes',
          { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } },
          (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => resolve()); }
        );
        r.on('error', () => resolve());
        r.write(body); r.end();
      });
    }

    async function syncCultMeetingRecordings(windowDays = 14) {
      if (dbError || !db) return { ok: false, error: 'IC database unavailable' };
      const token = await _larkTenantToken();
      if (!token) return { ok: false, error: 'lark token failed' };

      const now = Math.floor(Date.now() / 1000);
      const start = now - Math.max(1, windowDays) * 86400;
      const result = { ok: true, scanned: 0, matched: 0, withRecording: 0, upserted: 0, brands: {} };

      // Fetch matched creator-call recordings from the Sisyphus VC relay.
      // cult-command-center's Lark app lacks tenant-wide VC visibility, so its
      // own meeting_list returns 0 rows. The Sisyphus app (cli_a93c68c186f8c060)
      // has the vc:meeting scope and exposes /vc/creator-call-recordings.
      const RELAY_BASE = process.env.SISYPHUS_RELAY_BASE || 'https://sisyphus.cultcontent.cc';
      let recordings = [];
      let _axios;
      try { _axios = require('axios'); } catch (e) { return { ok:false, error:'axios unavailable' }; }
      try {
        const relayResp = await _axios.get(
          RELAY_BASE + '/vc/creator-call-recordings?days=' + Math.max(1, windowDays),
          { headers: { 'x-ic-admin-key': process.env.IC_ADMIN_KEY || '' }, timeout: 30000 }
        );
        recordings = (relayResp.data && relayResp.data.recordings) || [];
        result.scanned = (relayResp.data && relayResp.data.scanned) || recordings.length;
      } catch (e) {
        return { ok: false, error: 'vc relay failed: ' + (e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0,200) : e.message) };
      }

      for (const rd of recordings) {
        const topic = rd.topic || '';
        const brand = _brandForTopic(topic);
        if (!brand) continue;
        result.matched += 1;
        const inst = rd.instanceId;
        const url = rd.recordingUrl;
        if (!inst || !url) continue;
        result.withRecording += 1;
        const scheduledAt = rd.scheduledAt || new Date().toISOString();

        try {
          const existing = db.prepare('SELECT id FROM inner_circle_calls WHERE lark_instance_id = ?').get(String(inst));
          if (existing) {
            db.prepare('UPDATE inner_circle_calls SET recording_url = ?, title = ?, brand_id = ?, shop_id = ? WHERE lark_instance_id = ?')
              .run(url, topic, brand.brandId, brand.shopId, String(inst));
          } else {
            db.prepare('INSERT INTO inner_circle_calls (title, scheduled_at, recording_url, shop_id, brand_id, lark_meeting_url, lark_instance_id) VALUES (?,?,?,?,?,?,?)')
              .run(topic, scheduledAt, url, brand.shopId, brand.brandId, url, String(inst));
          }
          await _maybePublicize(token, url);
          result.upserted += 1;
          result.brands[brand.brandId] = (result.brands[brand.brandId] || 0) + 1;
        } catch (e) { console.warn('[ic-recordings] upsert failed:', e.message); }
      }

      console.log('[ic-recordings] sync done:', JSON.stringify(result));
      return result;
    }

    // Admin trigger (portal-admin session OR x-ic-admin-key header).
    app.post('/api/inner-circle/admin/sync-recordings', async (req, res) => {
      const keyOk = process.env.IC_ADMIN_KEY && req.headers['x-ic-admin-key'] === process.env.IC_ADMIN_KEY;
      const sessOk = req.session && req.session.isPortalAdmin;
      if (!keyOk && !sessOk) return res.status(401).json({ error: 'Not authorized' });
      const days = Number(req.query.days) || 14;
      try { const out = await syncCultMeetingRecordings(days); return res.json(out); }
      catch (e) { return res.status(500).json({ error: e.message }); }
    });

    // Daily self-scheduling sync (window is 14d so a weekly-or-better cadence
    // never drops a call). Fires once ~60s after boot, then every 24h.
    const _RUN_SYNC = () => { syncCultMeetingRecordings(14).catch((e) => console.warn('[ic-recordings] scheduled sync error:', e.message)); };
    setTimeout(_RUN_SYNC, 60 * 1000);
    setInterval(_RUN_SYNC, 24 * 60 * 60 * 1000);
  } catch (recErr) {
    console.warn('[ic-recordings] init failed (non-fatal):', recErr.message);
  }


  // Expose the working session middleware so other routes can adopt it later.
  return { requireSqliteSession, getIcFunnel };
};
