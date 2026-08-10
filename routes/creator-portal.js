/**
 * routes/creator-portal.js — creator-facing API surface (Phase 6 of the
 * platform rebuild). Backs the real Creator portal UI (replacing the
 * Phase 4 placeholder): stats/profile, the three brand tabs (My Brands /
 * New Brands / Previous Contracts), and the creator-scoped Financial
 * Dashboard tab.
 *
 * Auth: requireSqliteSession (creator-only — this data is never shared
 * across audiences the way messaging/proposals are, so the plain creator
 * guard is simpler and more consistent with the rest of Inner Circle than
 * requireAnyIdentity would be). Injected the same way
 * routes/inner-circle-covenant.js receives it: from icSqlite.requireSqliteSession.
 *
 * Adds two optional profile columns (discord_username, sms_opt_in) via the
 * same idempotent ALTER TABLE pattern routes/inner-circle-sqlite.js already
 * uses for `phone`/`password_hash` — colocated here with the feature that
 * uses them rather than in db/inner-circle.js's core schema.
 *
 * Mount (before app.use(requireAuth) — creators have no CF Access session):
 *   require('./routes/creator-portal')(app, {
 *     requireSqliteSession, loadBrands, getActiveDiscordServers, recordDiscordInvite,
 *   });
 */

const express = require('express');
const { db } = require('../db/inner-circle');
const prop = require('../db/proposals');

// Idempotent — safe to run on every boot, matches the existing convention.
try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN discord_username TEXT`); } catch (_) { /* column exists */ }
try { db.exec(`ALTER TABLE inner_circle_creators ADD COLUMN sms_opt_in INTEGER NOT NULL DEFAULT 0`); } catch (_) { /* column exists */ }

const getCreatorStmt = db.prepare(`SELECT * FROM inner_circle_creators WHERE id = ?`);
const updateProfileStmt = db.prepare(`
  UPDATE inner_circle_creators SET discord_username = ?, sms_opt_in = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
`);
const getRateStmt = db.prepare(`SELECT * FROM creator_rates WHERE creator_id = ?`);
const getRetainerAgreementsStmt = db.prepare(`SELECT * FROM retainer_agreements WHERE creator_id = ? ORDER BY created_at DESC`);
const getRetainerOffersStmt = db.prepare(`SELECT * FROM retainer_offers WHERE creator_id = ? ORDER BY created_at DESC`);

function brandSummary(brand) {
  if (!brand) return null;
  return { id: brand.id, name: brand.name || null, website: brand.website || null, tiktokHandle: brand.tiktokHandle || null };
}

module.exports = function mountCreatorPortal(app, deps = {}) {
  const requireSqliteSession = deps.requireSqliteSession;
  const loadBrands = deps.loadBrands;
  const getActiveDiscordServers = deps.getActiveDiscordServers || (() => []);
  const recordDiscordInvite = deps.recordDiscordInvite || (() => {});
  if (!requireSqliteSession) throw new Error('[creator-portal] requireSqliteSession dep is required');
  if (!loadBrands) throw new Error('[creator-portal] loadBrands dep is required');

  // GET /api/creator/profile
  app.get('/api/creator/profile', requireSqliteSession, (req, res) => {
    try {
      const creator = getCreatorStmt.get(req.icCreator.id);
      if (!creator) return res.status(404).json({ ok: false, error: 'Creator not found' });
      res.json({
        ok: true,
        profile: {
          id: creator.id,
          email: creator.email,
          handle: creator.creator_handle,
          name: creator.creator_name,
          discordUsername: creator.discord_username || null,
          smsOptIn: !!creator.sms_opt_in,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // PATCH /api/creator/profile — Body: { discordUsername?, smsOptIn? }. Both optional
  // per spec (email + handle are already required at signup, not editable here).
  app.patch('/api/creator/profile', requireSqliteSession, express.json(), (req, res) => {
    try {
      const creator = getCreatorStmt.get(req.icCreator.id);
      if (!creator) return res.status(404).json({ ok: false, error: 'Creator not found' });

      const { discordUsername, smsOptIn } = req.body || {};
      const nextDiscord = discordUsername !== undefined ? (String(discordUsername).trim() || null) : creator.discord_username;
      const nextSmsOptIn = smsOptIn !== undefined ? (smsOptIn ? 1 : 0) : creator.sms_opt_in;
      updateProfileStmt.run(nextDiscord, nextSmsOptIn, creator.id);

      // Newly set (or changed) Discord username -> invite to every active server.
      // Fire-and-forget in spirit: recording the invite attempt never fails the
      // profile update itself (the actual bot invite call is a later, portal-
      // facing wiring pass — this just tracks intent per db/discord.js's design).
      if (nextDiscord && nextDiscord !== creator.discord_username) {
        try {
          for (const server of getActiveDiscordServers()) {
            recordDiscordInvite(creator.id, 'creator', server.guild_id, nextDiscord);
          }
        } catch (e) {
          console.error('[creator-portal] discord invite recording failed:', e.message);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/creator/brands — the three-tab data source.
  app.get('/api/creator/brands', requireSqliteSession, (req, res) => {
    try {
      const creatorId = String(req.icCreator.id);
      const allBrands = (loadBrands().clients || []);
      const brandById = new Map(allBrands.map((b) => [String(b.id), b]));

      const contracts = prop.getContractsForParty('creator', creatorId);
      const activeByBrand = new Map();   // brandId -> contract
      const everBrandIds = new Set();
      for (const c of contracts) {
        everBrandIds.add(c.brand_id);
        if (!c.ended_at) activeByBrand.set(c.brand_id, c);
      }

      // Previous = brand ids that have contract history but no CURRENTLY active one.
      const previousBrandIds = [...everBrandIds].filter((id) => !activeByBrand.has(id));

      const myBrands = [...activeByBrand.entries()].map(([brandId, contract]) => ({
        brand: brandSummary(brandById.get(brandId)) || { id: brandId, name: null, website: null },
        contract,
      }));
      const previousBrands = previousBrandIds.map((brandId) => ({
        brand: brandSummary(brandById.get(brandId)) || { id: brandId, name: null, website: null },
        contractCount: contracts.filter((c) => c.brand_id === brandId).length,
      }));
      const newBrands = allBrands
        .filter((b) => !everBrandIds.has(String(b.id)))
        .map((b) => ({ brand: brandSummary(b) }));

      res.json({ ok: true, myBrands, newBrands, previousBrands });
    } catch (e) {
      console.error('[creator-portal] get brands failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/creator/financial-summary — creator-scoped rates + retainer
  // agreements/offers. TikTok Shop commission data is a fast-follow once
  // brand-side TikTok Shop tooling + creator-shop linking exists (per the plan) —
  // this ships first against what already exists.
  app.get('/api/creator/financial-summary', requireSqliteSession, (req, res) => {
    try {
      const creatorId = req.icCreator.id;
      res.json({
        ok: true,
        rate: getRateStmt.get(creatorId) || null,
        retainerAgreements: getRetainerAgreementsStmt.all(creatorId),
        retainerOffers: getRetainerOffersStmt.all(creatorId),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
